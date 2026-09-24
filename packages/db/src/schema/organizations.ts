import { sql, type SQL } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  smallint,
  jsonb,
  unique,
  index,
  check,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { businessTypes, users, plans, permissions } from './platform';
import { orgUserStatusEnum, subscriptionStatusEnum, auditActionEnum } from './enums';

/**
 * organizations — the tenant root. Everything else in the system hangs off
 * organization_id, directly or (via composite FKs) transitively.
 */
export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 200 }).notNull(),
  businessTypeId: uuid('business_type_id')
    .notNull()
    .references(() => businessTypes.id, { onDelete: 'restrict' }),
  gstin: varchar('gstin', { length: 15 }),
  stateCode: varchar('state_code', { length: 2 }).notNull(), // decides CGST+SGST vs IGST
  defaultLanguage: varchar('default_language', { length: 10 }).notNull().default('en'),
  financialYearStartMonth: smallint('financial_year_start_month').notNull().default(4),
  invoicePrefix: varchar('invoice_prefix', { length: 10 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
// NOTE: `UNIQUE (gstin) WHERE gstin IS NOT NULL` is a partial index — added
// in the raw SQL migration, since Drizzle's table-level unique() has no
// WHERE clause.

/**
 * roles — replaces the old org_role_enum (ADR revision, review Item 5).
 * organization_id = NULL means a system/default role available to every
 * org. MVP seeds exactly four such rows (owner, manager, sales_staff,
 * accountant); per-org custom roles are schema-ready but not built yet.
 */
export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
    // Sentinel-coalesced key so two NULL-org rows with the same code are
    // correctly treated as duplicates (plain SQL NULL <> NULL would not
    // catch this with a bare UNIQUE(organization_id, code)).
    organizationKey: uuid('organization_key').generatedAlwaysAs(
      (): SQL => sql`coalesce(${roles.organizationId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
    code: varchar('code', { length: 50 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    isSystem: boolean('is_system').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('roles_org_key_code_uidx').on(t.organizationKey, t.code)],
);

/** permissions live in platform.ts; this is the many-to-many join. */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionId] })],
);

/**
 * org_users — organization membership. A user's role and status within
 * *this* org live here; the user's global identity lives in users.
 */
export const orgUsers = pgTable(
  'org_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    status: orgUserStatusEnum('status').notNull().default('invited'),
    invitedAt: timestamp('invited_at', { withTimezone: true }),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('org_users_org_user_uidx').on(t.organizationId, t.userId),
    // Supports composite FKs from sales/purchases/payments/etc.
    // created_by / confirmed_by, so "who did this" can never point at a
    // membership row from a different organization.
    unique('org_users_org_id_uidx').on(t.organizationId, t.id),
  ],
);

export const branches = pgTable(
  'branches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 150 }).notNull(),
    address: text('address'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('branches_org_name_uidx').on(t.organizationId, t.name),
    unique('branches_org_id_uidx').on(t.organizationId, t.id),
    // "exactly one default branch per org" is a partial unique index,
    // added in the raw SQL migration.
  ],
);

export const orgModules = pgTable(
  'org_modules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    moduleCode: varchar('module_code', { length: 50 }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    source: varchar('source', { length: 20 }).notNull().default('plan'),
  },
  (t) => [
    unique('org_modules_org_module_uidx').on(t.organizationId, t.moduleCode),
    check('org_modules_source_check', sql`${t.source} in ('plan','override')`),
  ],
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'restrict' }),
    status: subscriptionStatusEnum('status').notNull().default('trialing'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    paymentGatewayRef: varchar('payment_gateway_ref', { length: 255 }), // reserved — ADR-001
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('subscriptions_org_idx').on(t.organizationId),
    index('subscriptions_status_idx').on(t.status),
  ],
);

/** audit_log — append-only. UPDATE/DELETE are revoked in the migration. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'set null' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    entityType: varchar('entity_type', { length: 50 }).notNull(),
    entityId: uuid('entity_id').notNull(),
    action: auditActionEnum('action').notNull(),
    beforeData: jsonb('before_data'),
    afterData: jsonb('after_data'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_entity_idx').on(t.organizationId, t.entityType, t.entityId),
    index('audit_log_created_idx').on(t.createdAt),
  ],
);
