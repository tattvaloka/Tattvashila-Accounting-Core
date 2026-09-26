import { describe, it, expect } from 'vitest';
import { postJournal } from '../src/postJournal';
import type { Tx } from '../src/accounts';

/**
 * A minimal stand-in for the Drizzle tx handle, just enough to satisfy
 * postJournal()'s two calls: the account-code lookup inside getAccountId(),
 * and the final insert into ledger_entries.
 *
 * Account resolution is faked by returning ids from `accountIdsInOrder` in
 * call order (postJournal resolves one account per line, in line order via
 * Promise.all over synchronously-resolving promises, so this stays
 * deterministic). Real end-to-end posting against actual seeded accounts is
 * covered by the integration tests (sales.integration.test.ts /
 * purchases.integration.test.ts), which need a live database.
 */
function makeMockTx(accountIdsInOrder: string[] = []) {
  let callIndex = 0;
  const insertedRows: Record<string, unknown>[] = [];
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            const id = accountIdsInOrder[callIndex++];
            return id ? [{ id }] : [];
          },
        }),
      }),
    }),
    insert: () => ({
      values: async (rows: Record<string, unknown>[]) => {
        insertedRows.push(...rows);
      },
    }),
  } as unknown as Tx;
  return { tx, insertedRows };
}

describe('postJournal — invalid journals rejected', () => {
  it('rejects an unbalanced posting before writing anything', async () => {
    const { tx, insertedRows } = makeMockTx();
    await expect(
      postJournal(tx, {
        organizationId: 'org-unbalanced',
        entryDate: '2026-09-24',
        referenceType: 'test',
        referenceId: 'ref-1',
        lines: [
          { accountCode: 'AR', debit: '100.00' },
          { accountCode: 'SALES', credit: '90.00' },
        ],
      }),
    ).rejects.toThrow(/unbalanced/i);
    expect(insertedRows).toHaveLength(0);
  });

  it('rejects an empty posting', async () => {
    const { tx } = makeMockTx();
    await expect(
      postJournal(tx, { organizationId: 'org-empty', entryDate: '2026-09-24', referenceType: 'test', referenceId: 'ref-2', lines: [] }),
    ).rejects.toThrow(/empty/i);
  });

  it('rejects a posting where every line is zero', async () => {
    const { tx } = makeMockTx();
    await expect(
      postJournal(tx, {
        organizationId: 'org-zero',
        entryDate: '2026-09-24',
        referenceType: 'test',
        referenceId: 'ref-3',
        lines: [
          { accountCode: 'AR', debit: '0.00' },
          { accountCode: 'SALES', credit: '0.00' },
        ],
      }),
    ).rejects.toThrow(/zero/i);
  });

  it('rejects a line that sets both debit and credit (malformed posting)', async () => {
    const { tx } = makeMockTx();
    await expect(
      postJournal(tx, {
        organizationId: 'org-both',
        entryDate: '2026-09-24',
        referenceType: 'test',
        referenceId: 'ref-4',
        lines: [
          { accountCode: 'AR', debit: '100.00', credit: '100.00' },
          { accountCode: 'SALES', credit: '100.00' },
        ],
      }),
    ).rejects.toThrow(/exactly one of debit\/credit/i);
  });

  it('rejects a line that sets neither debit nor credit (malformed posting)', async () => {
    const { tx } = makeMockTx();
    await expect(
      postJournal(tx, {
        organizationId: 'org-neither',
        entryDate: '2026-09-24',
        referenceType: 'test',
        referenceId: 'ref-4b',
        lines: [
          { accountCode: 'AR' },
          { accountCode: 'SALES', credit: '100.00' },
        ],
      }),
    ).rejects.toThrow(/exactly one of debit\/credit/i);
  });

  it('rejects a line carrying both a customer and a supplier (malformed posting)', async () => {
    const { tx } = makeMockTx();
    await expect(
      postJournal(tx, {
        organizationId: 'org-party',
        entryDate: '2026-09-24',
        referenceType: 'test',
        referenceId: 'ref-5',
        lines: [
          { accountCode: 'AR', debit: '100.00', customerId: 'cust-1', supplierId: 'supp-1' },
          { accountCode: 'SALES', credit: '100.00' },
        ],
      }),
    ).rejects.toThrow(/cannot carry both/i);
  });

  it('rejects a reference to an account that does not resolve (simulates a missing chart-of-accounts entry)', async () => {
    const { tx } = makeMockTx([]); // no ids configured -> every lookup "misses"
    await expect(
      postJournal(tx, {
        organizationId: 'org-missing-account',
        entryDate: '2026-09-24',
        referenceType: 'test',
        referenceId: 'ref-7',
        lines: [
          { accountCode: 'NOT_A_REAL_CODE', debit: '100.00' },
          { accountCode: 'ALSO_NOT_REAL', credit: '100.00' },
        ],
      }),
    ).rejects.toThrow(/not set up for this organization/i);
  });
});

