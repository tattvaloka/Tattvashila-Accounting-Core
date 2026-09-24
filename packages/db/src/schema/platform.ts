import { pgTable, uuid, varchar, jsonb, timestamp, numeric, integer } from 'drizzle-orm/pg-core';
import { billingCycleEnum } from './enums';

/**
 * business_types — platform-level reference data. One row per vertical
 * (footwear_wholesale today; mobile/pharmacy/etc. later). `config` holds
 * only *declarative* things: terminology, variant dimensions, enabled
 * modules, dashboard/report set. Behavioral differences belong in a
 * business-module package, never in here — see ADR-002.
 */
export const businessTypes = pgTable('business_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: varchar('code', { length: 50 }).notNull().unique(),
  name: varchar('name', { length: 100 }).notNull(),
  config: jsonb('config').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * users — global identity. Org membership (and role) lives in org_users,
 * never here, because one person can belong to more than one organization.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  phone: varchar('phone', { length: 15 }),
  authProviderId: varchar('auth_provider_id', { length: 255 }), // Supabase Auth id — ADR-001
  fullName: varchar('full_name', { length: 150 }).notNull(),
  preferredLanguage: varchar('preferred_language', { length: 10 }).notNull().default('en'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const plans = pgTable('plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: varchar('code', { length: 50 }).notNull().unique(),
  name: varchar('name', { length: 100 }).notNull(),
  price: numeric('price', { precision: 10, scale: 2 }).notNull(),
  billingCycle: billingCycleEnum('billing_cycle').notNull(),
  maxUsers: integer('max_users').notNull(),
  maxBranches: integer('max_branches').notNull(),
  features: jsonb('features').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * permissions — the static catalogue of things a role can be granted.
 * Extended by adding rows, never by a schema migration. See RBAC Schema.
 */
export const permissions = pgTable('permissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: varchar('code', { length: 100 }).notNull().unique(), // e.g. 'sales.confirm'
  description: varchar('description', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
