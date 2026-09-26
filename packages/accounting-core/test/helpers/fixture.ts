/**
 * Shared setup for the integration test files. Each test file gets its own
 * fresh organization (so tests in different files never share state or
 * collide on unique constraints), torn down in afterAll via cascade delete
 * on the organization row.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  db,
  organizations,
  businessTypes,
  branches,
  customers,
  suppliers,
  products,
  productVariants,
  taxRates,
  ledgerAccounts,
  roles,
  users,
  orgUsers,
} from '@platform/db';

export interface Fixture {
  organizationId: string;
  branchId: string;
  customerId: string;
  supplierId: string;
  productId: string;
  variantId: string; // HSN 6404, 18% GST, purchasePrice 400.00 / wholesalePrice 500.00
  orgUserId: string;
}

/** The full chart of accounts a real org gets via seedOrganizationDefaults()
 * — spelled out here (rather than importing the seed script) so this test
 * fixture has no hidden coupling to seed.ts's exact account list changing
 * independently of what the accounting-core code actually depends on. */
const CHART_OF_ACCOUNTS: Array<{ code: string; name: string; accountType: 'asset' | 'liability' | 'income' | 'expense' | 'equity' }> = [
  { code: 'CASH', name: 'Cash', accountType: 'asset' },
  { code: 'BANK', name: 'Bank', accountType: 'asset' },
  { code: 'AR', name: 'Accounts Receivable', accountType: 'asset' },
  { code: 'INVENTORY', name: 'Inventory', accountType: 'asset' },
  { code: 'INPUT_CGST', name: 'Input CGST Credit', accountType: 'asset' },
  { code: 'INPUT_SGST', name: 'Input SGST Credit', accountType: 'asset' },
  { code: 'INPUT_IGST', name: 'Input IGST Credit', accountType: 'asset' },
  { code: 'AP', name: 'Accounts Payable', accountType: 'liability' },
  { code: 'OUTPUT_CGST', name: 'Output CGST Payable', accountType: 'liability' },
  { code: 'OUTPUT_SGST', name: 'Output SGST Payable', accountType: 'liability' },
  { code: 'OUTPUT_IGST', name: 'Output IGST Payable', accountType: 'liability' },
  { code: 'SALES', name: 'Sales', accountType: 'income' },
  { code: 'COGS', name: 'Cost of Goods Sold', accountType: 'expense' },
  { code: 'EXPENSES', name: 'General Expenses', accountType: 'expense' },
  { code: 'OPENING_BALANCE_EQUITY', name: 'Opening Balance Equity', accountType: 'equity' },
];

export async function createFixture(label: string): Promise<Fixture> {
  const runId = `${label}-${randomUUID().slice(0, 8)}`;

  const [bt] = await db.insert(businessTypes).values({ code: `test_${runId}`, name: 'Test Footwear' }).returning();
  const [org] = await db
    .insert(organizations)
    .values({ name: `Test Org ${runId}`, businessTypeId: bt.id, stateCode: '22' }) // Chhattisgarh
    .returning();
  const organizationId = org.id;

  const [branch] = await db.insert(branches).values({ organizationId, name: 'Main', isDefault: true }).returning();

  await db.insert(ledgerAccounts).values(CHART_OF_ACCOUNTS.map((a) => ({ ...a, organizationId, isSystem: true })));

  const [customer] = await db.insert(customers).values({ organizationId, name: 'Test Retailer' }).returning();
  const [supplier] = await db.insert(suppliers).values({ organizationId, name: 'Test Supplier' }).returning();

  const [product] = await db
    .insert(products)
    .values({ organizationId, name: 'Action Sports Shoe', hsnCode: '6404', purchasePrice: '400.00', wholesalePrice: '500.00' })
    .returning();
  const [variant] = await db
    .insert(productVariants)
    .values({ organizationId, productId: product.id, size: '8.0', sku: `SKU-${runId}` })
    .returning();

  await db.insert(taxRates).values({
    organizationId: null, // platform default, exercises the fallback lookup path
    hsnCode: '6404',
    cgstRate: '9.00',
    sgstRate: '9.00',
    igstRate: '18.00',
    effectiveFrom: '2020-01-01',
  });

  const [role] = await db.insert(roles).values({ organizationId, code: 'test_role', name: 'Test Role' }).returning();
  const [user] = await db.insert(users).values({ email: `${runId}@example.com`, fullName: 'Test User' }).returning();
  const [orgUser] = await db.insert(orgUsers).values({ organizationId, userId: user.id, roleId: role.id, status: 'active' }).returning();

  return {
    organizationId,
    branchId: branch.id,
    customerId: customer.id,
    supplierId: supplier.id,
    productId: product.id,
    variantId: variant.id,
    orgUserId: orgUser.id,
  };
}

/** Cascades from the organization row to everything created above. */
export async function destroyFixture(f: Fixture): Promise<void> {
  await db.delete(organizations).where(eq(organizations.id, f.organizationId));
}
