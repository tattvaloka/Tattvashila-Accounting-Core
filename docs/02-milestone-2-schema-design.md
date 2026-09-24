# Milestone 2 — Database Schema Design (Revision 2)
### Derived from the Technical Foundation Plan + ADR-001 – ADR-006
**Status: proposal for review. No migration has been written yet.**

## What changed since Revision 1

1. **Footwear size constraint fixed** — the original expression rendered incorrectly because it wasn't in a code span and Markdown ate the `*`. Corrected and shown in fenced code below.
2. **`opening_stock` removed** from `product_variants`. Opening stock is now a `stock_movements` row (`movement_type = 'opening_balance'`) — one source of truth, no exceptions.
3. **`opening_balance` removed** from `customers`/`suppliers`. Replaced by a write-once `opening_balance_input` field that generates a real `ledger_entries` row at creation; outstanding balances are always derived from the ledger afterward.
4. **Payment party integrity is now database-enforced**, not just application-checked — via generated columns and composite foreign keys (no trigger needed; see §Payment Integrity Mechanism).
5. **RBAC reworked** from a fixed enum into a small `roles` / `permissions` / `role_permissions` set (see §RBAC Schema).
6. **Tax-rate overlap is now prevented by a database exclusion constraint**, not just convention (see §Tax-Rate Versioning Mechanism).
7. **Config-vs-code boundary reaffirmed** — no behavioral change, restated explicitly below.
8. **Tenant-consistency is now enforced by composite foreign keys** across nearly every cross-table reference, including `created_by`/`confirmed_by` (previously an accepted gap — now closed by referencing `org_users` instead of `users`).
9. **Return accounting flow fully specified** (see §Return Accounting Flow).

---

## Conventions & Extensions

