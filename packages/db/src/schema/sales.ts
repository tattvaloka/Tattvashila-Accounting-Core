import { sql } from 'drizzle-orm';
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
  foreignKey,
} from 'drizzle-orm/pg-core';
import { organizations, branches, orgUsers } from './organizations';
import { customers } from './parties';
import { productVariants } from './products';
import { taxRates } from './tax';
import { transactionStatusEnum } from './enums';

/**
 * sales — Draft / Confirmed / Cancelled lifecycle (ADR-006). A BEFORE UPDATE
 * trigger (see migrations/0000_init.sql) rejects any change to financial
 * columns once status = 'confirmed', and rejects confirmed -> cancelled
 * outright: reversing a confirmed sale is always a sale_return, never an
 * edit or a cancel.
 */
export const sales = pgTable(
  'sales',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    invoiceNumber: varchar('invoice_number', { length: 30 }), // assigned only on Confirm
    status: transactionStatusEnum('status').notNull().default('draft'),
    saleDate: date('sale_date').notNull().defaultNow(),
    subtotal: numeric('subtotal', { precision: 14, scale: 2 }).notNull().default('0'),
    discountTotal: numeric('discount_total', { precision: 14, scale: 2 }).notNull().default('0'),
    taxableTotal: numeric('taxable_total', { precision: 14, scale: 2 }).notNull().default('0'),
    cgstTotal: numeric('cgst_total', { precision: 14, scale: 2 }).notNull().default('0'),
    sgstTotal: numeric('sgst_total', { precision: 14, scale: 2 }).notNull().default('0'),
    igstTotal: numeric('igst_total', { precision: 14, scale: 2 }).notNull().default('0'),
    roundingAdjustment: numeric('rounding_adjustment', { precision: 14, scale: 2 }).notNull().default('0'),
    grandTotal: numeric('grand_total', { precision: 14, scale: 2 }).notNull().default('0'),
    paymentMode: varchar('payment_mode', { length: 20 }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedBy: uuid('confirmed_by'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Supports the payments -> sales composite FK (see payments.ts)
    unique('sales_org_id_uidx').on(t.organizationId, t.id),
    unique('sales_org_id_customer_uidx').on(t.organizationId, t.id, t.customerId),
    unique('sales_org_invoice_uidx').on(t.organizationId, t.invoiceNumber),
    index('sales_org_customer_idx').on(t.organizationId, t.customerId),
    index('sales_org_status_idx').on(t.organizationId, t.status),
    index('sales_org_date_idx').on(t.organizationId, t.saleDate),
    check('sales_payment_mode_check', sql`${t.paymentMode} is null or ${t.paymentMode} in ('cash','upi','bank','credit','split')`),

    foreignKey({
      columns: [t.organizationId, t.branchId],
      foreignColumns: [branches.organizationId, branches.id],
      name: 'sales_branch_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.organizationId, t.customerId],
      foreignColumns: [customers.organizationId, customers.id],
      name: 'sales_customer_fk',
    }).onDelete('restrict'),
    // created_by / confirmed_by reference org_users (not users directly) so
    // "who did this" can never point at a membership in another org.
    foreignKey({
      columns: [t.organizationId, t.createdBy],
      foreignColumns: [orgUsers.organizationId, orgUsers.id],
      name: 'sales_created_by_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.organizationId, t.confirmedBy],
      foreignColumns: [orgUsers.organizationId, orgUsers.id],
      name: 'sales_confirmed_by_fk',
    }).onDelete('set null'),
  ],
);

export const saleItems = pgTable(
  'sale_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => sales.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').notNull(),
    productVariantId: uuid('product_variant_id').notNull(),
    quantity: integer('quantity').notNull(),
    rate: numeric('rate', { precision: 14, scale: 2 }).notNull(),
    discountAmount: numeric('discount_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    taxableValue: numeric('taxable_value', { precision: 14, scale: 2 }).notNull(),
    // Cost of goods sold for this line, frozen at Confirm time from
    // product.purchasePrice — see migrations/0002_sale_item_cogs.sql for
    // why this can't just be recomputed later (returns need the figure
    // that was actually posted, not today's price).
    cogsAmount: numeric('cogs_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    // Audit pointer only — a documented exception to the composite-FK
    // pattern, because tax_rates can be org-NULL (platform default). The
    // amounts below are the financial truth, computed once at Confirm and
    // never recalculated on read.
    taxRateId: uuid('tax_rate_id').references(() => taxRates.id, { onDelete: 'set null' }),
    cgstAmount: numeric('cgst_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    sgstAmount: numeric('sgst_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    igstAmount: numeric('igst_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    lineTotal: numeric('line_total', { precision: 14, scale: 2 }).notNull(),
  },
  (t) => [
    unique('sale_items_org_id_uidx').on(t.organizationId, t.id), // supports sale_return_items FK
    index('sale_items_sale_idx').on(t.saleId),
    index('sale_items_variant_idx').on(t.productVariantId),
    check('sale_items_quantity_check', sql`${t.quantity} > 0`),
    check('sale_items_rate_check', sql`${t.rate} >= 0`),
    foreignKey({
      columns: [t.organizationId, t.productVariantId],
      foreignColumns: [productVariants.organizationId, productVariants.id],
      name: 'sale_items_variant_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * sale_returns / sale_return_items — post immediately (no Draft state for
 * returns, per the approved decision). The original `sales` row is never
 * touched; see "Return Accounting Flow" for the full posting behavior.
 */
export const saleReturns = pgTable(
  'sale_returns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    saleId: uuid('sale_id').notNull(),
    returnNumber: varchar('return_number', { length: 30 }).notNull(),
    returnDate: date('return_date').notNull().defaultNow(),
    reason: varchar('reason', { length: 500 }),
    totalAmount: numeric('total_amount', { precision: 14, scale: 2 }).notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('sale_returns_org_number_uidx').on(t.organizationId, t.returnNumber),
    index('sale_returns_sale_idx').on(t.saleId),
    foreignKey({
      columns: [t.organizationId, t.saleId],
      foreignColumns: [sales.organizationId, sales.id],
      name: 'sale_returns_sale_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.organizationId, t.createdBy],
      foreignColumns: [orgUsers.organizationId, orgUsers.id],
      name: 'sale_returns_created_by_fk',
    }).onDelete('restrict'),
  ],
);

export const saleReturnItems = pgTable(
  'sale_return_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Denormalized (like sale_items.organizationId) so every tenant-scoped
    // table carries organization_id directly — needed for RLS and for the
    // composite FK below, not just reachable via a join.
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    saleReturnId: uuid('sale_return_id')
      .notNull()
      .references(() => saleReturns.id, { onDelete: 'cascade' }),
    saleItemId: uuid('sale_item_id').notNull(),
    quantity: integer('quantity').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  },
  (t) => [
    index('sale_return_items_return_idx').on(t.saleReturnId),
    index('sale_return_items_item_idx').on(t.saleItemId),
    check('sale_return_items_quantity_check', sql`${t.quantity} > 0`),
    // "cumulative returned qty per sale_item never exceeds the original" is
    // an application-layer check (needs an aggregate across sibling rows,
    // which a CHECK constraint cannot express).
    foreignKey({
      columns: [t.organizationId, t.saleItemId],
      foreignColumns: [saleItems.organizationId, saleItems.id],
      name: 'sale_return_items_sale_item_fk',
    }).onDelete('restrict'),
  ],
);
