import { eq, and, sql } from 'drizzle-orm';
import {
  purchases,
  purchaseItems,
  purchaseReturns,
  purchaseReturnItems,
  productVariants,
  products,
  organizations,
  suppliers,
} from '@platform/db';
import type { Tx } from './accounts';
import { ACCOUNT_CODES } from './accounts';
import { AccountingError } from './errors';
import { postJournal } from './postJournal';
import { postStockMovement } from './stock';
import { resolveTaxRate, calculateLineTax } from './tax';
import { financialYearFor, nextInvoiceNumber } from './invoiceNumbering';
import { toPaise, paiseToAmount } from './money';

/** Mirrors confirmSale's design decision: confirmPurchase always posts the
 * full grand total to Accounts Payable; paying the supplier immediately is
 * a separate recordPayment() call, not a branch in here. */
export interface ConfirmPurchaseInput {
  organizationId: string;
  purchaseId: string;
  confirmedByOrgUserId: string;
}

export interface ConfirmPurchaseResult {
  invoiceNumber: string;
  grandTotal: string;
}

export async function confirmPurchase(tx: Tx, input: ConfirmPurchaseInput): Promise<ConfirmPurchaseResult> {
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, input.organizationId));
  if (!org) throw new AccountingError('Organization not found.', 'NOT_FOUND');

  const [purchase] = await tx
    .select()
    .from(purchases)
    .where(and(eq(purchases.id, input.purchaseId), eq(purchases.organizationId, input.organizationId)))
    .for('update');
  if (!purchase) throw new AccountingError('Purchase not found for this organization.', 'NOT_FOUND');
  if (purchase.status !== 'draft') {
    throw new AccountingError(`Cannot confirm a purchase in status '${purchase.status}'.`, 'INVALID_STATUS');
  }

  const items = await tx.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, purchase.id));
  if (items.length === 0) {
    throw new AccountingError('Cannot confirm a purchase with no line items.', 'EMPTY_PURCHASE');
  }

  const [supplier] = await tx.select().from(suppliers).where(eq(suppliers.id, purchase.supplierId));
  if (!supplier) throw new AccountingError('Supplier not found.', 'NOT_FOUND');
  const isInterState = supplier.gstin ? supplier.gstin.slice(0, 2) !== org.stateCode : false;

  let subtotalPaise = 0;
  let discountPaise = 0;
  let taxablePaise = 0;
  let cgstPaise = 0;
  let sgstPaise = 0;
  let igstPaise = 0;

  for (const item of items) {
    const [variantRow] = await tx
      .select({ hsnCode: products.hsnCode })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(eq(productVariants.id, item.productVariantId));
    if (!variantRow?.hsnCode) {
      throw new AccountingError(
        `Product for line item ${item.id} has no HSN code — required to resolve a tax rate.`,
        'MISSING_HSN',
      );
    }

    const taxRate = await resolveTaxRate(tx, input.organizationId, variantRow.hsnCode, purchase.purchaseDate);
    const calc = calculateLineTax({
      quantity: item.quantity,
      rate: item.rate,
      discountAmount: item.discountAmount,
      taxRate,
      isInterState,
    });

    await tx
      .update(purchaseItems)
      .set({
        taxRateId: taxRate.id,
        taxableValue: calc.taxableValue,
        cgstAmount: calc.cgstAmount,
        sgstAmount: calc.sgstAmount,
        igstAmount: calc.igstAmount,
        lineTotal: calc.lineTotal,
      })
      .where(eq(purchaseItems.id, item.id));

    subtotalPaise += toPaise(item.rate) * item.quantity;
    discountPaise += toPaise(item.discountAmount);
    taxablePaise += toPaise(calc.taxableValue);
    cgstPaise += toPaise(calc.cgstAmount);
    sgstPaise += toPaise(calc.sgstAmount);
    igstPaise += toPaise(calc.igstAmount);

    await postStockMovement(tx, {
      organizationId: input.organizationId,
      productVariantId: item.productVariantId,
      movementType: 'purchase',
      quantity: item.quantity,
      referenceType: 'purchase',
      referenceId: purchase.id,
      movementDate: purchase.purchaseDate,
    });
  }

  const grandTotalPaise = taxablePaise + cgstPaise + sgstPaise + igstPaise;
  const financialYear = financialYearFor(purchase.purchaseDate, org.financialYearStartMonth);
  const invoiceNumber = await nextInvoiceNumber(tx, input.organizationId, 'purchase', financialYear, org.invoicePrefix);

  await postJournal(tx, {
    organizationId: input.organizationId,
    entryDate: purchase.purchaseDate,
    referenceType: 'purchase',
    referenceId: purchase.id,
    lines: [
      { accountCode: ACCOUNT_CODES.PURCHASES, debit: paiseToAmount(taxablePaise), description: `Purchase ${invoiceNumber}` },
      ...(cgstPaise > 0 ? [{ accountCode: ACCOUNT_CODES.CGST_PAYABLE, debit: paiseToAmount(cgstPaise) }] : []),
      ...(sgstPaise > 0 ? [{ accountCode: ACCOUNT_CODES.SGST_PAYABLE, debit: paiseToAmount(sgstPaise) }] : []),
      ...(igstPaise > 0 ? [{ accountCode: ACCOUNT_CODES.IGST_PAYABLE, debit: paiseToAmount(igstPaise) }] : []),
      {
        accountCode: ACCOUNT_CODES.ACCOUNTS_PAYABLE,
        credit: paiseToAmount(grandTotalPaise),
        supplierId: purchase.supplierId,
        description: `Purchase ${invoiceNumber}`,
      },
    ],
  });

  await tx
    .update(purchases)
    .set({
      status: 'confirmed',
      invoiceNumber,
      subtotal: paiseToAmount(subtotalPaise),
      discountTotal: paiseToAmount(discountPaise),
      taxableTotal: paiseToAmount(taxablePaise),
      cgstTotal: paiseToAmount(cgstPaise),
      sgstTotal: paiseToAmount(sgstPaise),
      igstTotal: paiseToAmount(igstPaise),
      roundingAdjustment: '0.00',
      grandTotal: paiseToAmount(grandTotalPaise),
      confirmedAt: new Date(),
      confirmedBy: input.confirmedByOrgUserId,
    })
    .where(eq(purchases.id, purchase.id));

  return { invoiceNumber, grandTotal: paiseToAmount(grandTotalPaise) };
}

