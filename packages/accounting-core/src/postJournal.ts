import { ledgerEntries } from '@platform/db';
import type { Tx } from './accounts';
import { getAccountId } from './accounts';
import { AccountingError } from './errors';
import { sumPaise } from './money';

export interface JournalLine {
  accountCode: string;
  debit?: string;
  credit?: string;
  customerId?: string;
  supplierId?: string;
  description?: string;
}

export interface PostJournalInput {
  organizationId: string;
  entryDate: string; // 'YYYY-MM-DD'
  referenceType: string;
  referenceId: string;
  lines: JournalLine[];
}

/**
 * The single authority for financial posting (Critical accounting
 * requirement). Every other function in this package — confirmSale,
 * confirmPurchase, recordPayment, opening balances, returns — ultimately
 * calls this. Nothing else in the codebase is allowed to INSERT into
 * ledger_entries directly; the table's own grants back that up (see
 * migrations/0001_triggers_and_rls.sql — UPDATE/DELETE are revoked, and in
 * a real deployment INSERT should be revoked from every role except the
 * one this function runs as).
 *
 * Validates the posting is balanced (sum of debits == sum of credits) and
 * non-empty *before* writing anything. Call this inside a transaction
 * alongside whatever stock_movements / status updates belong to the same
 * business event — Postgres commits or rolls back the whole thing together.
 */
export async function postJournal(tx: Tx, input: PostJournalInput): Promise<void> {
  if (input.lines.length === 0) {
    throw new AccountingError('Cannot post an empty journal entry.', 'EMPTY_POSTING');
  }

  for (const line of input.lines) {
    const hasDebit = line.debit !== undefined && line.debit !== '0' && line.debit !== '0.00';
    const hasCredit = line.credit !== undefined && line.credit !== '0' && line.credit !== '0.00';
    if (hasDebit === hasCredit) {
      throw new AccountingError(
        `Journal line for account '${line.accountCode}' must have exactly one of debit/credit set.`,
        'INVALID_LINE',
      );
    }
    if (line.customerId && line.supplierId) {
      throw new AccountingError(
        `Journal line for account '${line.accountCode}' cannot carry both a customer and a supplier.`,
        'INVALID_PARTY',
      );
    }
  }

  const totalDebit = sumPaise(input.lines.map((l) => l.debit ?? '0'));
  const totalCredit = sumPaise(input.lines.map((l) => l.credit ?? '0'));
  if (totalDebit !== totalCredit) {
    throw new AccountingError(
      `Unbalanced journal entry for ${input.referenceType}:${input.referenceId} — debits ${(totalDebit / 100).toFixed(2)} != credits ${(totalCredit / 100).toFixed(2)}.`,
      'UNBALANCED_POSTING',
    );
  }
  if (totalDebit === 0) {
    throw new AccountingError('Cannot post a journal entry where every line is zero.', 'ZERO_POSTING');
  }

  const rows = await Promise.all(
    input.lines.map(async (line) => ({
      organizationId: input.organizationId,
      accountId: await getAccountId(tx, input.organizationId, line.accountCode),
      customerId: line.customerId ?? null,
      supplierId: line.supplierId ?? null,
      debitAmount: line.debit ?? '0',
      creditAmount: line.credit ?? '0',
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      entryDate: input.entryDate,
      description: line.description ?? null,
    })),
  );

  await tx.insert(ledgerEntries).values(rows);
}
