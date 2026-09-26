-- =============================================================================
-- Milestone 3 correctness pass: perpetual inventory requires sale_items to
-- remember the unit cost used at Confirm time, so a later return can reverse
-- the *same* COGS amount even if the product's purchase_price has since
-- changed. Without this column, a sale return's COGS reversal would drift
-- from what was actually recognized at sale time — two sources of truth for
-- the same figure, which is exactly what this pass is meant to eliminate.
-- =============================================================================

begin;

alter table sale_items
  add column cogs_amount numeric(14,2) not null default 0;

comment on column sale_items.cogs_amount is
  'Cost of goods sold for this line, computed from product.purchase_price at Confirm time and frozen thereafter — the figure sale returns reverse against, never recomputed from the product''s current price.';

commit;
