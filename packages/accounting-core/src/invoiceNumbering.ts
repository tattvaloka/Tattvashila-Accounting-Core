import { and, eq } from 'drizzle-orm';
import { invoiceSequences } from '@platform/db';
import type { Tx } from './accounts';

export type SequenceType = 'sale' | 'purchase' | 'sale_return' | 'purchase_return';

/**
 * Returns the financial year label for a date, given the org's configured
 * start month (India defaults to April = month 4). E.g. 2026-07-01 with
 * start month 4 -> '2026-2027'; 2026-02-01 with start month 4 -> '2025-2026'.
 */
export function financialYearFor(dateStr: string, startMonth: number): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1; // 1-12
  const startYear = month >= startMonth ? year : year - 1;
  return `${startYear}-${startYear + 1}`;
}

/**
 * Assigns the next invoice number for (org, sequenceType, financialYear),
 * row-locking the counter so concurrent Confirms can't hand out the same
 * number. Must be called inside the same transaction that confirms the
 * sale/purchase/return — if that transaction rolls back, the increment
 * rolls back with it, so a failed Confirm never burns a number (no
 * gap-handling policy needed, per the design doc).
 */
export async function nextInvoiceNumber(
  tx: Tx,
  organizationId: string,
  sequenceType: SequenceType,
  financialYear: string,
  prefix?: string | null,
): Promise<string> {
  // SELECT ... FOR UPDATE, row-locking the counter for this org/FY so
  // concurrent Confirms can't read-then-write the same number. Created on
  // first use.
  const [existing] = await tx
    .select()
    .from(invoiceSequences)
    .where(
      and(
        eq(invoiceSequences.organizationId, organizationId),
        eq(invoiceSequences.sequenceType, sequenceType),
        eq(invoiceSequences.financialYear, financialYear),
      ),
    )
    .for('update');

  let lastNumber: number;
  let rowPrefix: string | null;

  if (existing) {
    lastNumber = existing.lastNumber;
    rowPrefix = existing.prefix;
    await tx
      .update(invoiceSequences)
      .set({ lastNumber: lastNumber + 1 })
      .where(
        and(
          eq(invoiceSequences.organizationId, organizationId),
          eq(invoiceSequences.sequenceType, sequenceType),
          eq(invoiceSequences.financialYear, financialYear),
        ),
      );
  } else {
    lastNumber = 0;
    rowPrefix = prefix ?? null;
    await tx.insert(invoiceSequences).values({
      organizationId,
      sequenceType,
      financialYear,
      prefix: rowPrefix,
      lastNumber: 1,
    });
  }

  const number = lastNumber + 1;
  const padded = String(number).padStart(4, '0');
  const label = { sale: 'INV', purchase: 'PO', sale_return: 'CN', purchase_return: 'DN' }[sequenceType];
  return rowPrefix ? `${rowPrefix}-${financialYear}-${padded}` : `${label}-${financialYear}-${padded}`;
}
