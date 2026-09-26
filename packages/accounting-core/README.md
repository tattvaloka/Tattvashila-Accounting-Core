# Accounting Core

The runtime posting engine. `postJournal()` and `postStockMovement()` are the
only two functions in the whole codebase allowed to write to `ledger_entries`
and `stock_movements`/`current_stock` respectively — everything else
(`sales.ts`, `purchases.ts`, `payments.ts`, `openingBalances.ts`,
`expenses.ts`) is a caller of those two, never a second writer.

This document reflects a **Milestone 3 correctness pass** performed after
the initial implementation. The "What was corrected" section below is not
hypothetical — the initial version had real bugs, listed honestly.

## Accounting model: perpetual inventory

- A confirmed **purchase** capitalizes the goods into `INVENTORY` (an
  asset), not an expense.
- A confirmed **sale** does two things in the *same* posting: recognizes
  revenue (Dr AR / Cr Sales / Cr Output GST) and relieves inventory while
  recognizing COGS (Dr COGS / Cr Inventory).
- **Costing method: standard cost**, not FIFO or weighted-average. COGS for
  a sale line is `quantity x product.purchasePrice` at the moment the sale
  is confirmed. This is a deliberate MVP simplification — the schema has no
  per-lot cost tracking, which real FIFO/weighted-average costing would
  require (each purchase creating a costed "layer" that sales consume in
  order). If Famous Footwears' purchase price for a shoe changes often
  enough that this matters for margin accuracy, that's a schema-level
  follow-up, not something this pass silently worked around.
- The unit cost used is **frozen onto `sale_items.cogs_amount` at Confirm
  time** (migration `0002_sale_item_cogs.sql`) specifically so a later
  return reverses the *same* figure that was originally posted, even if
  `products.purchasePrice` has changed since. Before this pass, there was
  no such column and no COGS posting at all — a return would have had
  nothing correct to reverse against.

## Input GST vs Output GST

Kept in six separate accounts, never mixed:

| | Asset (recoverable credit) | Liability (owed to government) |
|---|---|---|
| CGST | `INPUT_CGST` | `OUTPUT_CGST` |
| SGST | `INPUT_SGST` | `OUTPUT_SGST` |
| IGST | `INPUT_IGST` | `OUTPUT_IGST` |

Purchases debit the `INPUT_*` accounts; sales credit the `OUTPUT_*`
accounts. **This code does not net input credit against output liability**
— that's a GST-return-filing concern (periodic set-off), explicitly out of
scope here. The tax engine (`tax.ts`, rate lookup + `calculateLineTax`)
stays fully separate from posting logic (`sales.ts`/`purchases.ts` call it,
then hand the result to `postJournal`) — this separation was already true
before this pass and hasn't changed.

## Opening stock

`postOpeningStock()` now does two things atomically (same transaction,
passed in by the caller):

1. A `stock_movements` row (`movement_type = 'opening_balance'`).
2. `Dr INVENTORY [quantity x purchasePrice] / Cr OPENING_BALANCE_EQUITY`.

**Before this pass, only (1) existed.** There was no accounting entry at
all for opening stock — the design doc promised an "opening/equity
treatment" that the code never actually delivered. Fixed now.

## Stock concurrency and negative-stock prevention

`postStockMovement()`'s update is now:

```sql
UPDATE product_variants
SET current_stock = current_stock + :qty
WHERE id = :id AND organization_id = :org AND current_stock + :qty >= 0
RETURNING id, current_stock;
```

If zero rows come back, the movement is rejected (`INSUFFICIENT_STOCK`) and
**nothing is written** — not the movement row, not the cache. The guard is
part of the `UPDATE`'s `WHERE` clause rather than a separate `SELECT`
beforehand, which is what actually makes this concurrency-safe: Postgres
takes the row lock as part of evaluating and applying the statement, so two
simultaneous sales of the last pair serialize against each other instead of
both reading "1 available" and both proceeding. There is deliberately no
explicit `SELECT ... FOR UPDATE` step — the guarded `UPDATE` *is* the lock.

**Before this pass**, this was an unconditional `current_stock = current_stock
+ quantity` with no guard at all — it could go negative, and under
concurrency two simultaneous sales could both succeed against stock that
only existed once.

## Quantity validation

`calculateLineTax()` now rejects zero, negative, or fractional quantities
outright (`INVALID_QUANTITY`) instead of silently `Math.round()`-ing a
fractional value. Footwear is sold in whole pairs; a caller passing `2.5`
was a bug to surface, not a rounding decision to make quietly on their
behalf.

