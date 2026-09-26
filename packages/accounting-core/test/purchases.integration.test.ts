/**
 * Real integration tests, same caveat as sales.integration.test.ts: did NOT
 * run in this sandbox (no database here). Self-skips without DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool, purchases, purchaseItems, productVariants, ledgerEntries, stockMovements } from '@platform/db';
import { confirmPurchase, createPurchaseReturn } from '../src/purchases';
import { createFixture, destroyFixture, type Fixture } from './helpers/fixture';

const RUN = Boolean(process.env.DATABASE_URL);
const d = RUN ? describe : describe.skip;

d('purchase lifecycle (integration)', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await createFixture('purchases');
  });

  afterAll(async () => {
    await destroyFixture(f);
    await pool.end();
  });

  it('confirming a purchase capitalizes Inventory + Input GST and increases stock (no COGS at purchase time)', async () => {
    const [purchase] = await db
      .insert(purchases)
      .values({ organizationId: f.organizationId, supplierId: f.supplierId, purchaseDate: '2026-09-24' })
      .returning();
    await db.insert(purchaseItems).values({
      organizationId: f.organizationId,
      purchaseId: purchase.id,
      productVariantId: f.variantId,
      quantity: 20,
      rate: '400.00', // matches product.purchasePrice used later for COGS
      discountAmount: '0.00',
      taxableValue: '0.00',
      lineTotal: '0.00',
    });

    const result = await db.transaction((tx) =>
      confirmPurchase(tx, { organizationId: f.organizationId, purchaseId: purchase.id, confirmedByOrgUserId: f.orgUserId }),
    );
    expect(result.grandTotal).toBe('9440.00'); // 8000 taxable + 720 input CGST + 720 input SGST

    const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.referenceId, purchase.id));
    expect(entries).toHaveLength(4); // Inventory, InputCGST, InputSGST, AP — no COGS/Purchases-expense line
    const totalDebit = entries.reduce((s, e) => s + Number.parseFloat(e.debitAmount), 0);
    const totalCredit = entries.reduce((s, e) => s + Number.parseFloat(e.creditAmount), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 2);
    expect(totalDebit).toBeCloseTo(9440, 2);

    const [variant] = await db.select().from(productVariants).where(eq(productVariants.id, f.variantId));
    expect(variant.currentStock).toBe(20);

    const movements = await db.select().from(stockMovements).where(eq(stockMovements.referenceId, purchase.id));
    expect(movements).toHaveLength(1);
    expect(movements[0].quantity).toBe(20);
  });

  it('a partial purchase return decreases stock and reverses Inventory/Input GST/Payable proportionally', async () => {
    const [purchase] = await db
      .insert(purchases)
      .values({ organizationId: f.organizationId, supplierId: f.supplierId, purchaseDate: '2026-09-24' })
      .returning();
    const [item] = await db
      .insert(purchaseItems)
      .values({
        organizationId: f.organizationId,
        purchaseId: purchase.id,
        productVariantId: f.variantId,
        quantity: 10,
        rate: '400.00',
        discountAmount: '0.00',
        taxableValue: '0.00',
        lineTotal: '0.00',
      })
      .returning();
    await db.transaction((tx) =>
      confirmPurchase(tx, { organizationId: f.organizationId, purchaseId: purchase.id, confirmedByOrgUserId: f.orgUserId }),
    );
    const [beforeVariant] = await db.select().from(productVariants).where(eq(productVariants.id, f.variantId));
    const [beforePurchase] = await db.select().from(purchases).where(eq(purchases.id, purchase.id));

    await db.transaction((tx) =>
      createPurchaseReturn(tx, {
        organizationId: f.organizationId,
        purchaseId: purchase.id,
        lines: [{ purchaseItemId: item.id, quantity: 3 }],
        createdByOrgUserId: f.orgUserId,
        reason: 'Damaged on arrival',
      }),
    );

    const [afterPurchase] = await db.select().from(purchases).where(eq(purchases.id, purchase.id));
    expect(afterPurchase).toEqual(beforePurchase); // original purchase row untouched

    const [afterVariant] = await db.select().from(productVariants).where(eq(productVariants.id, f.variantId));
    expect(afterVariant.currentStock).toBe(beforeVariant.currentStock - 3);

    const returnEntries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.referenceType, 'purchase_return'));
    const rDebit = returnEntries.reduce((s, e) => s + Number.parseFloat(e.debitAmount), 0);
    const rCredit = returnEntries.reduce((s, e) => s + Number.parseFloat(e.creditAmount), 0);
    expect(rDebit).toBeCloseTo(rCredit, 2);
    // 3/10 of the purchase: taxable 1200 + cgst 108 + sgst 108 = 1416.00
    expect(rDebit).toBeCloseTo(1416, 2);
    expect(returnEntries).toHaveLength(4); // AP, Inventory, InputCGST, InputSGST

    const movements = await db.select().from(stockMovements).where(eq(stockMovements.referenceType, 'purchase_return'));
    expect(movements.some((m) => m.quantity === -3)).toBe(true);
  });

  it('rejects returning more than was purchased', async () => {
    const [purchase] = await db
      .insert(purchases)
      .values({ organizationId: f.organizationId, supplierId: f.supplierId, purchaseDate: '2026-09-24' })
      .returning();
    const [item] = await db
      .insert(purchaseItems)
      .values({
        organizationId: f.organizationId,
        purchaseId: purchase.id,
        productVariantId: f.variantId,
        quantity: 2,
        rate: '400.00',
        discountAmount: '0.00',
        taxableValue: '0.00',
        lineTotal: '0.00',
      })
      .returning();
    await db.transaction((tx) =>
      confirmPurchase(tx, { organizationId: f.organizationId, purchaseId: purchase.id, confirmedByOrgUserId: f.orgUserId }),
    );

    await expect(
      db.transaction((tx) =>
        createPurchaseReturn(tx, {
          organizationId: f.organizationId,
          purchaseId: purchase.id,
          lines: [{ purchaseItemId: item.id, quantity: 5 }],
          createdByOrgUserId: f.orgUserId,
        }),
      ),
    ).rejects.toThrow(/only \d+ remain returnable/i);
  });
});
