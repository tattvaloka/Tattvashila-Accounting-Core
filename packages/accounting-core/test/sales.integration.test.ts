/**
 * Real integration tests against a real Postgres database — the ones that
 * actually exercise the schema (RLS, composite FKs, immutability triggers,
 * the guarded stock UPDATE), which a mock cannot. They did NOT run in the
 * sandbox this was written in (no network access there); run them for real
 * once this project is in an environment with DATABASE_URL set, e.g. after
 * `npm run migrate && npm run seed` against a disposable/test database.
 *
 * Self-skips without DATABASE_URL, so `npm test` still runs the pure unit
 * tests everywhere else.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool, sales, saleItems, productVariants, ledgerEntries, stockMovements } from '@platform/db';
import { confirmSale, createSaleReturn } from '../src/sales';
import { postOpeningStock } from '../src/openingBalances';
import { createFixture, destroyFixture, type Fixture } from './helpers/fixture';

const RUN = Boolean(process.env.DATABASE_URL);
const d = RUN ? describe : describe.skip;

d('sale lifecycle (integration)', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await createFixture('sales');
    // Opening stock must be posted atomically (stock_movements row + the
    // Dr Inventory / Cr Opening Balance Equity journal entry together) —
    // wrapped in db.transaction() the same way confirmSale/confirmPurchase
    // are, per the convention documented in openingBalances.ts.
    await db.transaction((tx) => postOpeningStock(tx, f.organizationId, f.variantId, 25, '2026-04-01'));
  });

  afterAll(async () => {
    await destroyFixture(f);
    await pool.end();
  });

  it('opening stock posts both the stock movement and a balanced Inventory/Equity entry', async () => {
    const movements = await db.select().from(stockMovements).where(eq(stockMovements.referenceType, 'product_variant_onboarding'));
    expect(movements).toHaveLength(1);
    expect(movements[0].quantity).toBe(25);

    const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.referenceType, 'product_variant_onboarding'));
    expect(entries).toHaveLength(2); // Dr Inventory, Cr Opening Balance Equity
    const debit = entries.reduce((s, e) => s + Number.parseFloat(e.debitAmount), 0);
    const credit = entries.reduce((s, e) => s + Number.parseFloat(e.creditAmount), 0);
    expect(debit).toBeCloseTo(credit, 2);
    expect(debit).toBeCloseTo(25 * 400, 2); // 25 pairs x purchasePrice 400.00

    const [variant] = await db.select().from(productVariants).where(eq(productVariants.id, f.variantId));
    expect(variant.currentStock).toBe(25);
  });

  it('confirming a sale posts revenue+tax+COGS as one balanced entry and reduces stock', async () => {
    const [sale] = await db
      .insert(sales)
      .values({ organizationId: f.organizationId, branchId: f.branchId, customerId: f.customerId, saleDate: '2026-09-24' })
      .returning();
    await db.insert(saleItems).values({
      organizationId: f.organizationId,
      saleId: sale.id,
      productVariantId: f.variantId,
      quantity: 10,
      rate: '500.00',
      discountAmount: '0.00',
      taxableValue: '0.00', // placeholder — confirmSale recalculates and overwrites this
      lineTotal: '0.00',
    });

    const result = await db.transaction((tx) => confirmSale(tx, { organizationId: f.organizationId, saleId: sale.id, confirmedByOrgUserId: f.orgUserId }));
    expect(result.grandTotal).toBe('5900.00'); // 5000 taxable + 450 output CGST + 450 output SGST

    const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.referenceId, sale.id));
    const totalDebit = entries.reduce((s, e) => s + Number.parseFloat(e.debitAmount), 0);
    const totalCredit = entries.reduce((s, e) => s + Number.parseFloat(e.creditAmount), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 2);
    // AR 5900 + COGS (10 x 400 = 4000) on the debit side
    expect(totalDebit).toBeCloseTo(9900, 2);
    expect(entries).toHaveLength(6); // AR, Sales, OutputCGST, OutputSGST, COGS, Inventory

    const [item] = await db.select().from(saleItems).where(eq(saleItems.saleId, sale.id));
    expect(item.cogsAmount).toBe('4000.00');

    const [variant] = await db.select().from(productVariants).where(eq(productVariants.id, f.variantId));
    expect(variant.currentStock).toBe(15); // 25 opening - 10 sold

    const movements = await db.select().from(stockMovements).where(eq(stockMovements.referenceId, sale.id));
    expect(movements).toHaveLength(1);
    expect(movements[0].quantity).toBe(-10);
  });

  it('rejects a sale that would take stock negative, with no partial mutation', async () => {
    const [before] = await db.select().from(productVariants).where(eq(productVariants.id, f.variantId));

    const [sale] = await db
      .insert(sales)
      .values({ organizationId: f.organizationId, branchId: f.branchId, customerId: f.customerId, saleDate: '2026-09-24' })
      .returning();
    await db.insert(saleItems).values({
      organizationId: f.organizationId,
      saleId: sale.id,
      productVariantId: f.variantId,
      quantity: before.currentStock + 1, // one more than available
      rate: '500.00',
      discountAmount: '0.00',
      taxableValue: '0.00',
      lineTotal: '0.00',
    });

    await expect(
      db.transaction((tx) => confirmSale(tx, { organizationId: f.organizationId, saleId: sale.id, confirmedByOrgUserId: f.orgUserId })),
    ).rejects.toThrow(/insufficient stock/i);

    // No partial mutation: stock unchanged, sale still draft, no ledger/movement rows for this attempt.
    const [after] = await db.select().from(productVariants).where(eq(productVariants.id, f.variantId));
    expect(after.currentStock).toBe(before.currentStock);

    const [saleRow] = await db.select().from(sales).where(eq(sales.id, sale.id));
    expect(saleRow.status).toBe('draft');

    const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.referenceId, sale.id));
    expect(entries).toHaveLength(0);
    const movements = await db.select().from(stockMovements).where(eq(stockMovements.referenceId, sale.id));
    expect(movements).toHaveLength(0);
  });

  it('rejects a direct edit to a confirmed sale at the database level', async () => {
    const [sale] = await db
      .insert(sales)
      .values({ organizationId: f.organizationId, branchId: f.branchId, customerId: f.customerId, saleDate: '2026-09-24' })
      .returning();
    await db.insert(saleItems).values({
      organizationId: f.organizationId,
      saleId: sale.id,
      productVariantId: f.variantId,
      quantity: 1,
      rate: '500.00',
      discountAmount: '0.00',
      taxableValue: '0.00',
      lineTotal: '0.00',
    });
    await db.transaction((tx) => confirmSale(tx, { organizationId: f.organizationId, saleId: sale.id, confirmedByOrgUserId: f.orgUserId }));

    // Bypasses the application layer entirely — this tests the trigger in
    // migrations/0001_triggers_and_rls.sql, not confirmSale().
    await expect(db.update(sales).set({ grandTotal: '1.00' }).where(eq(sales.id, sale.id))).rejects.toThrow();
  });

  it('a partial sale return increases stock and reverses revenue+tax+COGS proportionally, without touching the original sale', async () => {
    const [sale] = await db
      .insert(sales)
      .values({ organizationId: f.organizationId, branchId: f.branchId, customerId: f.customerId, saleDate: '2026-09-24' })
      .returning();
    const [item] = await db
      .insert(saleItems)
      .values({
        organizationId: f.organizationId,
        saleId: sale.id,
        productVariantId: f.variantId,
        quantity: 4,
        rate: '500.00',
        discountAmount: '0.00',
        taxableValue: '0.00',
        lineTotal: '0.00',
      })
      .returning();
    await db.transaction((tx) => confirmSale(tx, { organizationId: f.organizationId, saleId: sale.id, confirmedByOrgUserId: f.orgUserId }));
    const [beforeSale] = await db.select().from(sales).where(eq(sales.id, sale.id));
    const [beforeVariant] = await db.select().from(productVariants).where(eq(productVariants.id, f.variantId));

    await db.transaction((tx) =>
      createSaleReturn(tx, {
        organizationId: f.organizationId,
        saleId: sale.id,
        lines: [{ saleItemId: item.id, quantity: 1 }], // return 1 of 4
        createdByOrgUserId: f.orgUserId,
        reason: 'Wrong size',
      }),
    );

    const [afterSale] = await db.select().from(sales).where(eq(sales.id, sale.id));
    expect(afterSale).toEqual(beforeSale); // original sale row is untouched

    const [afterVariant] = await db.select().from(productVariants).where(eq(productVariants.id, f.variantId));
    expect(afterVariant.currentStock).toBe(beforeVariant.currentStock + 1);

    const returnEntries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.referenceType, 'sale_return'));
    const rDebit = returnEntries.reduce((s, e) => s + Number.parseFloat(e.debitAmount), 0);
    const rCredit = returnEntries.reduce((s, e) => s + Number.parseFloat(e.creditAmount), 0);
    expect(rDebit).toBeCloseTo(rCredit, 2);
    // Original line: 4 x ₹500 = ₹2000 taxable, ₹180 CGST, ₹180 SGST, COGS 4x400=₹1600.
    // Returning 1 of 4 (fraction 0.25): taxable 500 + cgst 45 + sgst 45 + cogs 400 = 990 debits.
    expect(rDebit).toBeCloseTo(500 + 45 + 45 + 400, 2);
    expect(returnEntries).toHaveLength(6); // Sales, OutputCGST, OutputSGST, AR, Inventory, COGS
  });

  it('rejects returning more than was sold', async () => {
    const [sale] = await db
      .insert(sales)
      .values({ organizationId: f.organizationId, branchId: f.branchId, customerId: f.customerId, saleDate: '2026-09-24' })
      .returning();
    const [item] = await db
      .insert(saleItems)
      .values({
        organizationId: f.organizationId,
        saleId: sale.id,
        productVariantId: f.variantId,
        quantity: 2,
        rate: '500.00',
        discountAmount: '0.00',
        taxableValue: '0.00',
        lineTotal: '0.00',
      })
      .returning();
    await db.transaction((tx) => confirmSale(tx, { organizationId: f.organizationId, saleId: sale.id, confirmedByOrgUserId: f.orgUserId }));

    await expect(
      db.transaction((tx) =>
        createSaleReturn(tx, {
          organizationId: f.organizationId,
          saleId: sale.id,
          lines: [{ saleItemId: item.id, quantity: 3 }], // only 2 were sold
          createdByOrgUserId: f.orgUserId,
        }),
      ),
    ).rejects.toThrow(/only \d+ remain returnable/i);
  });
});
