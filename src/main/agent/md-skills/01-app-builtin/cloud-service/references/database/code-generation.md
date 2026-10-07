# Database · Write App Code

Integrate the cloud service database into a **published** app and produce runnable business code
(CRUD, conditional queries, pagination) on top of managed PostgreSQL.

> Read this file only when you need to **write data-access code for the app**. Creating tables /
> RLS policies / functions, seeding data, or inspecting existing data → read `management.md`.

The database client is PostgREST-based and its API mirrors **supabase-js** (`from().select()...`,
`{ data, error }` envelope). Do **not** reach for `@cloudbase/js-sdk`, `app.rdb(...)`,
`tcloudbasegateway.com`, or any CloudBase-specific calls — the app talks only to
`@tencent-ai/workbuddy-cloud-sdk` (npm `@tencent-ai/workbuddy-cloud-sdk@dev`,
or the CDN `index.global.js` global `WorkBuddyCloud` for plain HTML).

## Prerequisites

1. The cloud service environment is confirmed usable per **Environment Lifecycle** in `SKILL.md` —
   `billingStatus` is `normal` or `expiring`, and `provisionStatus` is `assigned`.
2. The client is initialized once per **How an App Talks to It** in `SKILL.md`. **Do not restate
   initialization here**, do not create a second client, and do not hand-write `fetch` against
   `/.cloud/database/rest/**`.
3. The tables and their RLS policies already exist (created via `management.md`). App code never
   runs DDL.

## Auth Gate for User-Scoped Rows

If a query touches user-scoped rows, follow Auth's **Mandatory Auth Gate for User Data** before
calling `cloud.database`. Anonymous login is unavailable in phase one; do not add anonymous login,
mock sessions or localStorage-only users to make a protected query pass.

Only explicitly public-read tables may be queried before sign-in. For private or owner-scoped data,
render the login/signup UI until `cloud.auth.getSession()` returns a session, then let the shared
client attach that session automatically. The app must still omit `owner_id`; `DEFAULT auth.uid()`
and RLS own that field.

## The Database Client

`cloud.database` is the `WorkBuddyDatabaseModule` — a thin facade over supabase's PostgREST client.
Every query chains from `cloud.database.from(table)` and resolves to `{ data, error }`; PostgreSQL
functions are called with `cloud.database.rpc(...)`. Identity is automatic: after the user logs in
via `cloud.auth`, the shared request layer attaches the current session to each database request.
**Never pass a token, user id, or owner id by hand.**

```ts
const { data, error } = await cloud.database.from('items').select('*')
```

## supabase-js Compatibility (what carries over, what doesn't)

`cloud.database` wraps supabase's PostgREST client (`@supabase/postgrest-js`), so the `from()`/
`rpc()` query-builder surface behaves exactly like supabase-js:

- All filters: `eq/neq/gt/gte/lt/lte/like/likeAllOf/likeAnyOf/ilike/ilikeAllOf/ilikeAnyOf/is/in/`
  `contains/containedBy/rangeGt/rangeGte/rangeLt/rangeLte/rangeAdjacent/overlaps/textSearch/`
  `match/not/or/filter`.
- All transforms: `select/order/limit/range/single/maybeSingle/csv/geojson/explain/abortSignal/`
  `returns`, plus `insert/upsert/update/delete`.
- Write + count semantics are real PostgREST: `.select()` after a write **returns the rows**
  (`Prefer: return=representation`), and `{ count: 'exact' }` reads `Content-Range`. There is **no**
  CloudBase-style 406 on chained `.select()` after `insert`.

When in doubt about a builder method, the supabase-js `.from()` docs apply verbatim. The
**differences** are only at the edges — do not copy these from supabase docs:

- **No `createClient(url, anonKey)`.** The client is `createWorkBuddyCloud({ endpoint,
  publishableKey }).database`, with both values taken from `publicConfig` — `endpoint` is required,
  never omit it (see `SKILL.md`). For strongly-typed rows, pass a generated
  schema type just like supabase's `createClient<Database>()`:
  ```ts
  import type { Database } from './database.types' // from the schema type generator
  const cloud = createWorkBuddyCloud<Database>({
    endpoint: publicConfig.endpoint,
    publishableKey: publicConfig.publishableKey,
  })
  // cloud.database.from('items') is now fully typed
  ```
  Without the generic, rows are untyped (`any`) — runtime behavior is identical.
- **No `apikey` header, no manual `Authorization`.** The shared fetch injects the publishable key
  and the signed-in session automatically. Never set auth headers, never pass an `anonKey`.
- **Auth is WorkBuddy's, not GoTrue.** Identity comes from `cloud.auth`; `auth.uid()` returns
  **text**, not a uuid.
- **`public` schema only.** The facade deliberately does **not** expose `.schema(...)`, and the data
  plane rejects `auth` / `pg_catalog` / `information_schema` / `pg_`-prefixed schemas. Everything the
  app touches lives in `public`.