## Design decisions carried over from the initial implementation (unchanged by this pass)

- `confirmSale`/`confirmPurchase` always post the full amount to
  AR/AP regardless of `payment_mode` — a cash sale is a `recordPayment()`
  call against that same sale, not a branch inside confirm.
- GST inter-state determination is derived from the customer's/supplier's
  GSTIN prefix, falling back to intra-state when there's no GSTIN (the
  schema has no explicit state-code column for parties). Still flagged as a
  known limitation, not fixed in this pass — it wasn't in scope.

## Accounting invariants and where each is enforced

| Invariant | Enforced by |
|---|---|
| Every journal is balanced | `postJournal()` sums debits/credits in integer paise before writing anything |
| A confirmed sale/purchase has a corresponding posting | `confirmSale`/`confirmPurchase` call `postJournal` before updating `status` to `'confirmed'`, in one transaction |
| Every stock-changing confirmed transaction has a stock movement | `confirmSale`/`confirmPurchase`/returns all call `postStockMovement` for every line |
| Stock movement and posting reference the same source transaction | Both are called with the same `referenceType`/`referenceId` (the sale/purchase/return id) within the same function |
| Returns cannot exceed the original transaction's quantity | `createSaleReturn`/`createPurchaseReturn` sum prior returns per line and reject the excess (`OVER_RETURN`) |
| Confirmed transactions are immutable | DB trigger (`migrations/0001_triggers_and_rls.sql`), tested directly in the integration suite by attempting a bypass `UPDATE` |
| No confirmed sale can produce negative stock | The guarded `UPDATE` in `postStockMovement` (see above) |
| No cross-organization financial posting | Composite FKs throughout the schema (Milestone 2), plus every posting function takes and threads through an explicit `organizationId` rather than inferring it |

## Tests

**Actually executed in this sandbox** (no network access to install
`vitest` or reach a database, so run via Node's built-in TypeScript
stripping on extracted logic, not via `npm test`):
- The money/paise arithmetic (`money.ts`)
- `calculateLineTax()` against four hand-computed worked examples (intra-
  state, inter-state, a rounding edge case, the footwear 5% slab)
- The new quantity-validation branch (0, -3, 2.5 rejected; 1, 10 accepted)
- The `Promise.all`/`.map()` ordering assumption the `postJournal.test.ts`
  mock depends on (confirmed empirically with a standalone script — account
  IDs are resolved in line order, deterministically)

**Written but NOT executed** (need `npm install` + either nothing further,
for the pure unit files, or a live Postgres for the integration files — run
these for real once in an environment with `DATABASE_URL` set):
- `test/money.test.ts`, `test/tax.test.ts`, `test/invoiceNumbering.test.ts` — pure, no DB
- `test/postJournal.test.ts` — mock-based; covers empty/zero/unbalanced/malformed/missing-account rejections AND balanced single-line, multi-line, and supplier-party postings, asserting the actual inserted row contents and that debit totals equal credit totals
- `test/stock.test.ts` — mock-based; covers the zero-quantity rejection and distinguishes `INSUFFICIENT_STOCK` from `NOT_FOUND`, but **cannot** verify the actual concurrency guarantee — that needs real Postgres
- `test/sales.integration.test.ts` — real DB required. Covers: opening stock (movement + balanced Inventory/Equity entry), sale confirm (balanced 6-line entry incl. COGS/Inventory, stock decrement), **insufficient stock rejected with zero partial mutation**, confirmed-sale immutability (direct SQL bypass rejected by trigger), partial return (proportional revenue+tax+COGS reversal, original sale untouched), over-return rejected
- `test/purchases.integration.test.ts` — real DB required. Covers: purchase confirm (Inventory + Input GST, no COGS at purchase time, stock increment), partial purchase return (proportional Inventory/Input-GST/Payable reversal), over-return rejected

**I am not claiming any of the "written but not executed" tests pass.** They
are believed correct based on the same logic verified via direct execution
above, plus careful manual tracing, but "believed correct" and "executed
and green" are different claims and this document doesn't blur them.

## Still not implemented (unchanged scope from before this pass)

No Express API, no RBAC enforcement middleware, no frontend, no report
queries, no invoice PDF, no localization. This pass was scoped strictly to
Accounting Core correctness, per instruction.
