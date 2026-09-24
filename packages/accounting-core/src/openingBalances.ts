import { eq } from 'drizzle-orm';
import { customers, suppliers, productVariants } from '@platform/db';
import type { Tx } from './accounts';
import { ACCOUNT_CODES } from './accounts';
import { AccountingError } from './errors';
import { postJournal } from './postJournal';
import { postStockMovement } from './stock';
import { isZero } from './money';

/**
 * Posts a customer's opening_balance_input as a real ledger entry:
 * Dr Accounts Receivable [customer] / Cr Opening Balance Equity.
 * Call once, right after inserting the customer row, inside the same
 * transaction. opening_balance_input itself is never read again after
 * this — the customer's outstanding balance is always derived from
 * ledger_entries from this point on.
 */
export async function postCustomerOpeningBalance(tx: Tx, organizationId: string, customerId: string, asOfDate: string) {
  const [customer] = await tx.select().from(customers).where(eq(customers.id, customerId));
  if (!customer) throw new AccountingError('Customer not found.', 'NOT_FOUND');
  if (!customer.openingBalanceInput || isZero(customer.openingBalanceInput)) return;

  await postJournal(tx, {
    organizationId,
    entryDate: asOfDate,
    referenceType: 'opening_balance',
    referenceId: customer.id,
    lines: [
      {
        accountCode: ACCOUNT_CODES.ACCOUNTS_RECEIVABLE,
        debit: customer.openingBalanceInput,
        customerId: customer.id,
        description: 'Opening balance',
      },
      { accountCode: ACCOUNT_CODES.OPENING_BALANCE_EQUITY, credit: customer.openingBalanceInput },
    ],
  });
}

/** Mirrors postCustomerOpeningBalance: Dr Opening Balance Equity / Cr
 * Accounts Payable [supplier]. */
export async function postSupplierOpeningBalance(tx: Tx, organizationId: string, supplierId: string, asOfDate: string) {
  const [supplier] = await tx.select().from(suppliers).where(eq(suppliers.id, supplierId));
  if (!supplier) throw new AccountingError('Supplier not found.', 'NOT_FOUND');
  if (!supplier.openingBalanceInput || isZero(supplier.openingBalanceInput)) return;

  await postJournal(tx, {
    organizationId,
    entryDate: asOfDate,
    referenceType: 'opening_balance',
    referenceId: supplier.id,
    lines: [
      { accountCode: ACCOUNT_CODES.OPENING_BALANCE_EQUITY, debit: supplier.openingBalanceInput },
      {
        accountCode: ACCOUNT_CODES.ACCOUNTS_PAYABLE,
        credit: supplier.openingBalanceInput,
        supplierId: supplier.id,
        description: 'Opening balance',
      },
    ],
  });
}

/**
 * Posts a product_variant's starting quantity as a stock_movements row
 * (movement_type = 'opening_balance') rather than a special field —
 * current_stock ends up correct the same way it does for any other
 * movement, because postStockMovement() is the same function every other
 * movement type goes through. Call once, right after creating the variant.
 */
export async function postOpeningStock(tx: Tx, organizationId: string, productVariantId: string, quantity: number, asOfDate: string) {
  if (quantity === 0) return; // nothing to post — current_stock stays at its default of 0

  const [variant] = await tx.select().from(productVariants).where(eq(productVariants.id, productVariantId));
  if (!variant) throw new AccountingError('Product variant not found.', 'NOT_FOUND');

  await postStockMovement(tx, {
    organizationId,
    productVariantId,
    movementType: 'opening_balance',
    quantity,
    referenceType: 'product_variant_onboarding',
    referenceId: productVariantId,
    movementDate: asOfDate,
  });
}
