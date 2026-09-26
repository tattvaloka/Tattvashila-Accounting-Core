import { eq, and, sql } from 'drizzle-orm';
import { sales, saleItems, saleReturns, saleReturnItems, productVariants, products, organizations, customers } from '@platform/db';
import type { Tx } from './accounts';
import { ACCOUNT_CODES } from './accounts';
import { AccountingError } from './errors';
import { postJournal } from './postJournal';
import { postStockMovement } from './stock';
import { resolveTaxRate, calculateLineTax } from './tax';
import { financialYearFor, nextInvoiceNumber } from './invoiceNumbering';
import { toPaise, paiseToAmount } from './money';

/**
 * Design decision (documented here since it isn't in the reviewed schema
 * doc): confirmSale always posts the full grand total to Accounts
 * Receivable, regardless of payment_mode. A cash/UPI sale is then just an
 * immediate recordPayment() call against that same sale — not a special
 * code path here. This keeps confirmSale's posting shape identical no
 * matter how the customer pays, and gives 'split' payment_mode nowhere
 * ambiguous to live. payment_mode on the sale header is informational only
 * from here on; the ledger truth is always AR-in, then payments reduce it.
 */
export interface ConfirmSaleInput {
  organizationId: string;
  saleId: string;
  confirmedByOrgUserId: string;
}

export interface ConfirmSaleResult {
  invoiceNumber: string;
  grandTotal: string;
}

export async function confirmSale(tx: Tx, input: ConfirmSaleInput): Promise<ConfirmSaleResult> {
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, input.organizationId));
  if (!org) throw new AccountingError('Organization not found.', 'NOT_FOUND');

  const [sale] = await tx
    .select()
    .from(sales)
    .where(and(eq(sales.id, input.saleId), eq(sales.organizationId, input.organizationId)))
    .for('update');
  if (!sale) throw new AccountingError('Sale not found for this organization.', 'NOT_FOUND');
  if (sale.status !== 'draft') {
    throw new AccountingError(`Cannot confirm a sale in status '${sale.status}'.`, 'INVALID_STATUS');
  }

  const items = await tx.select().from(saleItems).where(eq(saleItems.saleId, sale.id));
  if (items.length === 0) {
    throw new AccountingError('Cannot confirm a sale with no line items.', 'EMPTY_SALE');
  }

  const [customer] = await tx.select().from(customers).where(eq(customers.id, sale.customerId));
  if (!customer) throw new AccountingError('Customer not found.', 'NOT_FOUND');
  // GST inter-state determination: the schema doesn't carry an explicit
  // state code for customers (only an optional GSTIN), so this is derived
  // from the GSTIN's first two digits when present. A customer with no
  // GSTIN is treated as intra-state. This is a real limitation worth
  // revisiting if unregistered inter-state wholesale customers turn out to
  // be common for Famous Footwears — flagging it rather than hiding it.
  const isInterState = customer.gstin ? customer.gstin.slice(0, 2) !== org.stateCode : false;

  let subtotalPaise = 0;
  let discountPaise = 0;
  let taxablePaise = 0;
  let cgstPaise = 0;
  let sgstPaise = 0;
  let igstPaise = 0;
  let cogsPaise = 0;

  for (const item of items) {
    const [variantRow] = await tx
      .select({ hsnCode: products.hsnCode, purchasePrice: products.purchasePrice })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(eq(productVariants.id, item.productVariantId));
    if (!variantRow?.hsnCode) {
      throw new AccountingError(
        `Product for line item ${item.id} has no HSN code — required to resolve a tax rate.`,
        'MISSING_HSN',
      );
    }

    const taxRate = await resolveTaxRate(tx, input.organizationId, variantRow.hsnCode, sale.saleDate);
    const calc = calculateLineTax({
      quantity: item.quantity,
      rate: item.rate,
      discountAmount: item.discountAmount,
      taxRate,
      isInterState,
    });

    // Perpetual inventory: COGS for this line is quantity x the product's
    // *current* purchase_price (a standard-cost simplification — not
    // FIFO/weighted-average lot costing, which would need per-lot cost
    // tracking the schema doesn't have). Frozen onto the line now so a
    // later return reverses this exact figure, not whatever the product's
    // price happens to be at return time.
    const lineCogsPaise = item.quantity * toPaise(variantRow.purchasePrice);

    await tx
      .update(saleItems)
      .set({
        taxRateId: taxRate.id,
        taxableValue: calc.taxableValue,
        cgstAmount: calc.cgstAmount,
        sgstAmount: calc.sgstAmount,
        igstAmount: calc.igstAmount,
        lineTotal: calc.lineTotal,
        cogsAmount: paiseToAmount(lineCogsPaise),
      })
      .where(eq(saleItems.id, item.id));

    subtotalPaise += toPaise(item.rate) * item.quantity;
    discountPaise += toPaise(item.discountAmount);
    taxablePaise += toPaise(calc.taxableValue);
    cgstPaise += toPaise(calc.cgstAmount);
    sgstPaise += toPaise(calc.sgstAmount);
    igstPaise += toPaise(calc.igstAmount);
    cogsPaise += lineCogsPaise;

    // Guarded/atomic against negative stock and concurrent sales — see
    // stock.ts. Throws INSUFFICIENT_STOCK if this line can't be fulfilled,
    // which aborts this whole function and rolls back everything posted so
    // far in the same transaction (no partial stock/ledger mutation).
    await postStockMovement(tx, {
      organizationId: input.organizationId,
      productVariantId: item.productVariantId,
      movementType: 'sale',
      quantity: -item.quantity,
      referenceType: 'sale',
      referenceId: sale.id,
      movementDate: sale.saleDate,
    });
  }

  const grandTotalPaise = taxablePaise + cgstPaise + sgstPaise + igstPaise;
  const financialYear = financialYearFor(sale.saleDate, org.financialYearStartMonth);
  const invoiceNumber = await nextInvoiceNumber(tx, input.organizationId, 'sale', financialYear, org.invoicePrefix);

  // One balanced posting covering both sides of the transaction: revenue
  // recognition (Dr AR / Cr Sales / Cr Output GST) and inventory relief
  // (Dr COGS / Cr Inventory) together, dated and referenced identically so
  // they can never be confirmed as two separate, potentially-inconsistent
  // postings.
  await postJournal(tx, {
    organizationId: input.organizationId,
    entryDate: sale.saleDate,
    referenceType: 'sale',
    referenceId: sale.id,
    lines: [
      {
        accountCode: ACCOUNT_CODES.ACCOUNTS_RECEIVABLE,
        debit: paiseToAmount(grandTotalPaise),
        customerId: sale.customerId,
        description: `Sale ${invoiceNumber}`,
      },
      { accountCode: ACCOUNT_CODES.SALES, credit: paiseToAmount(taxablePaise), description: `Sale ${invoiceNumber}` },
      ...(cgstPaise > 0 ? [{ accountCode: ACCOUNT_CODES.OUTPUT_CGST, credit: paiseToAmount(cgstPaise) }] : []),
      ...(sgstPaise > 0 ? [{ accountCode: ACCOUNT_CODES.OUTPUT_SGST, credit: paiseToAmount(sgstPaise) }] : []),
      ...(igstPaise > 0 ? [{ accountCode: ACCOUNT_CODES.OUTPUT_IGST, credit: paiseToAmount(igstPaise) }] : []),
      ...(cogsPaise > 0
        ? [
            { accountCode: ACCOUNT_CODES.COGS, debit: paiseToAmount(cogsPaise), description: `COGS for ${invoiceNumber}` },
            { accountCode: ACCOUNT_CODES.INVENTORY, credit: paiseToAmount(cogsPaise) },
          ]
        : []),
    ],
  });

  await tx
    .update(sales)
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
    .where(eq(sales.id, sale.id));

  return { invoiceNumber, grandTotal: paiseToAmount(grandTotalPaise) };
}

