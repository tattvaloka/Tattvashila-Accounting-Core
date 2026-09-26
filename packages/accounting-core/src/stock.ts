import { eq, and, sql } from 'drizzle-orm';
import { stockMovements, productVariants } from '@platform/db';
import type { Tx } from './accounts';
import { AccountingError } from './errors';

export interface PostStockMovementInput {
  organizationId: string;
  productVariantId: string;
  movementType: 'opening_balance' | 'purchase' | 'sale' | 'sale_return' | 'purchase_return' | 'adjustment';
  quantity: number; // signed: + in, - out
  referenceType: string;
  referenceId: string;
  movementDate: string; // 'YYYY-MM-DD'
}

/**
 * The single authority for stock changes (Critical inventory requirement).
 *
 * Milestone 3 correctness pass, Item 3: the previous version did an
 * unconditional `current_stock = current_stock + quantity`, which could
 * both go negative and race under concurrency (two simultaneous sales of
 * the last pair could each read 1, both decide it's enough, and both
 * succeed). Fixed by making the availability check part of the UPDATE's
 * WHERE clause instead of a separate SELECT:
 *
 *   UPDATE product_variants
 *   SET current_stock = current_stock + :qty
 *   WHERE id = :id AND current_stock + :qty >= 0
 *
 * Postgres takes the row lock as part of evaluating and applying this
 * statement, so a second concurrent UPDATE on the same row blocks until the
 * first transaction commits or rolls back, then re-evaluates the guard
 * against the now-current value — there is no window where two
 * transactions can both read "1 in stock" and both proceed. This is why
 * there's no explicit SELECT ... FOR UPDATE step here: the guarded UPDATE
 * *is* the lock. If the guard fails, zero rows are affected, and that's
 * what distinguishes "insufficient stock" from "row doesn't exist" below.
 *
 * The stock_movements audit row is only inserted after the guarded update
 * succeeds — never before — so an insufficient-stock rejection leaves
 * neither a movement row nor a changed cache behind (the whole call throws
 * before either half is committed, and the caller's transaction rolls back
 * whatever else it had done in the same posting).
 */
export async function postStockMovement(tx: Tx, input: PostStockMovementInput): Promise<void> {
  if (input.quantity === 0) {
    throw new AccountingError('Stock movement quantity cannot be zero.', 'ZERO_MOVEMENT');
  }

  const updated = await tx
    .update(productVariants)
    .set({ currentStock: sql`${productVariants.currentStock} + ${input.quantity}` })
    .where(
      and(
        eq(productVariants.id, input.productVariantId),
        eq(productVariants.organizationId, input.organizationId),
        sql`${productVariants.currentStock} + ${input.quantity} >= 0`,
      ),
    )
    .returning({ id: productVariants.id, currentStock: productVariants.currentStock });

  if (updated.length === 0) {
    // Distinguish "doesn't exist / wrong org" from "exists but insufficient"
    // so the error actually tells the caller what happened.
    const [exists] = await tx
      .select({ currentStock: productVariants.currentStock })
      .from(productVariants)
      .where(and(eq(productVariants.id, input.productVariantId), eq(productVariants.organizationId, input.organizationId)));

    if (!exists) {
      throw new AccountingError('Product variant not found for this organization.', 'NOT_FOUND');
    }
    throw new AccountingError(
      `Insufficient stock: ${exists.currentStock} available, ${Math.abs(input.quantity)} requested.`,
      'INSUFFICIENT_STOCK',
    );
  }

  await tx.insert(stockMovements).values({
    organizationId: input.organizationId,
    productVariantId: input.productVariantId,
    movementType: input.movementType,
    quantity: input.quantity,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    movementDate: input.movementDate,
  });
}

/**
 * Reconciliation check: compares the cache against SUM(stock_movements).
 * Intended to run on a schedule (a cron / background job in the API
 * layer, not implemented here) and alert on any variant that disagrees —
 * catching a bug rather than trusting the cache blindly, per the brief.
 */
export async function findStockDiscrepancies(
  tx: Tx,
  organizationId: string,
): Promise<Array<{ productVariantId: string; cached: number; computed: number }>> {
  const rows = await tx
    .select({
      productVariantId: productVariants.id,
      cached: productVariants.currentStock,
      computed: sql<number>`coalesce(sum(${stockMovements.quantity}), 0)::int`,
    })
    .from(productVariants)
    .leftJoin(stockMovements, eq(stockMovements.productVariantId, productVariants.id))
    .where(eq(productVariants.organizationId, organizationId))
    .groupBy(productVariants.id, productVariants.currentStock)
    .having(sql`${productVariants.currentStock} <> coalesce(sum(${stockMovements.quantity}), 0)`);

  return rows;
}
