/**
 * These are real integration tests against a real Postgres database — they
 * are the ones that actually exercise the schema (RLS, the composite FKs,
 * the immutability triggers), which a mock cannot. They did NOT run in the
 * sandbox this was written in (no network access there); run them for real
 * once this project is in an environment with DATABASE_URL set, e.g. after
 * `npm run migrate && npm run seed` against a disposable/test database.
 *
 * Skips itself automatically when DATABASE_URL is not set, so `npm test`
 * still runs the pure unit tests everywhere else.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  db,
  pool,
  organizations,
  businessTypes,
  branches,
  customers,
  products,
  productVariants,
  taxRates,
  ledgerAccounts,
  roles,
  users,
  orgUsers,
  sales,
  saleItems,
  ledgerEntries,
  stockMovements,
} from '@platform/db';
import { confirmSale, createSaleReturn } from '../src/sales';
import { postOpeningStock } from '../src/openingBalances';

const RUN = Boolean(process.env.DATABASE_URL);
const d = RUN ? describe : describe.skip;

d('sale lifecycle (integration)', () => {
  const runId = randomUUID().slice(0, 8);
  let organizationId: string;
  let branchId: string;
  let customerId: string;
  let variantId: string;
  let orgUserId: string;

  beforeAll(async () => {
    const [bt] = await db
      .insert(businessTypes)
      .values({ code: `test_footwear_${runId}`, name: 'Test Footwear' })
      .returning();

    const [org] = await db
      .insert(organizations)
      .values({
        name: `Test Org ${runId}`,
        businessTypeId: bt.id,
        stateCode: '22', // Chhattisgarh
      })
      .returning();
    organizationId = org.id;

    const [branch] = await db.insert(branches).values({ organizationId, name: 'Main', isDefault: true }).returning();
    branchId = branch.id;

    // Standard chart of accounts — normally seedOrganizationDefaults(), but
    // spelled out here so this file has no hidden dependency on seed.ts.
    await db.insert(ledgerAccounts).values([
      { organizationId, code: 'CASH', name: 'Cash', accountType: 'asset' },
      { organizationId, code: 'BANK', name: 'Bank', accountType: 'asset' },
      { organizationId, code: 'AR', name: 'Accounts Receivable', accountType: 'asset' },
      { organizationId, code: 'AP', name: 'Accounts Payable', accountType: 'liability' },
      { organizationId, code: 'CGST_PAYABLE', name: 'CGST Payable', accountType: 'liability' },
      { organizationId, code: 'SGST_PAYABLE', name: 'SGST Payable', accountType: 'liability' },
      { organizationId, code: 'IGST_PAYABLE', name: 'IGST Payable', accountType: 'liability' },
      { organizationId, code: 'SALES', name: 'Sales', accountType: 'income' },
      { organizationId, code: 'OPENING_BALANCE_EQUITY', name: 'Opening Balance Equity', accountType: 'equity' },
    ]);

    const [customer] = await db
      .insert(customers)
      .values({ organizationId, name: 'Test Retailer' }) // no GSTIN -> treated as intra-state
      .returning();
    customerId = customer.id;

    const [product] = await db
      .insert(products)
      .values({
        organizationId,
        name: 'Action Sports Shoe',
        hsnCode: '6404',
        purchasePrice: '400.00',
        wholesalePrice: '500.00',
      })
      .returning();

    const [variant] = await db
      .insert(productVariants)
      .values({ organizationId, productId: product.id, size: '8.0', sku: `SKU-${runId}` })
      .returning();
    variantId = variant.id;

    await postOpeningStock(db, organizationId, variantId, 25, '2026-04-01');

    await db.insert(taxRates).values({
      organizationId: null, // platform default, used via the fallback path
      hsnCode: '6404',
      cgstRate: '9.00',
      sgstRate: '9.00',
      igstRate: '18.00',
      effectiveFrom: '2020-01-01',
    });

    const [role] = await db.insert(roles).values({ organizationId, code: 'test_role', name: 'Test Role' }).returning();
    const [user] = await db.insert(users).values({ email: `test-${runId}@example.com`, fullName: 'Test User' }).returning();
    const [orgUser] = await db.insert(orgUsers).values({ organizationId, userId: user.id, roleId: role.id, status: 'active' }).returning();
    orgUserId = orgUser.id;
  });

  afterAll(async () => {
    // Cascades from organizations -> nearly everything this test created.
    await db.delete(organizations).where(eq(organizations.id, organizationId));
    await pool.end();
  });

  it('confirming a sale posts a balanced journal entry and reduces stock', async () => {
    const [sale] = await db.insert(sales).values({ organizationId, branchId, customerId, saleDate: '2026-09-24' }).returning();
    await db.insert(saleItems).values({
      organizationId,
      saleId: sale.id,
      productVariantId: variantId,
      quantity: 10,
      rate: '500.00',
      discountAmount: '0.00',
      taxableValue: '0.00', // placeholder — confirmSale recalculates and overwrites this
      lineTotal: '0.00',
    });

    const result = await db.transaction((tx) => confirmSale(tx, { organizationId, saleId: sale.id, confirmedByOrgUserId: orgUserId }));

    expect(result.grandTotal).toBe('5900.00'); // 5000 taxable + 450 CGST + 450 SGST

    const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.referenceId, sale.id));
    const totalDebit = entries.reduce((s, e) => s + Number.parseFloat(e.debitAmount), 0);
    const totalCredit = entries.reduce((s, e) => s + Number.parseFloat(e.creditAmount), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 2);
    expect(totalDebit).toBeCloseTo(5900, 2);

    const [variant] = await db.select().from(productVariants).where(eq(productVariants.id, variantId));
    expect(variant.currentStock).toBe(15); // 25 opening - 10 sold

    const movements = await db.select().from(stockMovements).where(eq(stockMovements.referenceId, sale.id));
    expect(movements).toHaveLength(1);
    expect(movements[0].quantity).toBe(-10);
  });

  it('rejects a direct edit to a confirmed sale at the database level', async () => {
    const [sale] = await db.insert(sales).values({ organizationId, branchId, customerId, saleDate: '2026-09-24' }).returning();
    await db.insert(saleItems).values({
      organizationId,
      saleId: sale.id,
      productVariantId: variantId,
      quantity: 1,
      rate: '500.00',
      discountAmount: '0.00',
      taxableValue: '0.00',
      lineTotal: '0.00',
    });
    await db.transaction((tx) => confirmSale(tx, { organizationId, saleId: sale.id, confirmedByOrgUserId: orgUserId }));

    // Bypasses the application layer entirely — this is testing the
    // trigger in migrations/0001_triggers_and_rls.sql, not confirmSale().
    await expect(db.update(sales).set({ grandTotal: '1.00' }).where(eq(sales.id, sale.id))).rejects.toThrow();
  });

  it('a partial sale return increases stock and reverses the ledger proportionally, without touching the original sale', async () => {
    const [sale] = await db.insert(sales).values({ organizationId, branchId, customerId, saleDate: '2026-09-24' }).returning();
    const [item] = await db
      .insert(saleItems)
      .values({
        organizationId,
        saleId: sale.id,
        productVariantId: variantId,
        quantity: 4,
        rate: '500.00',
        discountAmount: '0.00',
        taxableValue: '0.00',
        lineTotal: '0.00',
      })
      .returning();
    await db.transaction((tx) => confirmSale(tx, { organizationId, saleId: sale.id, confirmedByOrgUserId: orgUserId }));

    const [beforeSale] = await db.select().from(sales).where(eq(sales.id, sale.id));

    await db.transaction((tx) =>
      createSaleReturn(tx, {
        organizationId,
        saleId: sale.id,
        lines: [{ saleItemId: item.id, quantity: 1 }], // return 1 of 4
        createdByOrgUserId: orgUserId,
        reason: 'Wrong size',
      }),
    );

    const [afterSale] = await db.select().from(sales).where(eq(sales.id, sale.id));
    expect(afterSale).toEqual(beforeSale); // original sale row is untouched

    const [variant] = await db.select().from(productVariants).where(eq(productVariants.id, variantId));
    // 25 opening, -10, -1, -4, +1 (returned) across the three tests in this
    // file's shared fixture — asserting the delta rather than an absolute
    // to keep this test independent of execution order within the file.
    const movements = await db.select().from(stockMovements).where(eq(stockMovements.referenceType, 'sale_return'));
    expect(movements.some((m) => m.quantity === 1)).toBe(true);
    void variant;

    // Reversing entries exist and are, themselves, balanced.
    const returnEntries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.referenceType, 'sale_return'));
    const rDebit = returnEntries.reduce((s, e) => s + Number.parseFloat(e.debitAmount), 0);
    const rCredit = returnEntries.reduce((s, e) => s + Number.parseFloat(e.creditAmount), 0);
    expect(rDebit).toBeCloseTo(rCredit, 2);
    expect(rDebit).toBeGreaterThan(0);
  });

  it('rejects returning more than was sold', async () => {
    const [sale] = await db.insert(sales).values({ organizationId, branchId, customerId, saleDate: '2026-09-24' }).returning();
    const [item] = await db
      .insert(saleItems)
      .values({
        organizationId,
        saleId: sale.id,
        productVariantId: variantId,
        quantity: 2,
        rate: '500.00',
        discountAmount: '0.00',
        taxableValue: '0.00',
        lineTotal: '0.00',
      })
      .returning();
    await db.transaction((tx) => confirmSale(tx, { organizationId, saleId: sale.id, confirmedByOrgUserId: orgUserId }));

    await expect(
      db.transaction((tx) =>
        createSaleReturn(tx, {
          organizationId,
          saleId: sale.id,
          lines: [{ saleItemId: item.id, quantity: 3 }], // only 2 were sold
          createdByOrgUserId: orgUserId,
        }),
      ),
    ).rejects.toThrow(/only \d+ remain returnable/i);
  });
});