export interface SaleReturnLineInput {
  saleItemId: string;
  quantity: number;
}

export interface CreateSaleReturnInput {
  organizationId: string;
  saleId: string;
  lines: SaleReturnLineInput[];
  reason?: string;
  createdByOrgUserId: string;
}

/**
 * Posts a sale return per the approved Return Accounting Flow: stock goes
 * back up, and the ledger effect is the mirror image of the original sale,
 * scaled to the returned amount — the original sale's rows are never
 * touched. Does not generate a refund; if cash needs to go back to the
 * customer, that's a separate recordPayment() call with direction 'out'.
 */
export async function createSaleReturn(tx: Tx, input: CreateSaleReturnInput) {
  const [sale] = await tx
    .select()
    .from(sales)
    .where(and(eq(sales.id, input.saleId), eq(sales.organizationId, input.organizationId)));
  if (!sale) throw new AccountingError('Sale not found for this organization.', 'NOT_FOUND');
  if (sale.status !== 'confirmed') {
    throw new AccountingError('Only a confirmed sale can be returned.', 'INVALID_STATUS');
  }
  if (input.lines.length === 0) {
    throw new AccountingError('A return must have at least one line.', 'EMPTY_RETURN');
  }

  let taxablePaise = 0;
  let cgstPaise = 0;
  let sgstPaise = 0;
  let igstPaise = 0;
  let totalPaise = 0;
  let cogsPaise = 0;
  const stockUpdates: Array<{ productVariantId: string; quantity: number }> = [];
  const returnItemRows: Array<{ saleItemId: string; quantity: number; amount: string }> = [];

  for (const line of input.lines) {
    const [item] = await tx
      .select()
      .from(saleItems)
      .where(and(eq(saleItems.id, line.saleItemId), eq(saleItems.saleId, sale.id)));
    if (!item) {
      throw new AccountingError(`Sale item ${line.saleItemId} does not belong to this sale.`, 'NOT_FOUND');
    }
    if (line.quantity <= 0) {
      throw new AccountingError('Return quantity must be positive.', 'INVALID_QUANTITY');
    }

    const [{ alreadyReturned }] = await tx
      .select({ alreadyReturned: sql<number>`coalesce(sum(${saleReturnItems.quantity}), 0)::int` })
      .from(saleReturnItems)
      .where(eq(saleReturnItems.saleItemId, item.id));
    if (alreadyReturned + line.quantity > item.quantity) {
      throw new AccountingError(
        `Cannot return ${line.quantity} of item ${item.id} — only ${item.quantity - alreadyReturned} remain returnable.`,
        'OVER_RETURN',
      );
    }

    // Proportional to the original line's already-computed, posted figures
    // — never recomputed from a (possibly since-changed) tax rate or price.
    const fraction = line.quantity / item.quantity;
    const lineTaxable = Math.round(toPaise(item.taxableValue) * fraction);
    const lineCgst = Math.round(toPaise(item.cgstAmount) * fraction);
    const lineSgst = Math.round(toPaise(item.sgstAmount) * fraction);
    const lineIgst = Math.round(toPaise(item.igstAmount) * fraction);
    const lineCogs = Math.round(toPaise(item.cogsAmount) * fraction);
    const lineTotal = lineTaxable + lineCgst + lineSgst + lineIgst;

    taxablePaise += lineTaxable;
    cgstPaise += lineCgst;
    sgstPaise += lineSgst;
    igstPaise += lineIgst;
    totalPaise += lineTotal;
    cogsPaise += lineCogs;

    stockUpdates.push({ productVariantId: item.productVariantId, quantity: line.quantity });
    returnItemRows.push({ saleItemId: item.id, quantity: line.quantity, amount: paiseToAmount(lineTotal) });
  }

  const [org] = await tx.select().from(organizations).where(eq(organizations.id, input.organizationId));
  const financialYear = financialYearFor(sale.saleDate, org.financialYearStartMonth);
  const returnNumber = await nextInvoiceNumber(tx, input.organizationId, 'sale_return', financialYear);
  const returnDate = new Date().toISOString().slice(0, 10);

  const [saleReturn] = await tx
    .insert(saleReturns)
    .values({
      organizationId: input.organizationId,
      saleId: sale.id,
      returnNumber,
      returnDate,
      reason: input.reason,
      totalAmount: paiseToAmount(totalPaise),
      createdBy: input.createdByOrgUserId,
    })
    .returning();

  await tx.insert(saleReturnItems).values(
    returnItemRows.map((r) => ({
      organizationId: input.organizationId,
      saleReturnId: saleReturn.id,
      saleItemId: r.saleItemId,
      quantity: r.quantity,
      amount: r.amount,
    })),
  );

  for (const s of stockUpdates) {
    await postStockMovement(tx, {
      organizationId: input.organizationId,
      productVariantId: s.productVariantId,
      movementType: 'sale_return',
      quantity: s.quantity,
      referenceType: 'sale_return',
      referenceId: saleReturn.id,
      movementDate: returnDate,
    });
  }

  await postJournal(tx, {
    organizationId: input.organizationId,
    entryDate: returnDate,
    referenceType: 'sale_return',
    referenceId: saleReturn.id,
    lines: [
      { accountCode: ACCOUNT_CODES.SALES, debit: paiseToAmount(taxablePaise), description: `Return ${returnNumber}` },
      ...(cgstPaise > 0 ? [{ accountCode: ACCOUNT_CODES.OUTPUT_CGST, debit: paiseToAmount(cgstPaise) }] : []),
      ...(sgstPaise > 0 ? [{ accountCode: ACCOUNT_CODES.OUTPUT_SGST, debit: paiseToAmount(sgstPaise) }] : []),
      ...(igstPaise > 0 ? [{ accountCode: ACCOUNT_CODES.OUTPUT_IGST, debit: paiseToAmount(igstPaise) }] : []),
      {
        accountCode: ACCOUNT_CODES.ACCOUNTS_RECEIVABLE,
        credit: paiseToAmount(totalPaise),
        customerId: sale.customerId,
        description: `Return ${returnNumber}`,
      },
      // COGS reversal: the goods are back on the shelf, so their cost comes
      // back out of COGS and back into Inventory — using the exact figure
      // frozen on the line at Confirm time, not today's purchase_price.
      ...(cogsPaise > 0
        ? [
            { accountCode: ACCOUNT_CODES.INVENTORY, debit: paiseToAmount(cogsPaise), description: `Return ${returnNumber}` },
            { accountCode: ACCOUNT_CODES.COGS, credit: paiseToAmount(cogsPaise) },
          ]
        : []),
    ],
  });

  return { returnNumber, totalAmount: paiseToAmount(totalPaise) };
}
