-- ============================================================
-- RENEO BACKEND — FULL SCHEMA MIGRATION
-- Run this against a fresh Supabase/Postgres database to
-- recreate the entire schema, RLS policies, and functions.
-- ============================================================

-- ==========================================
-- ENUMS
-- ==========================================
create type user_role as enum ('SELLER', 'CUSTOMER');
create type order_status as enum ('PENDING', 'CONFIRMED', 'CANCELLED');

-- ==========================================
-- TABLES
-- ==========================================

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role user_role not null,
  full_name text not null,
  created_at timestamptz not null default now()
);

create table stores (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles(id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now()
);

create table products (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  name text not null,
  description text,
  category text not null,
  price_minor_units integer not null check (price_minor_units >= 0),
  currency text not null default 'XOF',
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table inventory (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null unique references products(id) on delete cascade,
  stock integer not null default 0 check (stock >= 0),
  updated_at timestamptz not null default now()
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references profiles(id) on delete cascade,
  status order_status not null default 'PENDING',
  total_minor_units integer not null check (total_minor_units >= 0),
  idempotency_key text unique,
  created_at timestamptz not null default now()
);

create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  product_id uuid not null references products(id),
  seller_id uuid not null references profiles(id),
  quantity integer not null check (quantity > 0),
  unit_price_minor_units integer not null check (unit_price_minor_units >= 0),
  created_at timestamptz not null default now()
);

create table events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  order_id uuid references orders(id) on delete cascade,
  seller_id uuid references profiles(id),
  payload jsonb,
  created_at timestamptz not null default now()
);

-- ==========================================
-- INDEXES
-- ==========================================
create index idx_products_store on products(store_id);
create index idx_products_category on products(category);
create index idx_products_price on products(price_minor_units);
create index idx_products_archived on products(is_archived);
create index idx_products_search on products using gin (to_tsvector('english', name || ' ' || coalesce(description, '')));

create index idx_orders_customer on orders(customer_id);
create index idx_order_items_order on order_items(order_id);
create index idx_order_items_seller on order_items(seller_id);

-- ==========================================
-- ROW LEVEL SECURITY
-- ==========================================
alter table profiles enable row level security;
alter table stores enable row level security;
alter table products enable row level security;
alter table inventory enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table events enable row level security;

-- PROFILES
create policy "Users can view own profile" on profiles for select using (auth.uid() = id);
create policy "Users can update own profile" on profiles for update using (auth.uid() = id);
create policy "Users can insert own profile" on profiles for insert with check (auth.uid() = id);

-- STORES
create policy "Anyone can view stores" on stores for select using (true);
create policy "Sellers manage own stores" on stores for insert with check (auth.uid() = owner_id);
create policy "Sellers update own stores" on stores for update using (auth.uid() = owner_id);
create policy "Sellers delete own stores" on stores for delete using (auth.uid() = owner_id);

-- PRODUCTS
create policy "Anyone can view non-archived products"
on products for select
using (is_archived = false or store_id in (select id from stores where owner_id = auth.uid()));

create policy "Sellers insert own products"
on products for insert
with check (store_id in (select id from stores where owner_id = auth.uid()));

create policy "Sellers update own products"
on products for update
using (store_id in (select id from stores where owner_id = auth.uid()));

create policy "Sellers delete own products"
on products for delete
using (store_id in (select id from stores where owner_id = auth.uid()));

-- INVENTORY
create policy "Anyone can view inventory" on inventory for select using (true);
create policy "Sellers manage own inventory"
on inventory for all
using (product_id in (
  select p.id from products p
  join stores s on p.store_id = s.id
  where s.owner_id = auth.uid()
));

-- ORDERS (uses helper function to avoid RLS recursion — see below)
create policy "Customers view own orders" on orders for select using (auth.uid() = customer_id);
create policy "Customers create own orders" on orders for insert with check (auth.uid() = customer_id);

-- ORDER_ITEMS
create policy "Customers view own order items"
on order_items for select
using (order_id in (select id from orders where customer_id = auth.uid()));

create policy "Sellers view their order items" on order_items for select using (auth.uid() = seller_id);

create policy "System inserts order items"
on order_items for insert
with check (order_id in (select id from orders where customer_id = auth.uid()));

-- EVENTS
create policy "Sellers view their own events" on events for select using (auth.uid() = seller_id);

-- ==========================================
-- HELPER FUNCTION: breaks RLS recursion between
-- orders <-> order_items policies
-- ==========================================
create or replace function seller_order_ids(seller uuid)
returns setof uuid
language sql
security definer
set search_path = public
as $$
  select order_id from order_items where seller_id = seller;
$$;

create policy "Sellers view orders containing their products"
on orders for select
using (id in (select seller_order_ids(auth.uid())));

-- ==========================================
-- CORE FUNCTION: place_order
-- Atomic, concurrency-safe order creation with
-- server-resolved pricing, stock checks, and
-- ORDER_CREATED event emission.
-- ==========================================
create or replace function place_order(
  p_customer_id uuid,
  p_items jsonb,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_total integer := 0;
  v_item jsonb;
  v_product record;
  v_updated_rows integer;
  v_sellers uuid[] := '{}';
begin
  insert into orders (customer_id, status, total_minor_units, idempotency_key)
  values (p_customer_id, 'PENDING', 0, p_idempotency_key)
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select p.id, p.price_minor_units, p.is_archived, s.owner_id as seller_id
    into v_product
    from products p
    join stores s on p.store_id = s.id
    where p.id = (v_item->>'product_id')::uuid;

    if not found then
      raise exception 'PRODUCT_NOT_FOUND:%', v_item->>'product_id';
    end if;

    if v_product.is_archived then
      raise exception 'PRODUCT_UNAVAILABLE:%', v_product.id;
    end if;

    update inventory
    set stock = stock - (v_item->>'quantity')::integer,
        updated_at = now()
    where product_id = v_product.id
      and stock >= (v_item->>'quantity')::integer;

    get diagnostics v_updated_rows = row_count;

    if v_updated_rows = 0 then
      raise exception 'OUT_OF_STOCK:%', v_product.id;
    end if;

    insert into order_items (order_id, product_id, seller_id, quantity, unit_price_minor_units)
    values (
      v_order_id,
      v_product.id,
      v_product.seller_id,
      (v_item->>'quantity')::integer,
      v_product.price_minor_units
    );

    v_total := v_total + (v_product.price_minor_units * (v_item->>'quantity')::integer);

    if not (v_product.seller_id = any(v_sellers)) then
      v_sellers := array_append(v_sellers, v_product.seller_id);
    end if;
  end loop;

  update orders set status = 'CONFIRMED', total_minor_units = v_total where id = v_order_id;

  insert into events (event_type, order_id, seller_id, payload)
  select 'ORDER_CREATED', v_order_id, unnest(v_sellers), jsonb_build_object('order_id', v_order_id, 'total_minor_units', v_total);

  return jsonb_build_object('order_id', v_order_id, 'total_minor_units', v_total);
end;
$$;