Same base conventions as Revision 1 (UUID PKs, `numeric(14,2)` money, `numeric(5,2)` rates, `date` for business dates vs. `timestamptz` for audit timestamps). Two extensions are now required:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- exclusion constraint on tax_rates
```

## Tenant-Consistency Strategy

Every tenant-scoped table carries `UNIQUE (organization_id, id)` in addition to its primary key (omitted from each table below for brevity — assume it's there). Any column referencing another tenant-scoped table is declared as a **composite foreign key**:

```sql
-- pattern used throughout instead of a plain "x_id references other_table(id)"
FOREIGN KEY (organization_id, x_id) REFERENCES other_table (organization_id, id)
```

This makes it a database-level error, not just an RLS-visibility issue, to attach a row to an entity from another organization. Applied to: `sale.customer_id`, `sale.branch_id`, `sale_item.product_variant_id`, `purchase.supplier_id`, `purchase_item.product_variant_id`, `sale_return.sale_id`, `sale_return_item.sale_item_id`, `purchase_return.purchase_id`, `purchase_return_item.purchase_item_id`, `payment.customer_id`/`supplier_id`, `ledger_entry.account_id`/`customer_id`/`supplier_id`, `stock_movement.product_variant_id`, and — new in this revision — `created_by`/`confirmed_by` on every transactional table, which now reference **`org_users`** instead of `users` (see below), closing the gap Item 8 flagged.

**Three narrow, documented exceptions**, each with a stated reason:
- `sale_items.tax_rate_id` / `purchase_items.tax_rate_id` — `tax_rates` can be org-`NULL` (platform default), so a strict composite match would reject legitimate shared defaults. Kept as a plain FK; it's an audit pointer, not the financial truth (the actual `cgst_amount` etc. are stored separately).
- `ledger_entries.reference_id` — polymorphic (sale, purchase, payment, expense, opening balance, return); no single target table exists to reference. Standard accepted limitation for a ledger/journal table.
- `audit_log.actor_user_id` — nullable, because `audit_log.organization_id` is nullable for platform-level actions with no org to key against; references `users` directly.

---

## Enums

```
org_user_status_enum      invited | active | disabled
billing_cycle_enum        monthly | annual | one_time
subscription_status_enum  trialing | active | past_due | cancelled
transaction_status_enum   draft | confirmed | cancelled
payment_direction_enum    in | out
party_type_enum           customer | supplier      -- now a generated column, see Payment Integrity
ledger_account_type_enum  asset | liability | income | expense | equity
stock_movement_type_enum  opening_balance | purchase | sale | sale_return | purchase_return | adjustment
audit_action_enum         create | update | delete | confirm | cancel | reverse
```

`org_role_enum` from Revision 1 is **removed** — roles are now data, not a type (see §RBAC Schema).

---

## Platform-level tables

#### `business_types`, `users`, `plans` — unchanged from Revision 1.

#### `permissions` (new)
| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| code | varchar(100) | NOT NULL, UNIQUE (e.g. `sales.create`, `sales.confirm`, `reports.view`) |
| description | varchar(255) | NULL |
| created_at | timestamptz | NOT NULL |

---

## Organization & tenancy tables

#### `organizations` — unchanged.

#### `roles` (new)
| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| organization_id | uuid | NULL — NULL means a system/default role available to every org; FK → organizations, CASCADE |
| organization_key | uuid | `GENERATED ALWAYS AS (COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED` — see note below |
| code | varchar(50) | NOT NULL |
| name | varchar(100) | NOT NULL |
| is_system | boolean | NOT NULL, default true |
| created_at | timestamptz | NOT NULL |

`UNIQUE (organization_key, code)`. A plain `UNIQUE(organization_id, code)` would silently allow duplicate `NULL`-org rows with the same code, because SQL treats two `NULL`s as unequal — the generated sentinel column closes that gap (same trick used for `tax_rates` below).

#### `role_permissions` (new)
| Column | Type | Constraints |
|---|---|---|
| role_id | uuid | NOT NULL, FK → roles, CASCADE |
| permission_id | uuid | NOT NULL, FK → permissions, CASCADE |

`PRIMARY KEY (role_id, permission_id)`

#### `org_users`
| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| organization_id | uuid | NOT NULL, FK → organizations, CASCADE |
| user_id | uuid | NOT NULL, FK → users, CASCADE |
| role_id | uuid | NOT NULL, FK → roles, **RESTRICT** (a role in active use can't be deleted) |
| status | org_user_status_enum | NOT NULL, default `invited` |
| invited_at, joined_at | timestamptz | NULL |
| created_at | timestamptz | NOT NULL |

`UNIQUE (organization_id, user_id)`. MVP note: since every seeded role has `organization_id = NULL`, `role_id` is a plain FK here for now — enforcing "a custom org-specific role must belong to the same org" is deferred until that feature is actually built (see §RBAC Schema).

#### `branches`, `org_modules`, `subscriptions`, `audit_log` — unchanged from Revision 1.

---

## Product & inventory tables

#### `products` — unchanged.

#### `product_variants`
| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| product_id | uuid | NOT NULL, FK → products, CASCADE |
| organization_id | uuid | NOT NULL, FK → organizations, CASCADE |
| size | numeric(3,1) | NOT NULL |
| colour | varchar(50) | NULL |
| sku | varchar(50) | NOT NULL |
| current_stock | integer | NOT NULL, default 0 — cache, see §Opening Stock Accounting Flow |
| created_at, updated_at | timestamptz | NOT NULL |

Corrected size constraint (this is the fix for Item 1 — note the fenced code, not a bare table cell, so nothing gets eaten):
```sql
ALTER TABLE product_variants
  ADD CONSTRAINT product_variants_size_half_step
  CHECK (size > 0 AND (size * 10)::integer % 5 = 0);
```
This allows 6, 6.5, 7, 7.5 … and rejects anything not on a half-size step. `numeric` in Postgres is exact decimal arithmetic, so there's no floating-point ambiguity.

`UNIQUE (organization_id, sku)` · `UNIQUE (product_id, size, colour)` · Index `(organization_id, product_id)`. **`opening_stock` is gone** — see the flow below.

---

## Party tables

#### `customers`
| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| organization_id | uuid | NOT NULL, FK → organizations, CASCADE |
| name | varchar(150) | NOT NULL |
| shop_name | varchar(150) | NULL |
| mobile | varchar(15) | NULL |
| address | text | NULL |
| gstin | varchar(15) | NULL |
| opening_balance_input | numeric(14,2) | NULL — **onboarding-only**, see §Opening Balance Accounting Flow; never read again after the org is initialized |
| credit_limit | numeric(14,2) | NULL |
| is_active | boolean | NOT NULL, default true |
| created_at, updated_at | timestamptz | NOT NULL |

Index `(organization_id, mobile)` · `(organization_id, name)`.

#### `suppliers` — same shape, `contact varchar(15)` instead of `mobile`, no `credit_limit`, same `opening_balance_input` treatment.

---

## Tax tables

#### `tax_rates`
| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| organization_id | uuid | NULL — NULL = platform default, usable by any org; FK → organizations, CASCADE |
| organization_key | uuid | `GENERATED ALWAYS AS (COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED` |
| hsn_code | varchar(8) | NOT NULL |
| description | varchar(150) | NULL |
| cgst_rate, sgst_rate, igst_rate | numeric(5,2) | NOT NULL |
| effective_from | date | NOT NULL |
| effective_to | date | NULL — open-ended if null |
| created_at | timestamptz | NOT NULL |

```sql
ALTER TABLE tax_rates ADD CONSTRAINT tax_rates_igst_check
  CHECK (igst_rate = cgst_rate + sgst_rate);
ALTER TABLE tax_rates ADD CONSTRAINT tax_rates_date_check
  CHECK (effective_to IS NULL OR effective_to >= effective_from);
ALTER TABLE tax_rates ADD CONSTRAINT tax_rates_no_overlap
  EXCLUDE USING gist (
    organization_key WITH =,
    hsn_code WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  );
```
Full detail in §Tax-Rate Versioning Mechanism. Index `(organization_key, hsn_code, effective_from)`.

#### `invoice_sequences` — unchanged.

---

## Sales tables

#### `sales`
Same columns as Revision 1, with these FK changes:
- `branch_id`: `FOREIGN KEY (organization_id, branch_id) REFERENCES branches (organization_id, id)`
- `customer_id`: `FOREIGN KEY (organization_id, customer_id) REFERENCES customers (organization_id, id)`
- `created_by`, `confirmed_by`: now reference **`org_users`**, not `users` — `FOREIGN KEY (organization_id, created_by) REFERENCES org_users (organization_id, id)`, same for `confirmed_by` (nullable)

New supporting constraint needed for the payments FK further down:
```sql
ALTER TABLE sales ADD CONSTRAINT sales_org_id_customer_uidx
  UNIQUE (organization_id, id, customer_id);
```

#### `sale_items`
Unchanged columns; `product_variant_id` becomes a composite FK: `FOREIGN KEY (organization_id, product_variant_id) REFERENCES product_variants (organization_id, id)`. `tax_rate_id` stays a plain FK (documented exception above).

#### `sale_returns`, `sale_return_items`
Unchanged columns; `sale_id`/`sale_item_id` become composite FKs the same way. `created_by` on `sale_returns` now references `org_users` like `sales.created_by`. Accounting behavior fully specified in §Return Accounting Flow.

## Purchase tables

`purchases`, `purchase_items`, `purchase_returns`, `purchase_return_items` mirror the sales tables column-for-column with `supplier_id` in place of `customer_id`, including the matching `UNIQUE (organization_id, id, supplier_id)` on `purchases` and the same `org_users`-based `created_by`/`confirmed_by`.

---

## Money-movement tables

#### `payments`
| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| organization_id | uuid | NOT NULL, FK → organizations, CASCADE |
| customer_id | uuid | NULL |
| supplier_id | uuid | NULL |
| party_type | party_type_enum | `GENERATED ALWAYS AS (CASE WHEN customer_id IS NOT NULL THEN 'customer'::party_type_enum WHEN supplier_id IS NOT NULL THEN 'supplier'::party_type_enum ELSE NULL END) STORED` |
| direction | payment_direction_enum | NOT NULL |
| amount | numeric(14,2) | NOT NULL, CHECK > 0 |
| payment_mode | varchar(20) | NOT NULL, CHECK IN ('cash','upi','bank','cheque') |
| reference | varchar(100) | NULL |
| payment_date | date | NOT NULL, default current_date |
| linked_sale_id | uuid | NULL |
| linked_purchase_id | uuid | NULL |
| created_by | uuid | NOT NULL, FK → org_users, RESTRICT |
| created_at | timestamptz | NOT NULL |

```sql
ALTER TABLE payments ADD CONSTRAINT payments_one_party
  CHECK (
    (customer_id IS NOT NULL AND supplier_id IS NULL) OR
    (supplier_id IS NOT NULL AND customer_id IS NULL)
  );

ALTER TABLE payments ADD CONSTRAINT payments_customer_fk
  FOREIGN KEY (organization_id, customer_id) REFERENCES customers (organization_id, id);
ALTER TABLE payments ADD CONSTRAINT payments_supplier_fk
  FOREIGN KEY (organization_id, supplier_id) REFERENCES suppliers (organization_id, id);

ALTER TABLE payments ADD CONSTRAINT payments_linked_sale_fk
  FOREIGN KEY (organization_id, linked_sale_id, customer_id)
  REFERENCES sales (organization_id, id, customer_id);
ALTER TABLE payments ADD CONSTRAINT payments_linked_purchase_fk
  FOREIGN KEY (organization_id, linked_purchase_id, supplier_id)
  REFERENCES purchases (organization_id, id, supplier_id);
```
Full reasoning in §Payment Integrity Mechanism. Index `(organization_id, customer_id)` · `(organization_id, supplier_id)` · `(organization_id, payment_date)`.

#### `expenses` — unchanged, `created_by` now references `org_users`.

---

## Ledger & stock

#### `ledger_accounts` — unchanged, except the seeded set now includes **"Opening Balance Equity"** (`account_type = 'equity'`), used only to balance opening-balance postings.

#### `ledger_entries`
| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| organization_id | uuid | NOT NULL, FK → organizations, CASCADE |
| account_id | uuid | NOT NULL, composite FK → ledger_accounts, **RESTRICT** |
| customer_id | uuid | NULL, composite FK → customers |
| supplier_id | uuid | NULL, composite FK → suppliers |
| party_type | party_type_enum | generated, same pattern as `payments` |
| debit_amount | numeric(14,2) | NOT NULL, default 0, CHECK ≥ 0 |
| credit_amount | numeric(14,2) | NOT NULL, default 0, CHECK ≥ 0 |
| — | — | CHECK: exactly one of debit/credit is > 0, the other = 0 |
| — | — | CHECK: not both `customer_id` and `supplier_id` set |
| reference_type | varchar(30) | NOT NULL |
| reference_id | uuid | NOT NULL — no FK, polymorphic (documented exception) |
| entry_date | date | NOT NULL |
| description | varchar(255) | NULL |
| created_at | timestamptz | NOT NULL |

Index `(organization_id, account_id, entry_date)` · `(organization_id, customer_id)` · `(organization_id, supplier_id)` · `(reference_type, reference_id)`. **Append-only** — no UPDATE/DELETE grant on the app DB role.

#### `stock_movements` — unchanged shape; `movement_type` now includes `opening_balance`; `product_variant_id` becomes a composite FK. **Append-only.**

---

## Opening Stock Accounting Flow

Creating a `product_variant` with a starting quantity inserts one `stock_movements` row in the same transaction — `movement_type = 'opening_balance'`, `quantity = <starting qty>`, `reference_type = 'product_variant_onboarding'`, `reference_id = <variant id>` — and sets `current_stock` to that same value. Nothing about opening stock is special after that; it's just the first row in the same ledger every other movement writes to:

```
opening_balance   +25
purchase          +50
sale              −10
sale_return        +5
──────────────────────
current_stock      70
```

The Revision-1 reconciliation job (`SUM(quantity) FROM stock_movements GROUP BY product_variant_id`, checked against the `current_stock` cache) now covers opening stock automatically, with no special case.

## Opening Balance Accounting Flow

`opening_balance_input` on `customers`/`suppliers` is a write-once onboarding field. If it's non-zero when the row is created, one `ledger_entries` row is posted in the same transaction:

- Customer opening receivable: `Dr Accounts Receivable [customer_id]` / `Cr Opening Balance Equity`
- Supplier opening payable: `Dr Opening Balance Equity` / `Cr Accounts Payable [supplier_id]`

dated as of onboarding, `reference_type = 'opening_balance'`, `reference_id = <customer/supplier id>`. "Opening Balance Equity" exists purely to keep the entry double-sided — it's a balancing account, not something reported to the owner. After this, `outstanding = SUM(debit − credit) FROM ledger_entries WHERE account = Accounts Receivable AND customer_id = X` — always derived, never read from `opening_balance_input` again.

## Payment Integrity Mechanism

No trigger is needed. Three declarative pieces do the whole job:

1. **`party_type` is a generated column**, computed from `customer_id`/`supplier_id` — it can never drift from which one is actually set.
2. **`payments_one_party`** CHECK guarantees exactly one of `customer_id`/`supplier_id` is set.
3. **Composite foreign keys** guarantee both "the party exists" and "the party belongs to this exact organization" in one constraint: `(organization_id, customer_id) → customers(organization_id, id)`, same for `supplier_id`.
4. For the harder requirement — *"the linked sale/purchase belongs to the same org **and** matches the payment's party"* — a **three-column composite FK** does it in one shot: `(organization_id, linked_sale_id, customer_id) → sales(organization_id, id, customer_id)`. Postgres foreign keys use `MATCH SIMPLE` by default: if *any* referencing column is `NULL`, the whole constraint is skipped for that row. So an unlinked payment (`linked_sale_id IS NULL`) or a supplier payment (`customer_id IS NULL`) is automatically exempt from this particular check, while a payment that *does* link to a sale is forced to match that sale's actual customer, in that org. The mirror constraint does the same for `linked_purchase_id`/`supplier_id`.

## RBAC Schema

Smallest practical extensible shape: `roles` (who), `permissions` (what's possible), `role_permissions` (which role can do what). MVP seeds four system roles — Owner, Manager, Sales Staff, Accountant — each with `organization_id = NULL`, wired to a starting permission set (illustrative, not exhaustive): `sales.create`, `sales.confirm`, `sales.return`, `purchases.create`, `purchases.confirm`, `payments.record`, `products.manage`, `customers.manage`, `suppliers.manage`, `reports.view`, `org.manage_users`, `org.manage_settings`.

Adding a fifth role, or changing what Accountant can do, is an `INSERT`/`UPDATE` — never an `ALTER TYPE` or a migration. Per-org custom roles are schema-ready (`roles.organization_id` exists for exactly this) but intentionally not built or enforced in Milestone 2 — the org-ownership check for a *custom* role is deferred until that feature actually ships, rather than adding complexity for a capability nobody's using yet.

## Tax-Rate Versioning Mechanism

Guarantee required: **HSN + transaction date → exactly one applicable rate.** Two parts:

1. **No overlap within a scope** — the exclusion constraint above guarantees that for the same `organization_key` (org-specific override, or the shared sentinel for platform defaults) and the same `hsn_code`, no two rows' `[effective_from, effective_to]` ranges can overlap. `effective_to` is inclusive — if you're superseding a rate, the new one's `effective_from` should be the day after the old one's `effective_to`, or the exclusion constraint will (correctly) reject the insert.
2. **Precedence between scopes** — an org-specific override and the platform default are different `organization_key` values, so the exclusion constraint doesn't (and shouldn't) compare them to each other; that's resolved at lookup time: *try the org-specific row active for the transaction date first; if none exists, fall back to the platform default active for that date.* Because each of those two groups is individually non-overlapping, each half of that lookup returns at most one row, so the precedence rule always resolves to exactly one.

## Return Accounting Flow

Returns still post immediately (kept from Revision 1) — but now precisely defined, and the original confirmed sale/purchase is **never** touched.

**Sale return**, inside one DB transaction (mirrors `AccountingEngine.postTransaction()`):
1. Insert `stock_movements` (`movement_type = 'sale_return'`, `quantity = +returned_qty`) per returned line — stock goes back up.
2. Insert `ledger_entries` that are the mirror image of the original sale, scaled to the returned amount, dated at the return date, `reference_type = 'sale_return'`: `Dr Sales` / `Dr CGST Payable` / `Dr SGST Payable` / `Dr IGST Payable` / `Cr Accounts Receivable [customer_id]`. This *reduces* what the customer owes; it does not edit the original sale's entries, which stay exactly as posted.
3. If the customer had already paid and is now owed cash back, that's a **separate** `payments` row (`direction = 'out'`) — a return changes what's owed, a refund is a distinct movement of money, and conflating them would make the ledger harder to audit, not easier.

**Purchase return** mirrors this exactly: stock decreases (`movement_type = 'purchase_return'`, `quantity = −returned_qty`), and the ledger entries are `Dr Accounts Payable [supplier_id]` / `Cr Purchases` / `Cr CGST/SGST/IGST Payable` — reducing what's owed to the supplier.

Both are implemented as one function each (`postSaleReturn()` / `postPurchaseReturn()`) reusing the same "all in one DB transaction or nothing" discipline as Confirm — not new machinery, just this specific composition of it.

## RLS Strategy

Same tenant-isolation policy as Revision 1, applied to every table above with a non-nullable `organization_id`, now including `roles` (for future custom roles), `role_permissions` (via a join, since it has no direct `organization_id`), `payments`, and `ledger_entries`. `permissions` stays platform-level, read-only to app sessions. `tax_rates` and `roles` keep the "own row or platform default" read policy from Revision 1 (`organization_id IS NULL OR organization_id = current_org`), writable only where `organization_id = current_org`.

---

## Final Schema Decisions Requiring Approval

Only the items this revision newly surfaces — everything resolved above (the size fix, opening stock/balance sourcing, payment integrity, tax overlap, RBAC shape, return flow) is treated as settled, not re-listed.

1. **The composite-FK pattern adds real DDL weight** — a `UNIQUE(organization_id, id)` on nearly every table plus multi-column FKs, some of them three columns wide (`payments` → `sales`). This is the strongest guarantee available short of triggers, but it's more schema surface than Revision 1's "RLS + app checks" approach. Confirm this tradeoff is worth it (it's what Item 4 and Item 8 asked for).
2. **Three named exceptions remain outside the composite-FK guarantee**: `tax_rate_id` (nullable-org target), `ledger_entries.reference_id` (polymorphic), `audit_log.actor_user_id` (nullable org). Confirm these three are acceptable rather than adding trigger-based enforcement to close them too.
3. **RBAC ships with all roles at `organization_id = NULL`** (global) for MVP; per-org custom roles are schema-ready but neither enforced nor exposed yet. Confirm this scope is right for Milestone 2.
4. **Tax-rate precedence (org-specific beats platform default) is an application-layer lookup rule**, not something the database enforces by itself. Confirm the two-step lookup described above is the intended behavior.
5. **A return never auto-generates a refund** — if money needs to go back to the customer, staff record a separate payment. Confirm this two-step flow (return, then optional refund) matches how Famous Footwears actually wants to operate.

---

*No migration, application code, or UI has been generated. On approval of the above, Milestone 2 proceeds to the actual Drizzle migration.*
