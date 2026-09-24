-- =============================================================================
-- Milestone 2 — initial schema migration
--
-- This file is hand-authored rather than `drizzle-kit generate`-d, because it
-- was written in a sandboxed environment with no network access to install
-- drizzle-kit or reach a live Postgres instance. It is written to match
-- packages/db/src/schema/*.ts column-for-column. Once you run this against a
-- real database, `drizzle-kit generate` will treat it as the baseline for any
-- future schema changes (see README.md).
--
-- Run this against a fresh Supabase / Postgres database. It is idempotent
-- where practical (IF NOT EXISTS) but is meant to be run once, in order.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- Extensions
-- -----------------------------------------------------------------------------
create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists btree_gist; -- exclusion constraint on tax_rates

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
create type org_user_status_enum as enum ('invited', 'active', 'disabled');
create type billing_cycle_enum as enum ('monthly', 'annual', 'one_time');
create type subscription_status_enum as enum ('trialing', 'active', 'past_due', 'cancelled');
create type transaction_status_enum as enum ('draft', 'confirmed', 'cancelled');
create type payment_direction_enum as enum ('in', 'out');
create type party_type_enum as enum ('customer', 'supplier');
create type ledger_account_type_enum as enum ('asset', 'liability', 'income', 'expense', 'equity');
create type stock_movement_type_enum as enum (
  'opening_balance', 'purchase', 'sale', 'sale_return', 'purchase_return', 'adjustment'
);
create type audit_action_enum as enum ('create', 'update', 'delete', 'confirm', 'cancel', 'reverse');

-- -----------------------------------------------------------------------------
-- Platform-level tables
-- -----------------------------------------------------------------------------
create table business_types (
  id uuid primary key default gen_random_uuid(),
  code varchar(50) not null unique,
  name varchar(100) not null,
  config jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  email varchar(255) not null unique,
  phone varchar(15),
  auth_provider_id varchar(255),
  full_name varchar(150) not null,
  preferred_language varchar(10) not null default 'en',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table plans (
  id uuid primary key default gen_random_uuid(),
  code varchar(50) not null unique,
  name varchar(100) not null,
  price numeric(10,2) not null,
  billing_cycle billing_cycle_enum not null,
  max_users integer not null,
  max_branches integer not null,
  features jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table permissions (
  id uuid primary key default gen_random_uuid(),
  code varchar(100) not null unique,
  description varchar(255),
  created_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Organization & tenancy
-- -----------------------------------------------------------------------------
create table organizations (
  id uuid primary key default gen_random_uuid(),
  name varchar(200) not null,
  business_type_id uuid not null references business_types(id) on delete restrict,
  gstin varchar(15),
  state_code varchar(2) not null,
  default_language varchar(10) not null default 'en',
  financial_year_start_month smallint not null default 4,
  invoice_prefix varchar(10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index organizations_gstin_uidx on organizations (gstin) where gstin is not null;

create table roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  organization_key uuid generated always as (
    coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) stored,
  code varchar(50) not null,
  name varchar(100) not null,
  is_system boolean not null default true,
  created_at timestamptz not null default now(),
  constraint roles_org_key_code_uidx unique (organization_key, code)
);

create table role_permissions (
  role_id uuid not null references roles(id) on delete cascade,
  permission_id uuid not null references permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

create table org_users (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role_id uuid not null references roles(id) on delete restrict,
  status org_user_status_enum not null default 'invited',
  invited_at timestamptz,
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  constraint org_users_org_user_uidx unique (organization_id, user_id),
  constraint org_users_org_id_uidx unique (organization_id, id)
);

create table branches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name varchar(150) not null,
  address text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  constraint branches_org_name_uidx unique (organization_id, name),
  constraint branches_org_id_uidx unique (organization_id, id)
);
create unique index branches_one_default_per_org_uidx on branches (organization_id) where is_default;

create table org_modules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  module_code varchar(50) not null,
  enabled boolean not null default true,
  source varchar(20) not null default 'plan' check (source in ('plan', 'override')),
  constraint org_modules_org_module_uidx unique (organization_id, module_code)
);

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  plan_id uuid not null references plans(id) on delete restrict,
  status subscription_status_enum not null default 'trialing',
  started_at timestamptz not null default now(),
  current_period_end timestamptz,
  cancelled_at timestamptz,
  payment_gateway_ref varchar(255),
  created_at timestamptz not null default now()
);
create index subscriptions_org_idx on subscriptions (organization_id);
create index subscriptions_status_idx on subscriptions (status);

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete set null,
  actor_user_id uuid references users(id) on delete set null,
  entity_type varchar(50) not null,
  entity_id uuid not null,
  action audit_action_enum not null,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_entity_idx on audit_log (organization_id, entity_type, entity_id);
create index audit_log_created_idx on audit_log (created_at);

-- -----------------------------------------------------------------------------
-- Products & inventory
-- -----------------------------------------------------------------------------
create table products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name varchar(200) not null,
  brand varchar(100),
  category varchar(100),
  model varchar(100),
  hsn_code varchar(8),
  purchase_price numeric(14,2) not null check (purchase_price >= 0),
  wholesale_price numeric(14,2) not null check (wholesale_price >= 0),
  attributes jsonb not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index products_org_name_idx on products (organization_id, name);
create index products_org_hsn_idx on products (organization_id, hsn_code);

create table product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  size numeric(3,1) not null,
  colour varchar(50),
  sku varchar(50) not null,
  current_stock integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_variants_org_sku_uidx unique (organization_id, sku),
  constraint product_variants_product_size_colour_uidx unique (product_id, size, colour),
  constraint product_variants_org_id_uidx unique (organization_id, id),
  -- Revision-2 fix: the original expression referenced a nonexistent
  -- "size2" column because it wasn't in a code span and Markdown ate the
  -- "*". This is the real constraint: size must be a positive multiple of 0.5.
  constraint product_variants_size_half_step_check check (size > 0 and (size * 10)::integer % 5 = 0)
);
create index product_variants_org_product_idx on product_variants (organization_id, product_id);

-- -----------------------------------------------------------------------------
-- Parties
-- -----------------------------------------------------------------------------
create table customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name varchar(150) not null,
  shop_name varchar(150),
  mobile varchar(15),
  address text,
  gstin varchar(15),
  opening_balance_input numeric(14,2), -- onboarding-only, see seed/README
  credit_limit numeric(14,2),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customers_org_id_uidx unique (organization_id, id)
);
create index customers_org_mobile_idx on customers (organization_id, mobile);
create index customers_org_name_idx on customers (organization_id, name);

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name varchar(150) not null,
  contact varchar(15),
  address text,
  gstin varchar(15),
  opening_balance_input numeric(14,2),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint suppliers_org_id_uidx unique (organization_id, id)
);
create index suppliers_org_contact_idx on suppliers (organization_id, contact);
create index suppliers_org_name_idx on suppliers (organization_id, name);

-- -----------------------------------------------------------------------------
-- Tax
-- -----------------------------------------------------------------------------
create table tax_rates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  organization_key uuid generated always as (
    coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) stored,
  hsn_code varchar(8) not null,
  description varchar(150),
  cgst_rate numeric(5,2) not null,
  sgst_rate numeric(5,2) not null,
  igst_rate numeric(5,2) not null,
  effective_from date not null,
  effective_to date,
  created_at timestamptz not null default now(),
  constraint tax_rates_igst_check check (igst_rate = cgst_rate + sgst_rate),
  constraint tax_rates_date_check check (effective_to is null or effective_to >= effective_from)
);
create index tax_rates_key_hsn_from_idx on tax_rates (organization_key, hsn_code, effective_from);
-- Guarantees "HSN + date -> exactly one applicable rate" within a scope
-- (an org override, or the shared platform-default scope). Precedence
-- between scopes (org override beats platform default) is an application
-- lookup rule — see "Tax-Rate Versioning Mechanism" in the design doc.
alter table tax_rates
  add constraint tax_rates_no_overlap
  exclude using gist (
    organization_key with =,
    hsn_code with =,
    daterange(effective_from, effective_to, '[]') with &&
  );

create table invoice_sequences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  sequence_type varchar(20) not null check (sequence_type in ('sale', 'purchase', 'sale_return', 'purchase_return')),
  financial_year varchar(9) not null,
  prefix varchar(10),
  last_number integer not null default 0,
  constraint invoice_sequences_org_type_fy_uidx unique (organization_id, sequence_type, financial_year)
);

-- -----------------------------------------------------------------------------
-- Sales
-- -----------------------------------------------------------------------------
create table sales (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  branch_id uuid not null,
  customer_id uuid not null,
  invoice_number varchar(30),
  status transaction_status_enum not null default 'draft',
  sale_date date not null default current_date,
  subtotal numeric(14,2) not null default 0,
  discount_total numeric(14,2) not null default 0,
  taxable_total numeric(14,2) not null default 0,
  cgst_total numeric(14,2) not null default 0,
  sgst_total numeric(14,2) not null default 0,
  igst_total numeric(14,2) not null default 0,
  rounding_adjustment numeric(14,2) not null default 0,
  grand_total numeric(14,2) not null default 0,
  payment_mode varchar(20) check (payment_mode is null or payment_mode in ('cash','upi','bank','credit','split')),
  confirmed_at timestamptz,
  confirmed_by uuid,
  cancelled_at timestamptz,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_org_id_customer_uidx unique (organization_id, id, customer_id),
  constraint sales_org_invoice_uidx unique (organization_id, invoice_number),
  constraint sales_branch_fk foreign key (organization_id, branch_id) references branches (organization_id, id) on delete restrict,
  constraint sales_customer_fk foreign key (organization_id, customer_id) references customers (organization_id, id) on delete restrict,
  constraint sales_created_by_fk foreign key (organization_id, created_by) references org_users (organization_id, id) on delete restrict,
  constraint sales_confirmed_by_fk foreign key (organization_id, confirmed_by) references org_users (organization_id, id) on delete set null
);
create index sales_org_customer_idx on sales (organization_id, customer_id);
create index sales_org_status_idx on sales (organization_id, status);
create index sales_org_date_idx on sales (organization_id, sale_date);

create table sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references sales(id) on delete cascade,
  organization_id uuid not null,
  product_variant_id uuid not null,
  quantity integer not null check (quantity > 0),
  rate numeric(14,2) not null check (rate >= 0),
  discount_amount numeric(14,2) not null default 0,
  taxable_value numeric(14,2) not null,
  tax_rate_id uuid references tax_rates(id) on delete set null,
  cgst_amount numeric(14,2) not null default 0,
  sgst_amount numeric(14,2) not null default 0,
  igst_amount numeric(14,2) not null default 0,
  line_total numeric(14,2) not null,
  constraint sale_items_org_id_uidx unique (organization_id, id),
  constraint sale_items_variant_fk foreign key (organization_id, product_variant_id) references product_variants (organization_id, id) on delete restrict
);
create index sale_items_sale_idx on sale_items (sale_id);
create index sale_items_variant_idx on sale_items (product_variant_id);

create table sale_returns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  sale_id uuid not null,
  return_number varchar(30) not null,
  return_date date not null default current_date,
  reason varchar(500),
  total_amount numeric(14,2) not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint sale_returns_org_number_uidx unique (organization_id, return_number),
  constraint sale_returns_sale_fk foreign key (organization_id, sale_id) references sales (organization_id, id) on delete restrict,
  constraint sale_returns_created_by_fk foreign key (organization_id, created_by) references org_users (organization_id, id) on delete restrict
);
create index sale_returns_sale_idx on sale_returns (sale_id);

create table sale_return_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  sale_return_id uuid not null references sale_returns(id) on delete cascade,
  sale_item_id uuid not null,
  quantity integer not null check (quantity > 0),
  amount numeric(14,2) not null,
  constraint sale_return_items_sale_item_fk foreign key (organization_id, sale_item_id) references sale_items (organization_id, id) on delete restrict
);
create index sale_return_items_return_idx on sale_return_items (sale_return_id);
create index sale_return_items_item_idx on sale_return_items (sale_item_id);

-- -----------------------------------------------------------------------------
-- Purchases (mirrors Sales)
-- -----------------------------------------------------------------------------
create table purchases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  supplier_id uuid not null,
  invoice_number varchar(30),
  status transaction_status_enum not null default 'draft',
  purchase_date date not null default current_date,
  subtotal numeric(14,2) not null default 0,
  discount_total numeric(14,2) not null default 0,
  taxable_total numeric(14,2) not null default 0,
  cgst_total numeric(14,2) not null default 0,
  sgst_total numeric(14,2) not null default 0,
  igst_total numeric(14,2) not null default 0,
  rounding_adjustment numeric(14,2) not null default 0,
  grand_total numeric(14,2) not null default 0,
  payment_mode varchar(20) check (payment_mode is null or payment_mode in ('cash','upi','bank','credit','split')),
  confirmed_at timestamptz,
  confirmed_by uuid,
  cancelled_at timestamptz,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint purchases_org_id_supplier_uidx unique (organization_id, id, supplier_id),
  constraint purchases_org_invoice_uidx unique (organization_id, invoice_number),
  constraint purchases_supplier_fk foreign key (organization_id, supplier_id) references suppliers (organization_id, id) on delete restrict,
  constraint purchases_created_by_fk foreign key (organization_id, created_by) references org_users (organization_id, id) on delete restrict,
  constraint purchases_confirmed_by_fk foreign key (organization_id, confirmed_by) references org_users (organization_id, id) on delete set null
);
create index purchases_org_supplier_idx on purchases (organization_id, supplier_id);
create index purchases_org_status_idx on purchases (organization_id, status);
create index purchases_org_date_idx on purchases (organization_id, purchase_date);

create table purchase_items (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references purchases(id) on delete cascade,
  organization_id uuid not null,
  product_variant_id uuid not null,
  quantity integer not null check (quantity > 0),
  rate numeric(14,2) not null check (rate >= 0),
  discount_amount numeric(14,2) not null default 0,
  taxable_value numeric(14,2) not null,
  tax_rate_id uuid references tax_rates(id) on delete set null,
  cgst_amount numeric(14,2) not null default 0,
  sgst_amount numeric(14,2) not null default 0,
  igst_amount numeric(14,2) not null default 0,
  line_total numeric(14,2) not null,
  constraint purchase_items_org_id_uidx unique (organization_id, id),
  constraint purchase_items_variant_fk foreign key (organization_id, product_variant_id) references product_variants (organization_id, id) on delete restrict
);
create index purchase_items_purchase_idx on purchase_items (purchase_id);
create index purchase_items_variant_idx on purchase_items (product_variant_id);

create table purchase_returns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  purchase_id uuid not null,
  return_number varchar(30) not null,
  return_date date not null default current_date,
  reason varchar(500),
  total_amount numeric(14,2) not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint purchase_returns_org_number_uidx unique (organization_id, return_number),
  constraint purchase_returns_purchase_fk foreign key (organization_id, purchase_id) references purchases (organization_id, id) on delete restrict,
  constraint purchase_returns_created_by_fk foreign key (organization_id, created_by) references org_users (organization_id, id) on delete restrict
);
create index purchase_returns_purchase_idx on purchase_returns (purchase_id);

create table purchase_return_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  purchase_return_id uuid not null references purchase_returns(id) on delete cascade,
  purchase_item_id uuid not null,
  quantity integer not null check (quantity > 0),
  amount numeric(14,2) not null,
  constraint purchase_return_items_purchase_item_fk foreign key (organization_id, purchase_item_id) references purchase_items (organization_id, id) on delete restrict
);
create index purchase_return_items_return_idx on purchase_return_items (purchase_return_id);
create index purchase_return_items_item_idx on purchase_return_items (purchase_item_id);

-- -----------------------------------------------------------------------------
-- Money movement
-- -----------------------------------------------------------------------------
create table payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid,
  supplier_id uuid,
  party_type party_type_enum generated always as (
    case
      when customer_id is not null then 'customer'::party_type_enum
      when supplier_id is not null then 'supplier'::party_type_enum
      else null
    end
  ) stored,
  direction payment_direction_enum not null,
  amount numeric(14,2) not null check (amount > 0),
  payment_mode varchar(20) not null check (payment_mode in ('cash','upi','bank','cheque')),
  reference varchar(100),
  payment_date date not null default current_date,
  linked_sale_id uuid,
  linked_purchase_id uuid,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint payments_one_party_check check (
    (customer_id is not null and supplier_id is null) or
    (supplier_id is not null and customer_id is null)
  ),
  constraint payments_customer_fk foreign key (organization_id, customer_id) references customers (organization_id, id),
  constraint payments_supplier_fk foreign key (organization_id, supplier_id) references suppliers (organization_id, id),
  -- Skipped automatically (Postgres MATCH SIMPLE) whenever linked_sale_id or
  -- customer_id is null — i.e. for unlinked payments and every supplier
  -- payment. When both are set, this forces the linked sale to actually
  -- belong to this org AND to this exact customer.
  constraint payments_linked_sale_fk foreign key (organization_id, linked_sale_id, customer_id) references sales (organization_id, id, customer_id),
  constraint payments_linked_purchase_fk foreign key (organization_id, linked_purchase_id, supplier_id) references purchases (organization_id, id, supplier_id),
  constraint payments_created_by_fk foreign key (organization_id, created_by) references org_users (organization_id, id) on delete restrict
);
create index payments_org_customer_idx on payments (organization_id, customer_id);
create index payments_org_supplier_idx on payments (organization_id, supplier_id);
create index payments_org_date_idx on payments (organization_id, payment_date);

create table expenses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  branch_id uuid,
  category varchar(100) not null,
  amount numeric(14,2) not null check (amount > 0),
  expense_date date not null default current_date,
  payment_mode varchar(20) not null,
  description varchar(500),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint expenses_branch_fk foreign key (organization_id, branch_id) references branches (organization_id, id) on delete set null,
  constraint expenses_created_by_fk foreign key (organization_id, created_by) references org_users (organization_id, id) on delete restrict
);
create index expenses_org_date_idx on expenses (organization_id, expense_date);

-- -----------------------------------------------------------------------------
-- Ledger & stock — the source of truth
-- -----------------------------------------------------------------------------
create table ledger_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  code varchar(20) not null,
  name varchar(100) not null,
  account_type ledger_account_type_enum not null,
  is_system boolean not null default true,
  created_at timestamptz not null default now(),
  constraint ledger_accounts_org_code_uidx unique (organization_id, code),
  constraint ledger_accounts_org_id_uidx unique (organization_id, id)
);

create table ledger_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  account_id uuid not null,
  customer_id uuid,
  supplier_id uuid,
  party_type party_type_enum generated always as (
    case
      when customer_id is not null then 'customer'::party_type_enum
      when supplier_id is not null then 'supplier'::party_type_enum
      else null
    end
  ) stored,
  debit_amount numeric(14,2) not null default 0 check (debit_amount >= 0),
  credit_amount numeric(14,2) not null default 0 check (credit_amount >= 0),
  reference_type varchar(30) not null,
  reference_id uuid not null,
  entry_date date not null,
  description varchar(255),
  created_at timestamptz not null default now(),
  constraint ledger_entries_one_sided_check check (
    (debit_amount > 0 and credit_amount = 0) or (credit_amount > 0 and debit_amount = 0)
  ),
  constraint ledger_entries_one_party_check check (not (customer_id is not null and supplier_id is not null)),
  constraint ledger_entries_account_fk foreign key (organization_id, account_id) references ledger_accounts (organization_id, id) on delete restrict,
  constraint ledger_entries_customer_fk foreign key (organization_id, customer_id) references customers (organization_id, id),
  constraint ledger_entries_supplier_fk foreign key (organization_id, supplier_id) references suppliers (organization_id, id)
);
create index ledger_entries_org_account_date_idx on ledger_entries (organization_id, account_id, entry_date);
create index ledger_entries_org_customer_idx on ledger_entries (organization_id, customer_id);
create index ledger_entries_org_supplier_idx on ledger_entries (organization_id, supplier_id);
create index ledger_entries_reference_idx on ledger_entries (reference_type, reference_id);

create table stock_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  product_variant_id uuid not null,
  movement_type stock_movement_type_enum not null,
  quantity integer not null check (quantity <> 0),
  reference_type varchar(30) not null,
  reference_id uuid not null,
  movement_date date not null default current_date,
  created_at timestamptz not null default now(),
  constraint stock_movements_variant_fk foreign key (organization_id, product_variant_id) references product_variants (organization_id, id) on delete restrict
);
create index stock_movements_org_variant_date_idx on stock_movements (organization_id, product_variant_id, movement_date);
create index stock_movements_reference_idx on stock_movements (reference_type, reference_id);

commit;
