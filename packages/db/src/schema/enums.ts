import { pgEnum } from 'drizzle-orm/pg-core';

// NOTE: org_role_enum from an earlier draft was removed — RBAC is now data
// (roles / permissions / role_permissions tables), not a Postgres enum.
// See organizations.ts and the "RBAC Schema" section of the design doc.

export const orgUserStatusEnum = pgEnum('org_user_status_enum', [
  'invited',
  'active',
  'disabled',
]);

export const billingCycleEnum = pgEnum('billing_cycle_enum', [
  'monthly',
  'annual',
  'one_time',
]);

export const subscriptionStatusEnum = pgEnum('subscription_status_enum', [
  'trialing',
  'active',
  'past_due',
  'cancelled',
]);

export const transactionStatusEnum = pgEnum('transaction_status_enum', [
  'draft',
  'confirmed',
  'cancelled',
]);

export const paymentDirectionEnum = pgEnum('payment_direction_enum', ['in', 'out']);

// Kept as a real enum type because it is used as the *type* of a generated
// column (payments.party_type, ledger_entries.party_type) — the value itself
// is always derived, never written directly. See payments.ts / ledger.ts.
export const partyTypeEnum = pgEnum('party_type_enum', ['customer', 'supplier']);

export const ledgerAccountTypeEnum = pgEnum('ledger_account_type_enum', [
  'asset',
  'liability',
  'income',
  'expense',
  'equity',
]);

export const stockMovementTypeEnum = pgEnum('stock_movement_type_enum', [
  'opening_balance',
  'purchase',
  'sale',
  'sale_return',
  'purchase_return',
  'adjustment',
]);

export const auditActionEnum = pgEnum('audit_action_enum', [
  'create',
  'update',
  'delete',
  'confirm',
  'cancel',
  'reverse',
]);
