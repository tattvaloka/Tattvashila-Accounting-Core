import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  jsonb,
  numeric,
  integer,
  boolean,
  timestamp,
  unique,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations';

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    brand: varchar('brand', { length: 100 }),
    category: varchar('category', { length: 100 }),
    model: varchar('model', { length: 100 }),
    hsnCode: varchar('hsn_code', { length: 8 }),
    purchasePrice: numeric('purchase_price', { precision: 14, scale: 2 }).notNull(),
    wholesalePrice: numeric('wholesale_price', { precision: 14, scale: 2 }).notNull(),
    // Vertical-specific fields (ADR-002). Validated at the application layer
    // per business type — the Accounting Core never reads this column.
    attributes: jsonb('attributes').notNull().default({}),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('products_org_name_idx').on(t.organizationId, t.name),
    index('products_org_hsn_idx').on(t.organizationId, t.hsnCode),
    check('products_purchase_price_check', sql`${t.purchasePrice} >= 0`),
    check('products_wholesale_price_check', sql`${t.wholesalePrice} >= 0`),
  ],
);

/**
 * product_variants — the size-wise stock unit. "Action Sports Shoe / Size 8"
 * is its own row with its own current_stock. NOTE: there is no
 * `opening_stock` column — opening stock is a stock_movements row
 * (movement_type = 'opening_balance'), never an independent field.
 * See the "Opening Stock Accounting Flow" note in the design doc.
 */
export const productVariants = pgTable(
  'product_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    size: numeric('size', { precision: 3, scale: 1 }).notNull(), // ADR-004: half-size increments
    colour: varchar('colour', { length: 50 }),
    sku: varchar('sku', { length: 50 }).notNull(),
    // Cache maintained transactionally alongside stock_movements inserts —
    // never edited independently. A scheduled job reconciles it against
    // SUM(quantity) FROM stock_movements.
    currentStock: integer('current_stock').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('product_variants_org_sku_uidx').on(t.organizationId, t.sku),
    unique('product_variants_product_size_colour_uidx').on(t.productId, t.size, t.colour),
    unique('product_variants_org_id_uidx').on(t.organizationId, t.id),
    index('product_variants_org_product_idx').on(t.organizationId, t.productId),
    // Fixed in Revision 2 — the original expression referenced a
    // nonexistent "size2" column because it wasn't wrapped in a code span
    // and a Markdown renderer ate the "*". This is the real, correct
    // Postgres check: size must be a positive multiple of 0.5.
    check('product_variants_size_half_step_check', sql`${t.size} > 0 and (${t.size} * 10)::integer % 5 = 0`),
  ],
);