A thin helper to turn the envelope into throw-on-error keeps call sites clean:

```ts
function unwrap<T>({ data, error }: { data: T; error: unknown }): T {
  if (error) throw error
  return data
}
```

## Modeling Conventions (must match what `management.md` created)

The standard shape for a user-scoped table:

- `id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
- `owner_id TEXT NOT NULL DEFAULT auth.uid()` — the owner column. **Type is `text`**, because
  `auth.uid()` returns text (e.g. `EchhGXFadSANiCSaVim2wQ`), not a uuid.
- `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`

The client **must not send `owner_id`** on insert — the database fills it from `DEFAULT auth.uid()`,
and the RLS insert policy rejects any row whose `owner_id` is not the caller. Sending it by hand is
redundant at best and rejected at worst.

## SELECT — Query data

```ts
// Filters + order + limit
const { data, error } = await cloud.database
  .from('items')
  .select('id, title, created_at')
  .eq('status', 'published')
  .order('created_at', { ascending: false })
  .limit(20)

// Specific columns
const { data } = await cloud.database.from('items').select('id, title, status')

// Single row (errors unless exactly one row)
const { data } = await cloud.database.from('items').select('*').eq('id', 42).single()

// Maybe single (null if not found, no error; errors if > 1 row)
const { data } = await cloud.database.from('items').select('*').eq('id', 42).maybeSingle()

// Pagination with total count
const from = (page - 1) * pageSize
const to = from + pageSize - 1
const { data, count } = await cloud.database
  .from('items')
  .select('*', { count: 'exact' })
  .order('created_at', { ascending: false })
  .range(from, to)

// Count only, no rows
const { count } = await cloud.database.from('items').select('*', { count: 'exact', head: true })

// Multiple filters (AND)
const { data } = await cloud.database
  .from('items')
  .select('*')
  .gte('created_at', '2024-01-01')
  .ilike('title', '%search%')
  .in('status', ['published', 'featured'])

// OR
const { data } = await cloud.database
  .from('items')
  .select('*')
  .or('status.eq.published,status.eq.featured')

// NULL / NOT NULL
const { data } = await cloud.database.from('items').select('*').is('deleted_at', null)
const { data } = await cloud.database.from('items').select('*').not('deleted_at', 'is', null)

// Multi-column equality
const { data } = await cloud.database.from('items').select('*').match({ status: 'published', lang: 'en' })

// Foreign key join (embedded resource)
const { data } = await cloud.database.from('items').select(`
  id, title, created_at,
  category:categories(id, name)
`).eq('status', 'published')

// Full-text search
const { data } = await cloud.database
  .from('items')
  .select('*')
  .textSearch('content', 'search query', { type: 'websearch', config: 'simple' })

// Array / JSONB contains
const { data } = await cloud.database.from('items').select('*').contains('tags', ['tech', 'ai'])
```

## INSERT — Create data

`owner_id` is omitted on purpose (`DEFAULT auth.uid()` fills it). Chain `.select()` to get the
created rows back.

```ts
// Single insert; request the created row
const { data, error } = await cloud.database
  .from('items')
  .insert({ title: 'New Item', content: 'Hello', status: 'draft' })
  .select()
const created = data?.[0]

// Batch insert
const { error } = await cloud.database.from('items').insert([
  { title: 'Item A', content: 'Content A' },
  { title: 'Item B', content: 'Content B' },
])

// Upsert — update on conflict
const { error } = await cloud.database
  .from('items')
  .upsert({ id: 42, title: 'Updated or Created', content: '...' })

// Upsert — ignore on conflict
const { error } = await cloud.database
  .from('items')
  .upsert({ id: 42, title: 'Skip if exists' }, { ignoreDuplicates: true })
```

**Do not pass `null` to trigger a column default** — omit the field. An explicit `null` overrides
`DEFAULT auth.uid()` / `DEFAULT now()`:

```ts
// CORRECT — omit owner_id, let DEFAULT auth.uid() fill it
await cloud.database.from('items').insert({ title: 'New', content: 'Hello' })

// WRONG — explicit null overrides the DEFAULT and is rejected by RLS
await cloud.database.from('items').insert({ title: 'New', owner_id: null })
```

## UPDATE — Modify data

```ts
const { data, error } = await cloud.database
  .from('items')
  .update({ title: 'Updated Title', status: 'published' })
  .eq('id', 42)
  .select()
```

**An empty result array means RLS blocked the write — not that it succeeded.** RLS filters out rows
the caller may not touch, so a cross-owner update returns `data: []` with no `error`. `.select()` is
required to tell "affected 0 rows" apart from "updated". Always branch:

```ts
const affected = Array.isArray(data) ? data : []
if (affected.length === 0) {
  // Not found, or the row is not owned by the current user (RLS filtered it).
  showMessage('Nothing was changed — the item may not exist or is not yours.')
}
```

Never add a WHERE-less update. Always constrain by `.eq('id', …)` or a specific condition.

## DELETE — Remove data

```ts
// Delete by id; .select() reports what was actually removed
const { data } = await cloud.database.from('items').delete().eq('id', 42).select()
const removed = Array.isArray(data) ? data : []
// removed.length === 0 → RLS blocked it or the row did not exist.

