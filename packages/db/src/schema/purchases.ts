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
import { organizations, orgUsers } from './organizations';
import { suppliers } from './parties';
import { productVariants } from './products';
import { taxRates } from './tax';
import { transactionStatusEnum } from './enums';

/**
 * purchases — mirrors sales.ts exactly (same Draft/Confirmed/Cancelled
 * lifecycle, same trigger behavior, same tax-snapshot columns), with
 * supplier_id in place of customer_id. See sales.ts for inline comments.
 */
export const purchases = pgTable(
  'purchases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    supplierId: uuid('supplier_id').notNull(),
    invoiceNumber: varchar('invoice_number', { length: 30 }),
    status: transactionStatusEnum('status').notNull().default('draft'),
    purchaseDate: date('purchase_date').notNull().defaultNow(),
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
    // Supports the payments -> purchases composite FK (see payments.ts)
    unique('purchases_org_id_supplier_uidx').on(t.organizationId, t.id, t.supplierId),
    unique('purchases_org_invoice_uidx').on(t.organizationId, t.invoiceNumber),
    index('purchases_org_supplier_idx').on(t.organizationId, t.supplierId),
    index('purchases_org_status_idx').on(t.organizationId, t.status),
    index('purchases_org_date_idx').on(t.organizationId, t.purchaseDate),
    check('purchases_payment_mode_check', sql`${t.paymentMode} is null or ${t.paymentMode} in ('cash','upi','bank','credit','split')`),

    foreignKey({
      columns: [t.organizationId, t.supplierId],
      foreignColumns: [suppliers.organizationId, suppliers.id],
      name: 'purchases_supplier_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.organizationId, t.createdBy],
      foreignColumns: [orgUsers.organizationId, orgUsers.id],
      name: 'purchases_created_by_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.organizationId, t.confirmedBy],
      foreignColumns: [orgUsers.organizationId, orgUsers.id],
      name: 'purchases_confirmed_by_fk',
    }).onDelete('set null'),
  ],
);

export const purchaseItems = pgTable(
  'purchase_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    purchaseId: uuid('purchase_id')
      .notNull()
      .references(() => purchases.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').notNull(),
    productVariantId: uuid('product_variant_id').notNull(),
    quantity: integer('quantity').notNull(),
    rate: numeric('rate', { precision: 14, scale: 2 }).notNull(),
    discountAmount: numeric('discount_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    taxableValue: numeric('taxable_value', { precision: 14, scale: 2 }).notNull(),
    taxRateId: uuid('tax_rate_id').references(() => taxRates.id, { onDelete: 'set null' }),
    cgstAmount: numeric('cgst_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    sgstAmount: numeric('sgst_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    igstAmount: numeric('igst_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    lineTotal: numeric('line_total', { precision: 14, scale: 2 }).notNull(),
  },
  (t) => [
    unique('purchase_items_org_id_uidx').on(t.organizationId, t.id), // supports purchase_return_items FK
    index('purchase_items_purchase_idx').on(t.purchaseId),
    index('purchase_items_variant_idx').on(t.productVariantId),
    check('purchase_items_quantity_check', sql`${t.quantity} > 0`),
    check('purchase_items_rate_check', sql`${t.rate} >= 0`),
    foreignKey({
      columns: [t.organizationId, t.productVariantId],
      foreignColumns: [productVariants.organizationId, productVariants.id],
      name: 'purchase_items_variant_fk',
    }).onDelete('restrict'),
  ],
);

export const purchaseReturns = pgTable(
  'purchase_returns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    purchaseId: uuid('purchase_id').notNull(),
    returnNumber: varchar('return_number', { length: 30 }).notNull(),
    returnDate: date('return_date').notNull().defaultNow(),
    reason: varchar('reason', { length: 500 }),
    totalAmount: numeric('total_amount', { precision: 14, scale: 2 }).notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('purchase_returns_org_number_uidx').on(t.organizationId, t.returnNumber),
    index('purchase_returns_purchase_idx').on(t.purchaseId),
    foreignKey({
      columns: [t.organizationId, t.purchaseId],
      foreignColumns: [purchases.organizationId, purchases.id],
      name: 'purchase_returns_purchase_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.organizationId, t.createdBy],
      foreignColumns: [orgUsers.organizationId, orgUsers.id],
      name: 'purchase_returns_created_by_fk',
    }).onDelete('restrict'),
  ],
);

export const purchaseReturnItems = pgTable(
  'purchase_return_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    purchaseReturnId: uuid('purchase_return_id')
      .notNull()
      .references(() => purchaseReturns.id, { onDelete: 'cascade' }),
    purchaseItemId: uuid('purchase_item_id').notNull(),
    quantity: integer('quantity').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  },
  (t) => [
    index('purchase_return_items_return_idx').on(t.purchaseReturnId),
    index('purchase_return_items_item_idx').on(t.purchaseItemId),
    check('purchase_return_items_quantity_check', sql`${t.quantity} > 0`),
    foreignKey({
      columns: [t.organizationId, t.purchaseItemId],
      foreignColumns: [purchaseItems.organizationId, purchaseItems.id],
      name: 'purchase_return_items_purchase_item_fk',
    }).onDelete('restrict'),
  ],
);
