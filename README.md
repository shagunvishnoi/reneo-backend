# Reneo Backend — Assessment Submission

This is my submission for the backend intern assessment. Node/TypeScript/Express API on top of Supabase (Postgres + Auth), with RLS doing most of the heavy lifting for access control.

I'll be upfront: I came into this with pretty limited backend experience and had never touched Supabase before this week. So some of what's below reflects real debugging, not just clean planning from day one. I think that's more useful to you than pretending everything went smoothly.

## How it's put together

Client → Express API → Supabase (Postgres, with RLS enforcing most of the security).

A couple of things worth knowing about the API layer before you look at the code:

- There are three different ways the code talks to Supabase, and which one gets used matters:
  - A client scoped to whoever's logged in (their own JWT) — used for most seller actions, since it means their own RLS policies apply and I don't have to re-check ownership manually.
  - An admin client using the secret key, which bypasses RLS entirely. I only use this for order placement, because customers don't (and shouldn't) have direct write access to `inventory`, but the order-placement logic needs to touch it. The trust boundary here is the database function itself, not the client's role — more on that below.
  - A public, unauthenticated client for product search, since anyone should be able to browse products without logging in.
- The actual "place an order safely" logic lives inside a Postgres function, not in the TypeScript code. I'll explain why in the concurrency section — it wasn't the first thing I tried.

## Setup

