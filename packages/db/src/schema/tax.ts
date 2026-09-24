import { sql, type SQL } from 'drizzle-orm';
import { pgTable, uuid, varchar, numeric, date, timestamp, unique, index, check, integer } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';

/**
 * tax_rates — organization_id = NULL means a platform default usable by any
 * org; a non-null row is that org's override for the same HSN/date range.
 * Rates are never hard-coded elsewhere (ADR-005) — every calculation looks
 * them up here.
 *
 * Overlap prevention: an EXCLUDE USING gist constraint (organization_key,
 * hsn_code, daterange) is added in migrations/0000_init.sql — Drizzle's
 * schema builder has no exclusion-constraint helper, so this one lives only
 * in the raw SQL migration, not here. See "Tax-Rate Versioning Mechanism".
 */
export const taxRates = pgTable(
  'tax_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
    organizationKey: uuid('organization_key').generatedAlwaysAs(
      (): SQL => sql`coalesce(${taxRates.organizationId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
    hsnCode: varchar('hsn_code', { length: 8 }).notNull(),
    description: varchar('description', { length: 150 }),
    cgstRate: numeric('cgst_rate', { precision: 5, scale: 2 }).notNull(),
    sgstRate: numeric('sgst_rate', { precision: 5, scale: 2 }).notNull(),
    igstRate: numeric('igst_rate', { precision: 5, scale: 2 }).notNull(),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'), // NULL = open-ended / still active
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('tax_rates_key_hsn_from_idx').on(t.organizationKey, t.hsnCode, t.effectiveFrom),
    check('tax_rates_igst_check', sql`${t.igstRate} = ${t.cgstRate} + ${t.sgstRate}`),
    check('tax_rates_date_check', sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`),
    // tax_rates_no_overlap EXCLUDE constraint: see migrations/0000_init.sql
  ],
);

export const invoiceSequences = pgTable(
  'invoice_sequences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    sequenceType: varchar('sequence_type', { length: 20 }).notNull(),
    financialYear: varchar('financial_year', { length: 9 }).notNull(), // e.g. '2026-2027'
    prefix: varchar('prefix', { length: 10 }),
    lastNumber: integer('last_number').notNull().default(0),
  },
  (t) => [
    unique('invoice_sequences_org_type_fy_uidx').on(t.organizationId, t.sequenceType, t.financialYear),
    check(
      'invoice_sequences_type_check',
      sql`${t.sequenceType} in ('sale','purchase','sale_return','purchase_return')`,
    ),
  ],
);
