-- =============================================================================
-- Milestone 2 — triggers, Row-Level Security, and append-only enforcement.
-- Run after 0000_init.sql.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- updated_at auto-touch
-- -----------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
declare
  t text;
begin
  foreach t in array array[
    'business_types','users','organizations','products','product_variants',
    'customers','suppliers','sales','purchases'
  ]
  loop
    execute format('create trigger set_updated_at before update on %I for each row execute function set_updated_at();', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Financial immutability (ADR-006 / Critical accounting requirement):
-- a confirmed sale/purchase can never be edited in place, and can never be
-- cancelled — only reversed via a return.
-- -----------------------------------------------------------------------------
create or replace function prevent_confirmed_mutation() returns trigger as $$
begin
  if old.status = 'confirmed' then
    if new.status = 'cancelled' then
      raise exception 'Cannot cancel a confirmed %; use a return instead.', tg_argv[0];
    end if;
    if new.status <> 'confirmed'
       or new.subtotal <> old.subtotal
       or new.discount_total <> old.discount_total
       or new.taxable_total <> old.taxable_total
       or new.cgst_total <> old.cgst_total
       or new.sgst_total <> old.sgst_total
       or new.igst_total <> old.igst_total
       or new.rounding_adjustment <> old.rounding_adjustment
       or new.grand_total <> old.grand_total
       or new.invoice_number is distinct from old.invoice_number
    then
      raise exception 'Cannot modify a confirmed %.', tg_argv[0];
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger sales_prevent_confirmed_mutation
  before update on sales
  for each row execute function prevent_confirmed_mutation('sale');

create trigger purchases_prevent_confirmed_mutation
  before update on purchases
  for each row execute function prevent_confirmed_mutation('purchase');

-- Line items of a confirmed sale/purchase are immutable too, even against a
-- direct SQL statement that bypasses the application layer.
create or replace function prevent_confirmed_item_mutation() returns trigger as $$
declare
  parent_status transaction_status_enum;
begin
  if tg_argv[0] = 'sale' then
    select status into parent_status from sales where id = old.sale_id;
  else
    select status into parent_status from purchases where id = old.purchase_id;
  end if;

  if parent_status = 'confirmed' then
    raise exception 'Cannot modify line items of a confirmed %.', tg_argv[0];
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger sale_items_prevent_confirmed_mutation
  before update or delete on sale_items
  for each row execute function prevent_confirmed_item_mutation('sale');

create trigger purchase_items_prevent_confirmed_mutation
  before update or delete on purchase_items
  for each row execute function prevent_confirmed_item_mutation('purchase');

-- -----------------------------------------------------------------------------
-- Application role and append-only enforcement
--
-- Adjust the role name/password to match how your Express service actually
-- connects (e.g. a Supabase connection-pooler role). RLS below assumes every
-- request-scoped query runs as this role, with app.current_org_id set via
-- SET LOCAL at the start of the request's transaction — see
-- packages/db/src/client.ts:withOrgContext().
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select from pg_roles where rolname = 'app_role') then
    create role app_role login password 'change_me';
  end if;
end $$;

grant usage on schema public to app_role;
grant select, insert, update, delete on all tables in schema public to app_role;
grant usage, select on all sequences in schema public to app_role;

-- Append-only tables (Critical accounting / inventory requirements): once a
-- row lands here it is never changed or removed by the application.
revoke update, delete on ledger_entries from app_role;
revoke update, delete on stock_movements from app_role;
revoke update, delete on audit_log from app_role;

-- -----------------------------------------------------------------------------
-- Row-Level Security
-- -----------------------------------------------------------------------------

-- Standard tenant-isolation policy, applied to every table below that has a
-- non-nullable organization_id and no special-case read rule.
do $$
declare
  t text;
begin
  foreach t in array array[
    'org_users','branches','org_modules','subscriptions',
    'products','product_variants','customers','suppliers',
    'sales','sale_items','sale_returns','sale_return_items',
    'purchases','purchase_items','purchase_returns','purchase_return_items',
    'payments','expenses',
    'ledger_accounts','ledger_entries','stock_movements',
    'invoice_sequences'
  ]
  loop
    execute format('alter table %I enable row level security;', t);
    execute format(
      'create policy tenant_isolation on %I using (organization_id = current_setting(''app.current_org_id'', true)::uuid) with check (organization_id = current_setting(''app.current_org_id'', true)::uuid);',
      t
    );
  end loop;
end $$;

-- tax_rates: an org sees its own overrides plus every platform default;
-- it may only write rows scoped to itself (never NULL / platform-wide).
alter table tax_rates enable row level security;
create policy tax_rates_read on tax_rates
  for select
  using (organization_id is null or organization_id = current_setting('app.current_org_id', true)::uuid);
create policy tax_rates_write on tax_rates
  for insert
  with check (organization_id = current_setting('app.current_org_id', true)::uuid);
create policy tax_rates_update on tax_rates
  for update
  using (organization_id = current_setting('app.current_org_id', true)::uuid)
  with check (organization_id = current_setting('app.current_org_id', true)::uuid);

-- roles: same "own row or system default" shape as tax_rates, for the
-- per-org custom roles the schema leaves room for (not built yet).
alter table roles enable row level security;
create policy roles_read on roles
  for select
  using (organization_id is null or organization_id = current_setting('app.current_org_id', true)::uuid);
create policy roles_write on roles
  for insert
  with check (organization_id = current_setting('app.current_org_id', true)::uuid);
create policy roles_update on roles
  for update
  using (organization_id = current_setting('app.current_org_id', true)::uuid)
  with check (organization_id = current_setting('app.current_org_id', true)::uuid);

-- users: a session sees its own row, plus teammates sharing an org_users
-- row in the org currently in context (needed to show e.g. "confirmed by").
alter table users enable row level security;
create policy users_visibility on users
  for select
  using (
    id = current_setting('app.current_user_id', true)::uuid
    or exists (
      select 1
      from org_users a
      join org_users b on a.organization_id = b.organization_id
      where a.user_id = users.id
        and b.user_id = current_setting('app.current_user_id', true)::uuid
        and a.organization_id = current_setting('app.current_org_id', true)::uuid
    )
  );
create policy users_self_update on users
  for update
  using (id = current_setting('app.current_user_id', true)::uuid)
  with check (id = current_setting('app.current_user_id', true)::uuid);

-- audit_log: scoped reads, no update/delete policy at all (matches the
-- REVOKE above — belt and suspenders).
alter table audit_log enable row level security;
create policy audit_log_read on audit_log
  for select
  using (organization_id is null or organization_id = current_setting('app.current_org_id', true)::uuid);
create policy audit_log_insert on audit_log
  for insert
  with check (organization_id is null or organization_id = current_setting('app.current_org_id', true)::uuid);

-- business_types, plans, permissions, role_permissions: platform reference
-- data. Readable by any authenticated app session, writable only via
-- migrations/seed (no INSERT/UPDATE/DELETE policy — the app role's default
-- table grants are revoked here instead of layering on RLS).
revoke insert, update, delete on business_types from app_role;
revoke insert, update, delete on plans from app_role;
revoke insert, update, delete on permissions from app_role;
revoke insert, update, delete on role_permissions from app_role;

commit;
