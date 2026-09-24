import { eq, and } from 'drizzle-orm';
import { db, ledgerAccounts } from '@platform/db';
import { AccountingError } from './errors';

/** Anything shaped like the drizzle db instance or a transaction handle
 * inside db.transaction(async (tx) => ...) — every posting function in
 * this package takes one of these instead of a bare organizationId, so a
 * whole multi-step post (e.g. confirmSale) runs inside one caller-owned
 * transaction. */
export type Tx = Pick<typeof db, 'select' | 'insert' | 'update' | 'execute' | 'query'>;

const accountCache = new Map<string, string>(); // `${orgId}:${code}` -> account id
const cacheKey = (organizationId: string, code: string) => `${organizationId}:${code}`;

/**
 * Resolves a ledger account by its short code (e.g. 'AR', 'SALES',
 * 'CGST_PAYABLE') within the given organization. Every posting function in
 * this package goes through here rather than hard-coding account ids, so
 * the seeded chart of accounts (see packages/db/seed/seed.ts) is the single
 * place account codes are defined.
 */
export async function getAccountId(tx: Tx, organizationId: string, code: string): Promise<string> {
  const key = cacheKey(organizationId, code);
  const cached = accountCache.get(key);
  if (cached) return cached;

  const [row] = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.organizationId, organizationId), eq(ledgerAccounts.code, code)))
    .limit(1);

  if (!row) {
    throw new AccountingError(
      `Ledger account '${code}' is not set up for this organization — has seedOrganizationDefaults() run?`,
      'ACCOUNT_NOT_FOUND',
    );
  }

  accountCache.set(key, row.id);
  return row.id;
}

/** Standard account codes used throughout this package. Keep in sync with
 * DEFAULT_LEDGER_ACCOUNTS in packages/db/seed/seed.ts. */
export const ACCOUNT_CODES = {
  CASH: 'CASH',
  BANK: 'BANK',
  ACCOUNTS_RECEIVABLE: 'AR',
  INVENTORY: 'INVENTORY',
  ACCOUNTS_PAYABLE: 'AP',
  CGST_PAYABLE: 'CGST_PAYABLE',
  SGST_PAYABLE: 'SGST_PAYABLE',
  IGST_PAYABLE: 'IGST_PAYABLE',
  SALES: 'SALES',
  PURCHASES: 'PURCHASES',
  EXPENSES: 'EXPENSES',
  OPENING_BALANCE_EQUITY: 'OPENING_BALANCE_EQUITY',
} as const;