Need Node 20+ and a Supabase project (free tier's fine).

Copy `.env.example` to `.env` and fill in your Supabase URL and keys.

```bash
npm install
npm run dev
```

Then run the migration file (`supabase/migrations/001_initial_schema.sql`) in your Supabase SQL Editor — it builds everything: tables, indexes, RLS policies, and the two database functions the order flow depends on.

One thing that tripped me up and will probably trip you up too if you're setting this up fresh: in Supabase, under Settings → Data API, there's an "exposed tables" setting that's completely separate from RLS. I had RLS correctly locked down but the tables still weren't reachable through the API at all until I found this. Make sure all 7 tables are toggled on there.

### Test accounts

I tested everything against three manually-created users:

| Email | Password | Role |
|---|---|---|
| seller1@test.com | Test1234! | SELLER |
| seller2@test.com | Test1234! | SELLER |
| customer1@test.com | Test1234! | CUSTOMER |

Create these in Supabase Auth (auto-confirm so you skip email verification), then add a matching row for each in `profiles` manually, e.g.:
```sql
insert into profiles (id, role, full_name)
values ('<their-auth-uuid>', 'SELLER', 'Test Seller One');
```

### Running the tests

```bash
npm test
```

## Schema decisions

I wasn't given the columns on purpose — that was the exercise — so here's the reasoning behind the choices that felt like they actually mattered.

**Money is stored as `price_minor_units`, an integer, not a float or decimal.** Floats have rounding errors that are just not okay for money — that's not really debatable. `numeric`/`decimal` is the "proper" alternative but has more overhead, and since FCFA doesn't really subdivide in practice, storing price as a plain integer in its smallest unit felt like the simplest thing that's still correct. There's a `check (price_minor_units >= 0)` too, so the database itself won't accept a negative price even if something upstream messes up.

**UUIDs everywhere instead of auto-increment IDs.** Partly because sequential IDs leak information (anyone can guess roughly how many orders you have), and partly because Supabase's whole RLS pattern assumes UUID-based `auth.uid()` matching, so fighting that would've just been extra work.

**`profiles.id` is literally the same UUID as `auth.users.id`,** not its own separate key. Supabase's auth table only knows about login stuff — email, password hash. `profiles` is where the actual app-relevant data lives (role, name), and linking them 1-to-1 this way means deleting a user cleanly cascades to their profile with zero manual cleanup.

**`order_items.seller_id` is duplicated data, on purpose.** Technically you could always derive the seller by joining `product → store → owner`, but doing that inside every RLS policy check gets messy and slow. Storing it directly at order-creation time also just makes more sense conceptually — it's a record of who the seller *was* at the time of that order, which shouldn't retroactively change even if the product moves stores later.

I didn't add a constraint forcing one store per seller. The brief doesn't require it, and I figured letting the schema support multiple stores per seller was more realistic anyway — I just only used one store per test seller for the actual testing.

## Auth & RLS

Supabase Auth handles login; `profiles.role` is what the app actually checks for authorization. RLS is turned on for all 7 tables, and — this matters — every table started **locked with zero policies** and I opened things up one policy at a time, rather than starting open and trying to lock things down after the fact. Felt like the safer direction to work in.

I actually tested this instead of just trusting it looks right: logged in as seller1, grabbed a real token, and tried to create a product under seller2's store using that token. Got this back:

```json
{"error": {"code": 403, "detail": "new row violates row-level security policy for table \"products\""}}
```

That's Postgres itself refusing it — not my API code catching it after the fact.

One genuine snag: I originally wrote RLS policies where `orders` checks `order_items` (so sellers can see orders containing their stuff) and `order_items` checks `orders` (so customers can see their own items) — and Postgres threw "infinite recursion detected in policy," because each one was waiting on the other. Fixed it with a small `security definer` function (`seller_order_ids`) that does the seller-side lookup with elevated permissions, which breaks the circular check without actually loosening who can see what.

## Concurrency (the big one)

Stock = 1, two customers order it at the same instant — only one should win.

**What I tried first, and why it's wrong:** the obvious approach is read the stock, check if it's > 0, then write the decremented value. I actually built this version first. The problem is those are two separate steps with a gap in between — two requests can both read "stock = 1" before either has written anything back, and both proceed to decrement. Stock goes negative, two orders get created for one item.

**What actually works:** do the check and the decrement as one single SQL statement:

```sql
update inventory
set stock = stock - <qty>
where product_id = <id> and stock >= <qty>;
```

A single `UPDATE` in Postgres is atomic — there's no gap for another request to sneak into. When two requests hit the same row at once, Postgres locks that row for the first one, lets it finish, then runs the second one against the now-updated value. If stock's already gone by then, the second update's `WHERE` clause matches zero rows, and I check that (`row_count`) in the function and throw an `OUT_OF_STOCK` error, which the API turns into a 409.

I didn't write any manual locking, retry logic, or mutex — Postgres's row-level locking does this for you automatically as long as you structure the query as one atomic statement instead of read-then-write.

The whole order — the order row, order items, stock decrement, event — happens inside one Postgres function, so it's also one transaction. If anything in there fails partway, the whole thing rolls back, nothing partial gets left behind.

I actually proved this works, not just reasoned about it — wrote a test that fires two order requests via `Promise.all` (so they're genuinely simultaneous, not one-then-the-other) against a product with stock = 1:

```
✓ Scenario 5: Two simultaneous orders for the last item
  ✓ should result in exactly one success  888ms
```

One came back 201, the other 409 with `OUT_OF_STOCK` in the detail. Also checked it manually with a standalone script before I turned it into a real test, just to see it happen with my own eyes first.

## Orders & server-owned pricing

The client only ever sends `product_id` and `quantity` — no price field exists in the expected payload. If someone tries to sneak in `"price": 500`, the API rejects it outright with a 400 before touching the database at all. The real price gets looked up server-side, inside the same order function, from the current `products` table.

I tested this specifically — sent a normal order (worked, correct total computed server-side) and then a second one with a fake `price` field injected, which correctly got rejected. That's the exact "attacker changes 50,000 to 500" scenario from the brief, and it's blocked.

## Idempotency

`POST /orders` takes an optional `idempotency_key`. If the same key shows up twice, the second call gets back the *original* order instead of creating a new one — checked first at the application level, with a `unique` constraint on the column as a backup in case two requests with the same key genuinely race each other before either finishes.

Keys just live on the order row forever — no separate expiring cache, since each key is naturally tied to one real order anyway.

**Honest gap:** if the same key comes in with a *different* item list, I don't currently detect that — it just returns the original order regardless. A more complete version would hash the payload and compare it. Didn't get to that.

Tested it by sending the exact same request twice — got the same `order_id` back both times, second response flagged as a duplicate, and stock only dropped once.

## Events (B3)

Order → event → notification. I went with a database `events` table rather than calling some notification service directly inside the order transaction — because tying "did the order succeed" to "did some external push service respond" felt like a bad idea. The event row gets written inside the *same transaction* as the order, so:

- if the order fails, the event never gets created either (whole thing rolls back together)
- if the order succeeds, the event is guaranteed to exist
- the actual "push it to the seller" step is a separate, later concern — something like a Supabase Realtime subscription reading off this table — and if *that* fails, nothing about the order or event is lost, since the row's just sitting there and can be retried or polled later

I built the "record the event" half properly and tested it — a real `ORDER_CREATED` row shows up, correctly linked to the order and the right seller. I didn't build the actual live push/webhook delivery on top of it — ran out of time for that layer specifically.

## Search & pagination

`GET /products/search` is public, supports text search, category, price range, in-stock filtering, sorting, and pagination (capped at 100 per page so nobody can request a massive page and hammer the server).

Ran `EXPLAIN ANALYZE` on the main filtered query to check it's actually using the indexes I built, not scanning the whole table:

```
Limit  (cost=3.41..3.41 rows=1 width=181) (actual time=0.067..0.068 rows=1 loops=1)
  ->  Sort  (cost=3.41..3.41 rows=1 width=181) (actual time=0.066..0.066 rows=1 loops=1)
        Sort Key: created_at DESC
        Sort Method: quicksort  Memory: 25kB
        ->  Bitmap Heap Scan on products  (cost=1.26..3.40 rows=1 width=181)
              Recheck Cond: (category = 'Electronics'::text)
              Filter: (NOT is_archived)
              Heap Blocks: exact=1
              ->  Bitmap Index Scan on idx_products_category
                    Index Cond: (category = 'Electronics'::text)
Planning Time: 0.639 ms
Execution Time: 0.150 ms
```

The `Bitmap Index Scan on idx_products_category` line is the part that matters — Postgres is going through the index, not scanning every row. With only a couple of test products this doesn't actually matter for speed, but the query *plan* is the right shape, and that's what should hold up as the table grows toward the brief's "1 million products" scenario rather than degrading into a full scan.

**Gap I'm aware of:** the `in_stock` filter happens after the data comes back, in JS, not as part of the SQL query — because it depends on a joined table in a way I didn't figure out how to express cleanly in the query builder I was using. Fine at this scale, not fine at real scale — should be pushed into SQL.

## What I didn't get to / would do next (D2)

- A seller-facing endpoint to list their own orders — the RLS policy for it already exists, I just didn't write the route
- Move `in_stock` filtering into SQL instead of post-fetch
- Actually detect a changed payload on a reused idempotency key
- Build the real notification delivery on top of the events table (Realtime subscription or a worker)
- Basic logging/metrics — right now there's genuinely nothing beyond console output
- Test the search endpoint against real volume instead of a handful of rows — the EXPLAIN output confirms the index is used, but I never generated enough fake data to see real numbers at scale

## Scaling (D1)

If this went from ~100 users to 10 million, several million products, high order volume — here's what I think breaks first and why, based on what I actually built.

**The single Postgres instance handling everything** is the first real bottleneck, for a few specific reasons:

1. Product search is read-heavy and would be constantly competing with order-placement writes on the same database.
2. The row-level lock I rely on for concurrency-safe stock (see above) is correct at any scale, but its *cost* isn't free — if one specific product gets ordered thousands of times a second, every one of those orders has to wait its turn on that one row's lock. That's the same mechanism that makes B1 correct becoming a real throughput ceiling under enough load.
3. Postgres has a hard connection limit, and a fleet of API servers each opening their own connections will hit that limit well before CPU or memory become the problem.

How I'd evolve it: read replicas for the browse/search path (a little staleness there is fine; staleness on stock during checkout is not, so that stays against the primary), caching in front of product search and hot product lookups, a queue between "order placed" and "seller notified" instead of anything synchronous, and connection pooling (Supabase has PgBouncer built in) once there's more than one API instance. If a single `products` table genuinely becomes too large to index/vacuum efficiently, I'd look at partitioning by store or category, since most queries already filter by one of those anyway.

What I wouldn't do yet: jump to sharding before read replicas and caching are actually maxed out — sharding adds a lot of operational complexity for a problem caching might solve first. And I wouldn't move off Postgres to something like a NoSQL store — the strict guarantees I'm leaning on directly (RLS, atomic stock updates, foreign keys) are exactly the stuff a document store makes harder, not easier.

```
Clients
   |
API servers (stateless, scaled horizontally)
   |              |
writes/orders   search/browse reads
   |              |
Postgres ------> read replica(s)
(primary)
   |
   | order events
   v
 Queue --> notification workers

(Cache sits in front of search/hot product reads)
```

## About AI usage (D3)

I used Claude throughout this build, mainly for two things: working through Supabase-specific setup I hadn't dealt with before, and talking through the concurrency design before committing to an approach.

A few concrete examples worth naming specifically:

- **The concurrency fix.** I started with a read-then-write version of the stock check, and walked through with Claude exactly why that has a race window and how a single atomic `UPDATE ... WHERE stock >= quantity` closes it — the "check and act in one statement" pattern. I rebuilt it that way and then proved it holds with the concurrent test in Scenario 5, rather than taking it on faith.
- **The RLS recursion bug.** Hit a genuine "infinite recursion detected in policy" error from Postgres when two policies referenced each other's tables, and worked through the `security definer` helper-function pattern as the fix.
- **Environment/tooling issues** — a `dotenv` import-ordering bug, a Node/WebSocket compatibility gap in Supabase's client, and Supabase's separate "exposed tables" Data API setting (distinct from RLS) — all real errors I hit and resolved with Claude's help rather than pre-planned.

The testing strategy itself — deliberately racing two requests instead of testing sequentially, deliberately testing cross-seller RLS denial rather than assuming it works, setting stock to exactly 1 to force a genuine last-item scenario — was my own reasoning about what actually needed proving, not something handed to me.

I'm using the time before the follow-up interview to go back through the concurrency logic, the RLS policies, and the Supabase setup in more depth, since I know that's the part of a live walkthrough where surface-level familiarity won't hold up.