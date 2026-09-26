# Famous Footwears Platform — Milestone 2 (Database Schema)

This repo contains **Milestone 2 only**: the reviewed and approved database
schema, as Drizzle TypeScript definitions and a runnable SQL migration, plus
platform seed data. It matches `Milestone 2 — Database Schema Design
(Revision 2)` and ADR-001 through ADR-006 column-for-column.

## What's here

```
packages/db/
  src/schema/       Drizzle table + enum definitions (typed, for app code)
  migrations/        Hand-authored SQL that actually creates the database
  seed/              Platform reference data (business types, plans,
                     permissions, roles) + a per-org defaults helper
  scripts/           A small runner for the SQL migrations
```

## Why the migration SQL is hand-written, not `drizzle-kit generate`-d

This was built in a sandboxed environment with no network access — there
was no way to `npm install` or connect to a live Postgres instance to run
`drizzle-kit generate`. So `migrations/0000_init.sql` and
`migrations/0001_triggers_and_rls.sql` were written by hand to match
`src/schema/*.ts` exactly, rather than generated.

**Before you rely on this in production:** run it against a real (ideally
disposable/staging) Postgres database and sanity-check it — nothing here
has been executed. Once it's applied once, treat it as the baseline and let
`drizzle-kit generate` handle every schema change from then on
(`npm run db:generate` from `packages/db`).

## Setup

```bash
cd packages/db
cp .env.example .env      # fill in DATABASE_URL
npm install                # from the repo root is also fine (workspaces)
npm run migrate             # applies 0000_init.sql then 0001_triggers_and_rls.sql
npm run seed                 # business types, plans, permissions, 4 system roles
```

`0001_triggers_and_rls.sql` creates a Postgres role called `app_role` with a
placeholder password — change the name/password to match how your actual
Express service will connect, since Row-Level Security assumes every
request-scoped query runs as that role with `app.current_org_id` set via
`SET LOCAL` (see `src/client.ts` → `withOrgContext()`).

## What changed in this revision (the 9-point review)

1. Footwear size check fixed — it's `(size * 10)::integer % 5 = 0`, not the
   broken `size2` expression from the first draft (a Markdown rendering bug,
   not a logic bug — see the comment in `products.ts`).
2. `product_variants.opening_stock` removed — opening stock is a
   `stock_movements` row (`movement_type = 'opening_balance'`).
3. `customers.opening_balance` / `suppliers.opening_balance` removed —
   replaced by `opening_balance_input`, an onboarding-only field. Turning it
   into a real `ledger_entries` row is Accounting Core logic (a later
   milestone), not schema — see "What's deliberately NOT here" below.
4. Payment party integrity is enforced by the database (generated
   `party_type` column + composite foreign keys, including a three-column
   FK to `sales`/`purchases`) — no trigger needed.
5. RBAC is `roles` / `permissions` / `role_permissions`, not a fixed enum.
6. Tax-rate overlap is prevented by a Postgres `EXCLUDE` constraint
   (`btree_gist`), not just convention.
7. `business_types.config` stays declarative (terminology, variant
   dimensions, enabled modules) — no behavior lives in JSON anywhere here.
8. Tenant-consistency is enforced by composite foreign keys
   (`organization_id, x_id) → other_table(organization_id, id)`) across
   nearly every cross-table reference, including `created_by`/`confirmed_by`
   (which reference `org_users`, not `users`, so an action can never be
   attributed to a membership in a different org).
9. `sale_returns`/`purchase_returns` post immediately (kept from the first
   draft) with the tables and constraints to support it correctly — the
   actual posting logic is, again, Accounting Core code.

## What's deliberately NOT here

This is a schema milestone. On purpose, there is **no**:
- Express API, routes, or auth
- React frontend
- Accounting Core / business logic (the code that actually inserts
  `ledger_entries` and `stock_movements` rows when a sale is confirmed, an
  opening balance is set, or a return is posted)
- Business-module package for footwear (the `IProductVariantStrategy`
  strategy interface mentioned in the design doc)
- Tests

Those are later milestones in the roadmap (Authentication → Multi-tenancy →
Org setup → Accounting foundation → ... → Returns → Dashboard → Reports),
and building any of them now would jump ahead of what's been reviewed and
approved so far.

## Milestone 3 — Accounting Core

`packages/accounting-core` implements the actual runtime posting logic —
the "AccountingEngine" the earlier design docs described, not just its
design. **Full detail — accounting model, what was corrected in the
Milestone 3 correctness pass, invariants and where each is enforced, and
exactly which tests were executed vs. only written — lives in
[`packages/accounting-core/README.md`](packages/accounting-core/README.md),
not duplicated here.** Summary:

- Perpetual inventory: purchases capitalize into `INVENTORY`; sales relieve it and recognize `COGS` in the same posting as revenue, using a frozen `sale_items.cogs_amount` so returns reverse the exact original figure
- Input GST and Output GST are separate accounts (`INPUT_CGST`/`OUTPUT_CGST` etc.), never netted
- Stock changes go through a single guarded, concurrency-safe `UPDATE` that cannot produce negative stock
- Opening stock posts both a `stock_movements` row and a real `Dr Inventory / Cr Opening Balance Equity` entry
- Quantity validation rejects zero/negative/fractional quantities outright

### Still not implemented (by design, not oversight)

- No Express API / routes — nothing here is callable over HTTP yet
- No RBAC permission-checking middleware (the `roles`/`permissions` schema exists; nothing enforces it yet)
- No frontend
- No report queries
- No invoice PDF generation
- No localization
- Purchases/payments/opening-balances have unit-test-level coverage via the pure-logic tests but not yet their own dedicated integration test file (sales.integration.test.ts is the template to follow for those — same pattern, different tables)

