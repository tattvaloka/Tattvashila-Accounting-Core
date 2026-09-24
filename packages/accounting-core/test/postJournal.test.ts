import { describe, it, expect } from 'vitest';
import { postJournal } from '../src/postJournal';
import type { Tx } from '../src/accounts';

/**
 * A minimal stand-in for the Drizzle tx handle, just enough to satisfy
 * postJournal()'s two calls: the account-code lookup inside getAccountId(),
 * and the final insert into ledger_entries. Real end-to-end posting
 * (including the actual account lookup against seeded data) is covered by
 * the integration tests, which need a live database — see
 * test/sales.integration.test.ts.
 */
function makeMockTx(accountIdsByCode: Record<string, string>) {
  const insertedRows: unknown[] = [];
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            // getAccountId always selects by (organizationId, code); code is
            // baked into the mock via a closure below in each test instead
            // of inspected here, since this mock doesn't parse the drizzle
            // query builder's internal condition tree.
            return [];
          },
        }),
      }),
    }),
    insert: () => ({
      values: async (rows: unknown[]) => {
        insertedRows.push(...rows);
      },
    }),
  } as unknown as Tx;
  return { tx, insertedRows, accountIdsByCode };
}

describe('postJournal', () => {
  it('rejects an unbalanced posting before writing anything', async () => {
    const { tx, insertedRows } = makeMockTx({});
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
    const { tx } = makeMockTx({});
    await expect(
      postJournal(tx, { organizationId: 'org-empty', entryDate: '2026-09-24', referenceType: 'test', referenceId: 'ref-2', lines: [] }),
    ).rejects.toThrow(/empty/i);
  });

  it('rejects a posting where every line is zero', async () => {
    const { tx } = makeMockTx({});
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

  it('rejects a line that sets both debit and credit', async () => {
    const { tx } = makeMockTx({});
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

  it('rejects a line carrying both a customer and a supplier', async () => {
    const { tx } = makeMockTx({});
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
});
