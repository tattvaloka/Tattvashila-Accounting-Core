import { describe, it, expect } from 'vitest';
import { postStockMovement } from '../src/stock';
import type { Tx } from '../src/accounts';

/**
 * Mocks the two statements postStockMovement issues: the guarded UPDATE
 * (returns a row if the guard passed, empty if it didn't), and — only on
 * the insufficient-stock path — a plain SELECT to fetch the current
 * quantity for the error message. Whether the guarded UPDATE itself
 * actually prevents a race under concurrency is a real-Postgres question a
 * mock cannot answer; see the "insufficient stock" test in
 * test/sales.integration.test.ts for that.
 */
function makeMockTx(options: { updateSucceeds: boolean; existingStock?: number }) {
  const insertedMovements: unknown[] = [];
  const tx = {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => (options.updateSucceeds ? [{ id: 'variant-1', currentStock: 5 }] : []),
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: async () => (options.existingStock === undefined ? [] : [{ currentStock: options.existingStock }]),
      }),
    }),
    insert: () => ({
      values: async (rows: unknown[]) => {
        insertedMovements.push(...(Array.isArray(rows) ? rows : [rows]));
      },
    }),
  } as unknown as Tx;
  return { tx, insertedMovements };
}

describe('postStockMovement', () => {
  it('rejects a zero-quantity movement without touching the database', async () => {
    const { tx, insertedMovements } = makeMockTx({ updateSucceeds: true });
    await expect(
      postStockMovement(tx, {
        organizationId: 'org-1',
        productVariantId: 'variant-1',
        movementType: 'adjustment',
        quantity: 0,
        referenceType: 'test',
        referenceId: 'ref-1',
        movementDate: '2026-09-24',
      }),
    ).rejects.toThrow(/cannot be zero/i);
    expect(insertedMovements).toHaveLength(0);
  });

  it('writes the movement row only after the guarded update succeeds', async () => {
    const { tx, insertedMovements } = makeMockTx({ updateSucceeds: true });
    await postStockMovement(tx, {
      organizationId: 'org-1',
      productVariantId: 'variant-1',
      movementType: 'purchase',
      quantity: 10,
      referenceType: 'purchase',
      referenceId: 'ref-2',
      movementDate: '2026-09-24',
    });
    expect(insertedMovements).toHaveLength(1);
    expect(insertedMovements[0]).toMatchObject({ quantity: 10, movementType: 'purchase' });
  });

  it('throws INSUFFICIENT_STOCK (not a generic error) when the guarded update affects zero rows and the variant exists', async () => {
    const { tx, insertedMovements } = makeMockTx({ updateSucceeds: false, existingStock: 3 });
    let caught: unknown;
    try {
      await postStockMovement(tx, {
        organizationId: 'org-1',
        productVariantId: 'variant-1',
        movementType: 'sale',
        quantity: -10, // more than the 3 available
        referenceType: 'sale',
        referenceId: 'ref-3',
        movementDate: '2026-09-24',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(insertedMovements).toHaveLength(0); // no movement row on rejection
  });

  it('throws NOT_FOUND (distinct from INSUFFICIENT_STOCK) when the variant does not exist for this org', async () => {
    const { tx } = makeMockTx({ updateSucceeds: false, existingStock: undefined });
    let caught: unknown;
    try {
      await postStockMovement(tx, {
        organizationId: 'org-1',
        productVariantId: 'does-not-exist',
        movementType: 'sale',
        quantity: -1,
        referenceType: 'sale',
        referenceId: 'ref-4',
        movementDate: '2026-09-24',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ code: 'NOT_FOUND' });
  });
});
