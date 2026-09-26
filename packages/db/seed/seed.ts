/**
 * Platform-level reference data: business types, plans, permissions, and
 * the four MVP system roles with their permission sets. Run once per
 * environment: `npm run seed` (see package.json).
 *
 * Also exports seedOrganizationDefaults(), which every new organization
 * must run at creation time — it's what wires up the default branch and
 * the seeded chart of accounts described in the design doc. This is
 * schema/data setup only; it is NOT the AccountingEngine / business logic
 * layer, which is a later milestone.
 */
import { db } from '../src/client';
import {
  businessTypes,
  plans,
  permissions,
  roles,
  rolePermissions,
  branches,
  ledgerAccounts,
} from '../src/schema';

const PERMISSION_CODES = [
  'sales.create',
  'sales.confirm',
  'sales.return',
  'purchases.create',
  'purchases.confirm',
  'purchases.return',
  'payments.record',
  'products.manage',
  'customers.manage',
  'suppliers.manage',
  'reports.view',
  'org.manage_users',
  'org.manage_settings',
] as const;

// Illustrative starting matrix — not exhaustive, and easy to change later
// since it's data, not a schema migration (see "RBAC Schema").
const ROLE_PERMISSIONS: Record<string, readonly (typeof PERMISSION_CODES)[number][]> = {
  owner: [...PERMISSION_CODES],
  manager: [
    'sales.create', 'sales.confirm', 'sales.return',
    'purchases.create', 'purchases.confirm', 'purchases.return',
    'payments.record', 'products.manage', 'customers.manage', 'suppliers.manage',
    'reports.view',
  ],
  sales_staff: ['sales.create', 'sales.confirm', 'customers.manage', 'reports.view'],
  accountant: ['payments.record', 'reports.view', 'sales.confirm', 'purchases.confirm'],
};

async function seedPlatform() {
  await db
    .insert(businessTypes)
    .values({
      code: 'footwear_wholesale',
      name: 'Footwear Wholesale',
      config: {
        variantDimensions: ['size', 'colour'],
        terminology: { customer: 'Customer', supplier: 'Supplier' },
        enabledModules: ['sales', 'purchases', 'inventory', 'payments', 'reports'],
      },
    })
    .onConflictDoNothing();

  await db
    .insert(plans)
    .values({
      code: 'starter',
      name: 'Starter',
      price: '0',
      billingCycle: 'monthly',
      maxUsers: 5,
      maxBranches: 1,
      features: { modules: ['sales', 'purchases', 'inventory', 'payments', 'reports'] },
    })
    .onConflictDoNothing();

  await db
    .insert(permissions)
    .values(PERMISSION_CODES.map((code) => ({ code })))
    .onConflictDoNothing();

  const insertedPermissions = await db.select().from(permissions);
  const permissionIdByCode = new Map(insertedPermissions.map((p) => [p.code, p.id]));

  for (const roleCode of Object.keys(ROLE_PERMISSIONS)) {
    const [role] = await db
      .insert(roles)
      .values({ code: roleCode, name: roleCode.replace('_', ' '), isSystem: true })
      .onConflictDoNothing()
      .returning();

    if (!role) continue; // already seeded

    const grantedCodes = ROLE_PERMISSIONS[roleCode] ?? [];
    const rows = grantedCodes
      .map((code) => permissionIdByCode.get(code))
      .filter((id): id is string => Boolean(id))
      .map((permissionId) => ({ roleId: role.id, permissionId }));

    if (rows.length > 0) {
      await db.insert(rolePermissions).values(rows).onConflictDoNothing();
    }
  }

  console.log('Platform reference data seeded.');
}

/**
 * Standard chart of accounts, seeded per organization at creation.
 *
 * Accounting model: perpetual inventory. A confirmed purchase capitalizes
 * the goods into INVENTORY (asset) rather than an expense; a confirmed sale
 * relieves INVENTORY and recognizes COGS at the same time it recognizes
 * revenue. See the Milestone 3 correctness pass notes in
 * packages/accounting-core/README.md for the full flow.
 *
 * Input GST (paid on purchases, a recoverable credit) and Output GST
 * (collected on sales, owed to the government) are kept in separate
 * accounts — they are never netted against each other by this code.
 * "Opening Balance Equity" exists purely to balance opening-balance
 * postings for customers/suppliers/stock.
 */
const DEFAULT_LEDGER_ACCOUNTS = [
  { code: 'CASH', name: 'Cash', accountType: 'asset' as const },
  { code: 'BANK', name: 'Bank', accountType: 'asset' as const },
  { code: 'AR', name: 'Accounts Receivable', accountType: 'asset' as const },
  { code: 'INVENTORY', name: 'Inventory', accountType: 'asset' as const },
  { code: 'INPUT_CGST', name: 'Input CGST Credit', accountType: 'asset' as const },
  { code: 'INPUT_SGST', name: 'Input SGST Credit', accountType: 'asset' as const },
  { code: 'INPUT_IGST', name: 'Input IGST Credit', accountType: 'asset' as const },
  { code: 'AP', name: 'Accounts Payable', accountType: 'liability' as const },
  { code: 'OUTPUT_CGST', name: 'Output CGST Payable', accountType: 'liability' as const },
  { code: 'OUTPUT_SGST', name: 'Output SGST Payable', accountType: 'liability' as const },
  { code: 'OUTPUT_IGST', name: 'Output IGST Payable', accountType: 'liability' as const },
  { code: 'SALES', name: 'Sales', accountType: 'income' as const },
  { code: 'COGS', name: 'Cost of Goods Sold', accountType: 'expense' as const },
  { code: 'EXPENSES', name: 'General Expenses', accountType: 'expense' as const },
  { code: 'OPENING_BALANCE_EQUITY', name: 'Opening Balance Equity', accountType: 'equity' as const },
];

export async function seedOrganizationDefaults(organizationId: string) {
  await db.insert(branches).values({
    organizationId,
    name: 'Main Branch',
    isDefault: true,
  });

  await db.insert(ledgerAccounts).values(
    DEFAULT_LEDGER_ACCOUNTS.map((a) => ({ ...a, organizationId, isSystem: true })),
  );
}

if (require.main === module) {
  seedPlatform()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
