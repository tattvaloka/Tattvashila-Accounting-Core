import { pgTable, uuid, varchar, text, numeric, boolean, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 150 }).notNull(),
    shopName: varchar('shop_name', { length: 150 }),
    mobile: varchar('mobile', { length: 15 }),
    address: text('address'),
    gstin: varchar('gstin', { length: 15 }),
    // Onboarding-only. Consumed once, at creation, to post a ledger entry
    // (see "Opening Balance Accounting Flow"). Never read again after that —
    // the customer's real outstanding balance is always derived from
    // ledger_entries.
    openingBalanceInput: numeric('opening_balance_input', { precision: 14, scale: 2 }),
    creditLimit: numeric('credit_limit', { precision: 14, scale: 2 }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('customers_org_id_uidx').on(t.organizationId, t.id),
    index('customers_org_mobile_idx').on(t.organizationId, t.mobile),
    index('customers_org_name_idx').on(t.organizationId, t.name),
  ],
);

export const suppliers = pgTable(
  'suppliers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 150 }).notNull(),
    contact: varchar('contact', { length: 15 }),
    address: text('address'),
    gstin: varchar('gstin', { length: 15 }),
    openingBalanceInput: numeric('opening_balance_input', { precision: 14, scale: 2 }), // see customers.openingBalanceInput
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('suppliers_org_id_uidx').on(t.organizationId, t.id),
    index('suppliers_org_contact_idx').on(t.organizationId, t.contact),
    index('suppliers_org_name_idx').on(t.organizationId, t.name),
  ],
);
