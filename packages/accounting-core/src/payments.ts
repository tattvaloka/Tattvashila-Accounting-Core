import { payments } from '@platform/db';
import type { Tx } from './accounts';
import { ACCOUNT_CODES } from './accounts';
import { AccountingError } from './errors';
import { postJournal } from './postJournal';

export interface RecordPaymentInput {
  organizationId: string;
  direction: 'in' | 'out';
  customerId?: string;
  supplierId?: string;
  amount: string;
  paymentMode: 'cash' | 'upi' | 'bank' | 'cheque';
  reference?: string;
  paymentDate: string; // 'YYYY-MM-DD'
  linkedSaleId?: string;
  linkedPurchaseId?: string;
  createdByOrgUserId: string;
}

/**
 * The one function that posts money movement. Direction and party are
 * independent, so all four combinations are real business cases:
 *   customer + in  -> receipt (Dr Cash/Bank, Cr Accounts Receivable)
 *   customer + out -> refund to a customer (Dr AR, Cr Cash/Bank)
 *   supplier + out -> payment to a supplier (Dr AP, Cr Cash/Bank)
 *   supplier + in  -> refund from a supplier (Dr Cash/Bank, Cr AP)
 */
export async function recordPayment(tx: Tx, input: RecordPaymentInput) {
  if (Boolean(input.customerId) === Boolean(input.supplierId)) {
    throw new AccountingError('A payment must have exactly one of customerId/supplierId.', 'INVALID_PARTY');
  }
  if (input.linkedSaleId && !input.customerId) {
    throw new AccountingError('linkedSaleId requires customerId.', 'INVALID_LINK');
  }
  if (input.linkedPurchaseId && !input.supplierId) {
    throw new AccountingError('linkedPurchaseId requires supplierId.', 'INVALID_LINK');
  }

  const cashAccount = input.paymentMode === 'cash' ? ACCOUNT_CODES.CASH : ACCOUNT_CODES.BANK;
  const partyAccount = input.customerId ? ACCOUNT_CODES.ACCOUNTS_RECEIVABLE : ACCOUNT_CODES.ACCOUNTS_PAYABLE;
  const partyRef = input.customerId ? { customerId: input.customerId } : { supplierId: input.supplierId };

  const [payment] = await tx
    .insert(payments)
    .values({
      organizationId: input.organizationId,
      customerId: input.customerId ?? null,
      supplierId: input.supplierId ?? null,
      direction: input.direction,
      amount: input.amount,
      paymentMode: input.paymentMode,
      reference: input.reference,
      paymentDate: input.paymentDate,
      linkedSaleId: input.linkedSaleId ?? null,
      linkedPurchaseId: input.linkedPurchaseId ?? null,
      createdBy: input.createdByOrgUserId,
    })
    .returning();

  const lines =
    input.direction === 'in'
      ? [
          { accountCode: cashAccount, debit: input.amount, description: `Payment ${payment.id}` },
          { accountCode: partyAccount, credit: input.amount, ...partyRef },
        ]
      : [
          { accountCode: partyAccount, debit: input.amount, ...partyRef },
          { accountCode: cashAccount, credit: input.amount, description: `Payment ${payment.id}` },
        ];

  await postJournal(tx, {
    organizationId: input.organizationId,
    entryDate: input.paymentDate,
    referenceType: 'payment',
    referenceId: payment.id,
    lines,
  });

  return payment;
}