export interface PurchaseReturnLineInput {
  purchaseItemId: string;
  quantity: number;
}

export interface CreatePurchaseReturnInput {
  organizationId: string;
  purchaseId: string;
  lines: PurchaseReturnLineInput[];
  reason?: string;
  createdByOrgUserId: string;
}

/** Mirrors createSaleReturn: stock goes down (goods leaving back to the
 * supplier), and the ledger effect reduces Accounts Payable. */
export async function createPurchaseReturn(tx: Tx, input: CreatePurchaseReturnInput) {
  const [purchase] = await tx
    .select()
    .from(purchases)
    .where(and(eq(purchases.id, input.purchaseId), eq(purchases.organizationId, input.organizationId)));
  if (!purchase) throw new AccountingError('Purchase not found for this organization.', 'NOT_FOUND');
  if (purchase.status !== 'confirmed') {
    throw new AccountingError('Only a confirmed purchase can be returned.', 'INVALID_STATUS');
  }
  if (input.lines.length === 0) {
    throw new AccountingError('A return must have at least one line.', 'EMPTY_RETURN');
  }

  let taxablePaise = 0;
  let cgstPaise = 0;
  let sgstPaise = 0;
  let igstPaise = 0;
  let totalPaise = 0;
  const stockUpdates: Array<{ productVariantId: string; quantity: number }> = [];
  const returnItemRows: Array<{ purchaseItemId: string; quantity: number; amount: string }> = [];

  for (const line of input.lines) {
    const [item] = await tx
      .select()
      .from(purchaseItems)
      .where(and(eq(purchaseItems.id, line.purchaseItemId), eq(purchaseItems.purchaseId, purchase.id)));
    if (!item) {
      throw new AccountingError(`Purchase item ${line.purchaseItemId} does not belong to this purchase.`, 'NOT_FOUND');
    }
    if (line.quantity <= 0) {
      throw new AccountingError('Return quantity must be positive.', 'INVALID_QUANTITY');
    }

    const [{ alreadyReturned }] = await tx
      .select({ alreadyReturned: sql<number>`coalesce(sum(${purchaseReturnItems.quantity}), 0)::int` })
      .from(purchaseReturnItems)
      .where(eq(purchaseReturnItems.purchaseItemId, item.id));
    if (alreadyReturned + line.quantity > item.quantity) {
      throw new AccountingError(
        `Cannot return ${line.quantity} of item ${item.id} — only ${item.quantity - alreadyReturned} remain returnable.`,
        'OVER_RETURN',
      );
    }

    const fraction = line.quantity / item.quantity;
    const lineTaxable = Math.round(toPaise(item.taxableValue) * fraction);
    const lineCgst = Math.round(toPaise(item.cgstAmount) * fraction);
    const lineSgst = Math.round(toPaise(item.sgstAmount) * fraction);
    const lineIgst = Math.round(toPaise(item.igstAmount) * fraction);
    const lineTotal = lineTaxable + lineCgst + lineSgst + lineIgst;

    taxablePaise += lineTaxable;
    cgstPaise += lineCgst;
    sgstPaise += lineSgst;
    igstPaise += lineIgst;
    totalPaise += lineTotal;

    stockUpdates.push({ productVariantId: item.productVariantId, quantity: line.quantity });
    returnItemRows.push({ purchaseItemId: item.id, quantity: line.quantity, amount: paiseToAmount(lineTotal) });
  }

  const [org] = await tx.select().from(organizations).where(eq(organizations.id, input.organizationId));
  const financialYear = financialYearFor(purchase.purchaseDate, org.financialYearStartMonth);
  const returnNumber = await nextInvoiceNumber(tx, input.organizationId, 'purchase_return', financialYear);
  const returnDate = new Date().toISOString().slice(0, 10);

  const [purchaseReturn] = await tx
    .insert(purchaseReturns)
    .values({
      organizationId: input.organizationId,
      purchaseId: purchase.id,
      returnNumber,
      returnDate,
      reason: input.reason,
      totalAmount: paiseToAmount(totalPaise),
      createdBy: input.createdByOrgUserId,
    })
    .returning();

  await tx.insert(purchaseReturnItems).values(
    returnItemRows.map((r) => ({
      organizationId: input.organizationId,
      purchaseReturnId: purchaseReturn.id,
      purchaseItemId: r.purchaseItemId,
      quantity: r.quantity,
      amount: r.amount,
    })),
  );

  for (const s of stockUpdates) {
    await postStockMovement(tx, {
      organizationId: input.organizationId,
      productVariantId: s.productVariantId,
      movementType: 'purchase_return',
      quantity: -s.quantity,
      referenceType: 'purchase_return',
      referenceId: purchaseReturn.id,
      movementDate: returnDate,
    });
  }

  await postJournal(tx, {
    organizationId: input.organizationId,
    entryDate: returnDate,
    referenceType: 'purchase_return',
    referenceId: purchaseReturn.id,
    lines: [
      {
        accountCode: ACCOUNT_CODES.ACCOUNTS_PAYABLE,
        debit: paiseToAmount(totalPaise),
        supplierId: purchase.supplierId,
        description: `Return ${returnNumber}`,
      },
      { accountCode: ACCOUNT_CODES.PURCHASES, credit: paiseToAmount(taxablePaise), description: `Return ${returnNumber}` },
      ...(cgstPaise > 0 ? [{ accountCode: ACCOUNT_CODES.CGST_PAYABLE, credit: paiseToAmount(cgstPaise) }] : []),
      ...(sgstPaise > 0 ? [{ accountCode: ACCOUNT_CODES.SGST_PAYABLE, credit: paiseToAmount(sgstPaise) }] : []),
      ...(igstPaise > 0 ? [{ accountCode: ACCOUNT_CODES.IGST_PAYABLE, credit: paiseToAmount(igstPaise) }] : []),
    ],
  });

  return { returnNumber, totalAmount: paiseToAmount(totalPaise) };
}
