import { sql, type SQL } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  numeric,
  date,
  timestamp,
  unique,
  index,
  check,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { organizations, branches, orgUsers } from './organizations';
import { customers, suppliers } from './parties';
import { sales } from './sales';
import { purchases } from './purchases';
import { paymentDirectionEnum, partyTypeEnum } from './enums';

/**
 * payments — one unified table for customer receipts and supplier
 * payments (review Item 4: "keep the unified table if cleaner, but
 * strengthen integrity"). No trigger is used; three declarative pieces do
 * the whole job:
 *   1. party_type is GENERATED from customer_id/supplier_id — can't drift.
 *   2. payments_one_party CHECK — exactly one of the two is set.
 *   3. Composite FKs guarantee "party exists AND belongs to this org", and
 *      a *three-column* composite FK guarantees "the linked sale/purchase
 *      belongs to this org AND matches this payment's party" — Postgres
 *      skips a multi-column FK entirely when any referencing column is
 *      NULL (MATCH SIMPLE), so an unlinked or wrong-direction payment is
 *      automatically exempt from the constraint that doesn't apply to it.
 */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id'),
    supplierId: uuid('supplier_id'),
    partyType: partyTypeEnum('party_type').generatedAlwaysAs(
      (): SQL => sql`case
        when ${payments.customerId} is not null then 'customer'::party_type_enum
        when ${payments.supplierId} is not null then 'supplier'::party_type_enum
        else null
      end`,
    ),
    direction: paymentDirectionEnum('direction').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    paymentMode: varchar('payment_mode', { length: 20 }).notNull(),
    reference: varchar('reference', { length: 100 }),
    paymentDate: date('payment_date').notNull().defaultNow(),
    linkedSaleId: uuid('linked_sale_id'),
    linkedPurchaseId: uuid('linked_purchase_id'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payments_org_customer_idx').on(t.organizationId, t.customerId),
    index('payments_org_supplier_idx').on(t.organizationId, t.supplierId),
    index('payments_org_date_idx').on(t.organizationId, t.paymentDate),

    check('payments_amount_check', sql`${t.amount} > 0`),
    check('payments_mode_check', sql`${t.paymentMode} in ('cash','upi','bank','cheque')`),
    check(
      'payments_one_party_check',
      sql`(${t.customerId} is not null and ${t.supplierId} is null)
          or (${t.supplierId} is not null and ${t.customerId} is null)`,
    ),

    foreignKey({
      columns: [t.organizationId, t.customerId],
      foreignColumns: [customers.organizationId, customers.id],
      name: 'payments_customer_fk',
    }),
    foreignKey({
      columns: [t.organizationId, t.supplierId],
      foreignColumns: [suppliers.organizationId, suppliers.id],
      name: 'payments_supplier_fk',
    }),
    // Skipped automatically (MATCH SIMPLE) when linkedSaleId or customerId
    // is null — i.e. for unlinked payments and for every supplier payment.
    foreignKey({
      columns: [t.organizationId, t.linkedSaleId, t.customerId],
      foreignColumns: [sales.organizationId, sales.id, sales.customerId],
      name: 'payments_linked_sale_fk',
    }),
    // Skipped automatically when linkedPurchaseId or supplierId is null.
    foreignKey({
      columns: [t.organizationId, t.linkedPurchaseId, t.supplierId],
      foreignColumns: [purchases.organizationId, purchases.id, purchases.supplierId],
      name: 'payments_linked_purchase_fk',
    }),
    foreignKey({
      columns: [t.organizationId, t.createdBy],
      foreignColumns: [orgUsers.organizationId, orgUsers.id],
      name: 'payments_created_by_fk',
    }).onDelete('restrict'),
  ],
);

export const expenses = pgTable(
  'expenses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id'),
    category: varchar('category', { length: 100 }).notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    expenseDate: date('expense_date').notNull().defaultNow(),
    paymentMode: varchar('payment_mode', { length: 20 }).notNull(),
    description: varchar('description', { length: 500 }),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('expenses_org_date_idx').on(t.organizationId, t.expenseDate),
    check('expenses_amount_check', sql`${t.amount} > 0`),
    foreignKey({
      columns: [t.organizationId, t.branchId],
      foreignColumns: [branches.organizationId, branches.id],
      name: 'expenses_branch_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [t.organizationId, t.createdBy],
      foreignColumns: [orgUsers.organizationId, orgUsers.id],
      name: 'expenses_created_by_fk',
    }).onDelete('restrict'),
  ],
);
