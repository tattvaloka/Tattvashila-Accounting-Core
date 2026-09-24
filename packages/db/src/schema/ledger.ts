import { sql, type SQL } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  numeric,
  integer,
  date,
  timestamp,
  unique,
  index,
  check,
  boolean,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { customers, suppliers } from './parties';
import { productVariants } from './products';
import { ledgerAccountTypeEnum, partyTypeEnum, stockMovementTypeEnum } from './enums';

/**
 * ledger_accounts — chart of accounts, seeded per org at creation. See
 * seed/seed.ts for the standard set, which now includes "Opening Balance
 * Equity" (used only to balance opening-balance postings).
 */
export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 20 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    accountType: ledgerAccountTypeEnum('account_type').notNull(),
    isSystem: boolean('is_system').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('ledger_accounts_org_code_uidx').on(t.organizationId, t.code),
    unique('ledger_accounts_org_id_uidx').on(t.organizationId, t.id),
  ],
);

/**
 * ledger_entries — immutable. This IS the source of truth for every
 * balance in the system; nothing computes or stores a balance
 * independently. Append-only: UPDATE/DELETE are revoked from the app role
 * in the migration. Corrections are always new, reversing entries.
 *
 * Sub-ledger model: rather than one ledger_account per customer/supplier
 * (which would bloat the chart of accounts), entries post to a single
 * control account (e.g. "Accounts Receivable") and carry customer_id /
 * supplier_id alongside it — standard control-account-plus-subsidiary-
 * ledger accounting. A customer's outstanding balance is
 * SUM(debit - credit) WHERE account = Accounts Receivable AND customer_id = X.
 */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').notNull(),
    customerId: uuid('customer_id'),
    supplierId: uuid('supplier_id'),
    partyType: partyTypeEnum('party_type').generatedAlwaysAs(
      (): SQL => sql`case
        when ${ledgerEntries.customerId} is not null then 'customer'::party_type_enum
        when ${ledgerEntries.supplierId} is not null then 'supplier'::party_type_enum
        else null
      end`,
    ),
    debitAmount: numeric('debit_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    creditAmount: numeric('credit_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    // Polymorphic across sale/purchase/payment/expense/opening_balance/
    // sale_return/purchase_return — a documented exception to the
    // composite-FK pattern; no single target table exists to reference.
    referenceType: varchar('reference_type', { length: 30 }).notNull(),
    referenceId: uuid('reference_id').notNull(),
    entryDate: date('entry_date').notNull(),
    description: varchar('description', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ledger_entries_org_account_date_idx').on(t.organizationId, t.accountId, t.entryDate),
    index('ledger_entries_org_customer_idx').on(t.organizationId, t.customerId),
    index('ledger_entries_org_supplier_idx').on(t.organizationId, t.supplierId),
    index('ledger_entries_reference_idx').on(t.referenceType, t.referenceId),

    check('ledger_entries_amounts_check', sql`${t.debitAmount} >= 0 and ${t.creditAmount} >= 0`),
    check(
      'ledger_entries_one_sided_check',
      sql`(${t.debitAmount} > 0 and ${t.creditAmount} = 0) or (${t.creditAmount} > 0 and ${t.debitAmount} = 0)`,
    ),
    check(
      'ledger_entries_one_party_check',
      sql`not (${t.customerId} is not null and ${t.supplierId} is not null)`,
    ),

    foreignKey({
      columns: [t.organizationId, t.accountId],
      foreignColumns: [ledgerAccounts.organizationId, ledgerAccounts.id],
      name: 'ledger_entries_account_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.organizationId, t.customerId],
      foreignColumns: [customers.organizationId, customers.id],
      name: 'ledger_entries_customer_fk',
    }),
    foreignKey({
      columns: [t.organizationId, t.supplierId],
      foreignColumns: [suppliers.organizationId, suppliers.id],
      name: 'ledger_entries_supplier_fk',
    }),
  ],
);
// Append-only: UPDATE/DELETE are revoked from the app role — see the
// migration. This is enforced at the database level, not just by convention.

/**
 * stock_movements — the *only* source of truth for stock, including
 * opening stock (movement_type = 'opening_balance'). product_variants
 * .current_stock is a cache maintained transactionally alongside every
 * insert here — see "Opening Stock Accounting Flow" in the design doc.
 * Append-only, same as ledger_entries.
 */
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    productVariantId: uuid('product_variant_id').notNull(),
    movementType: stockMovementTypeEnum('movement_type').notNull(),
    quantity: integer('quantity').notNull(), // signed: + in, - out
    referenceType: varchar('reference_type', { length: 30 }).notNull(),
    referenceId: uuid('reference_id').notNull(),
    movementDate: date('movement_date').notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('stock_movements_org_variant_date_idx').on(t.organizationId, t.productVariantId, t.movementDate),
    index('stock_movements_reference_idx').on(t.referenceType, t.referenceId),
    check('stock_movements_quantity_check', sql`${t.quantity} <> 0`),
    foreignKey({
      columns: [t.organizationId, t.productVariantId],
      foreignColumns: [productVariants.organizationId, productVariants.id],
      name: 'stock_movements_variant_fk',
    }).onDelete('restrict'),
  ],
);