describe('postJournal — valid journals accepted', () => {
  it('accepts a simple balanced two-line journal and writes the correct rows', async () => {
    const { tx, insertedRows } = makeMockTx(['acct-ar-id', 'acct-sales-id']);
    await postJournal(tx, {
      organizationId: 'org-ok-1',
      entryDate: '2026-09-24',
      referenceType: 'test',
      referenceId: 'ref-8',
      lines: [
        { accountCode: 'AR', debit: '100.00', customerId: 'cust-1', description: 'Sale' },
        { accountCode: 'SALES', credit: '100.00' },
      ],
    });

    expect(insertedRows).toHaveLength(2);
    expect(insertedRows[0]).toMatchObject({
      organizationId: 'org-ok-1',
      accountId: 'acct-ar-id',
      customerId: 'cust-1',
      supplierId: null,
      debitAmount: '100.00',
      creditAmount: '0',
      referenceType: 'test',
      referenceId: 'ref-8',
      entryDate: '2026-09-24',
      description: 'Sale',
    });
    expect(insertedRows[1]).toMatchObject({
      accountId: 'acct-sales-id',
      debitAmount: '0',
      creditAmount: '100.00',
    });
  });

  it('accepts a multi-line balanced journal (revenue + tax split) and the totals actually balance', async () => {
    const { tx, insertedRows } = makeMockTx(['acct-ar', 'acct-sales', 'acct-cgst', 'acct-sgst']);
    await postJournal(tx, {
      organizationId: 'org-ok-2',
      entryDate: '2026-09-24',
      referenceType: 'sale',
      referenceId: 'sale-1',
      lines: [
        { accountCode: 'AR', debit: '118.00', customerId: 'cust-2' },
        { accountCode: 'SALES', credit: '100.00' },
        { accountCode: 'OUTPUT_CGST', credit: '9.00' },
        { accountCode: 'OUTPUT_SGST', credit: '9.00' },
      ],
    });

    expect(insertedRows).toHaveLength(4);
    const totalDebit = insertedRows.reduce((s, r) => s + Number.parseFloat(r.debitAmount as string), 0);
    const totalCredit = insertedRows.reduce((s, r) => s + Number.parseFloat(r.creditAmount as string), 0);
    expect(totalDebit).toBeCloseTo(118, 2);
    expect(totalCredit).toBeCloseTo(118, 2);
    expect(totalDebit).toBeCloseTo(totalCredit, 2);
  });

  it('accepts a line with a supplier instead of a customer', async () => {
    const { tx, insertedRows } = makeMockTx(['acct-inv', 'acct-ap']);
    await postJournal(tx, {
      organizationId: 'org-ok-3',
      entryDate: '2026-09-24',
      referenceType: 'purchase',
      referenceId: 'purchase-1',
      lines: [
        { accountCode: 'INVENTORY', debit: '400.00' },
        { accountCode: 'AP', credit: '400.00', supplierId: 'supp-9' },
      ],
    });
    expect(insertedRows[1]).toMatchObject({ supplierId: 'supp-9', customerId: null, creditAmount: '400.00' });
  });
});