// Delete by condition
await cloud.database
  .from('items')
  .delete()
  .eq('status', 'archived')
  .lt('created_at', '2023-01-01')
```

## Calling PostgreSQL Functions (RPC)

Functions are created through `management.md`. Call them via `cloud.database.rpc()` — same
supabase-style API. The result is a filter builder, so you can chain `.select()/.order()/.limit()`
on set-returning functions.

```ts
// Scalar / JSON function
const { data, error } = await cloud.database.rpc('get_item_stats')

// Function with parameters
const { data } = await cloud.database.rpc('add_numbers', { a: 1, b: 2 })

// Set-returning function, filtered on the result
const { data } = await cloud.database
  .rpc('search_items', { keyword: 'hello' })
  .select('id, title')
  .order('created_at', { ascending: false })
  .limit(10)
```

## Filter operators

| Method | SQL | Example |
|--------|-----|---------|
| `.eq(col, val)` | `=` | `.eq('status', 'published')` |
| `.neq(col, val)` | `!=` | `.neq('status', 'draft')` |
| `.gt(col, val)` | `>` | `.gt('price', 100)` |
| `.gte(col, val)` | `>=` | `.gte('created_at', '2024-01-01')` |
| `.lt(col, val)` | `<` | `.lt('price', 50)` |
| `.lte(col, val)` | `<=` | `.lte('age', 18)` |
| `.like(col, pat)` | `LIKE` | `.like('title', '%cloud%')` |
| `.ilike(col, pat)` | `ILIKE` | `.ilike('title', '%cloud%')` |
| `.is(col, val)` | `IS` | `.is('deleted_at', null)` |
| `.in(col, arr)` | `IN` | `.in('id', [1, 2, 3])` |
| `.contains(col, val)` | `@>` | `.contains('tags', ['tech'])` |
| `.containedBy(col, val)` | `<@` | `.containedBy('tags', ['a','b','c'])` |
| `.overlaps(col, val)` | `&&` | `.overlaps('tags', ['tech'])` |
| `.not(col, op, val)` | `NOT` | `.not('status', 'eq', 'deleted')` |
| `.or(filters)` | `OR` | `.or('status.eq.published,featured.eq.true')` |
| `.match(obj)` | multi `=` | `.match({ status: 'published', lang: 'en' })` |
| `.textSearch(col, q)` | `@@` | `.textSearch('content', 'query')` |

## Modifier methods

| Method | Description | Example |
|--------|-------------|---------|
| `.order(col, opts)` | Sort | `.order('created_at', { ascending: false })` |
| `.limit(n)` | Limit rows | `.limit(20)` |
| `.range(from, to)` | Pagination (0-based inclusive) | `.range(0, 19)` |
| `.single()` | One object (error if != 1 row) | `.eq('id', 42).single()` |
| `.maybeSingle()` | Object or null (error if > 1) | `.eq('id', 42).maybeSingle()` |
| `.select(cols, opts)` | Columns + count | `.select('*', { count: 'exact' })` |

## Working With Auth (per-user data isolation)

Security lives in the database (RLS), not the front end. Do **not** filter "is this row mine?" in
JS — that only affects what you display, not what the server allows. The pattern:

- Every user-scoped table has `owner_id TEXT DEFAULT auth.uid()` and RLS policies (see
  `management.md`).
- The front end never sends `owner_id`; the DB fills and enforces it.
- Use `owner_id` only to decide **UI affordances** (e.g. whether to show an edit button), never as
  a security boundary.
- After `cloud.auth` sign-in, database requests automatically carry the session — no code change in
  the data layer on login/logout/refresh.

## Error Handling

Every call returns `{ data, error }`. Branch on `error`, and treat these Postgres codes specially:

| Situation | Signal | What to do |
|---|---|---|
| Not signed in / RLS denied write | `error` present, or write returns `[]` | Prompt sign-in, or tell the user the row isn't theirs |
| Table does not exist | `42P01` | The table wasn't created — go create it via `management.md` |
| Permission / RLS denied | `42501` | Table not granted to the role, or RLS filtered the row |
| Unique constraint violation | `23505` | Duplicate key — surface a friendly "already exists" |

```ts
const { data, error } = await cloud.database.from('items').insert({ title })
if (error) {
  if (error.code === '23505') return showMessage('That item already exists.')
  if (error.code === '42501') return showMessage('You are not allowed to do that.')
  return showMessage(error.message)
}
```

Never print raw rows, tokens, emails or phone numbers into logs or user-facing errors.

## Completion Bar

Written data reads back; conditional queries and pagination return correct results; cross-owner
writes return an empty array and are surfaced (not silently treated as success); not-signed-in and
permission-denied produce a clear message instead of failing silently.
