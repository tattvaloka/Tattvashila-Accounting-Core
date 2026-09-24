import { expenses } from '@platform/db';
import type { Tx } from './accounts';
import { ACCOUNT_CODES } from './accounts';
import { postJournal } from './postJournal';

export interface RecordExpenseInput {
  organizationId: string;
  branchId?: string;
  category: string;
  amount: string;
  expenseDate: string;
  paymentMode: string;
  description?: string;
  createdByOrgUserId: string;
}

/**
 * Posts Dr General Expenses / Cr Cash or Bank. `category` is kept as free
 * text on the expenses row for reporting/breakdown (e.g. "Rent", "Fuel")
 * without needing a full sub-ledger per category — a deliberate
 * depth-over-breadth simplification for the MVP.
 */
export async function recordExpense(tx: Tx, input: RecordExpenseInput) {
  const [expense] = await tx
    .insert(expenses)
    .values({
      organizationId: input.organizationId,
      branchId: input.branchId,
      category: input.category,
      amount: input.amount,
      expenseDate: input.expenseDate,
      paymentMode: input.paymentMode,
      description: input.description,
      createdBy: input.createdByOrgUserId,
    })
    .returning();

  const cashAccount = input.paymentMode === 'cash' ? ACCOUNT_CODES.CASH : ACCOUNT_CODES.BANK;

  await postJournal(tx, {
    organizationId: input.organizationId,
    entryDate: input.expenseDate,
    referenceType: 'expense',
    referenceId: expense.id,
    lines: [
      { accountCode: ACCOUNT_CODES.EXPENSES, debit: input.amount, description: input.category },
      { accountCode: cashAccount, credit: input.amount },
    ],
  });

  return expense;
}
