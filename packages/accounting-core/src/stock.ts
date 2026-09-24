import { eq, sql } from 'drizzle-orm';
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
 * Writes the auditable stock_movements row and updates the current_stock
 * cache on product_variants in the same statement group — the cache is
 * never touched independently of a movement. Call inside the same
 * transaction as the postJournal() call for the same business event.
 */
export async function postStockMovement(tx: Tx, input: PostStockMovementInput): Promise<void> {
  if (input.quantity === 0) {
    throw new AccountingError('Stock movement quantity cannot be zero.', 'ZERO_MOVEMENT');
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

  // Cache update happens here, transactionally, and nowhere else in the
  // codebase should UPDATE product_variants.current_stock directly.
  await tx
    .update(productVariants)
    .set({ currentStock: sql`${productVariants.currentStock} + ${input.quantity}` })
    .where(eq(productVariants.id, input.productVariantId));
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
