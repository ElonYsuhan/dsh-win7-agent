# Database · Set Up and Manage Data

Create the schema an app needs (tables, RLS policies, functions), seed initial data, and inspect or
maintain existing data. All of this runs through the built-in **MCP tools** — never through a
front-end SDK, never through a shell script, never by hitting a provider console directly.

> Read this file when you need to **initialize or maintain the database**: create tables during app
> setup, define RLS, seed rows, browse structure, fix data. To write data-access code that ships
> **inside the app** → read `code-generation.md`.

## Prerequisites

The cloud service environment is confirmed present and usable per **Environment Lifecycle** in
`SKILL.md`. When `billingStatus` is `credits_exhausted`, reads and writes both fail — resolve
billing first. When `provisionStatus` is not `assigned`, wait for provisioning; do not run SQL
against an environment that isn't ready.

## The MCP Tools (the only execution path)

Schema and data operations go through these built-in tools. Prefer the structured read-only tools
for inspection; use `workbuddy_cloudservice_db_exec_sql` when you actually need to run SQL.

| Tool | Purpose | Model-visible args |
|---|---|---|
| `workbuddy_cloudservice_db_list_tables` | List tables (with comments, RLS on/off). Read-only. | none |
| `workbuddy_cloudservice_db_describe_table` | Columns of one table (type, nullable, default, PK). Read-only. | `{ table }` |
| `workbuddy_cloudservice_db_list_rls` | All RLS policies in the app database. Read-only. | none |
| `workbuddy_cloudservice_db_exec_sql` | Run **one** SQL statement. | `{ mode, sql? , sqlBase64?, parameters? }` |

Hard rules for every call:

- **`applicationId` is injected by the trusted WorkBuddy side — you do not pass it, and you must not
  try to.** Choosing the application would mean choosing which environment to hit; that is not the
  model's call. If a tool reports the application is missing, stop and report it.
- **If a call fails saying the workspace has more than one cloud application, stop and ask the user
  which one to target.** Do not guess, and do not retry with a different tool hoping it resolves —
  every tool on this page resolves the application the same way. Operating on the wrong application
  writes to real business data and cannot be rolled back.
- **One statement per `exec_sql` call.** Multiple statements return
  `cannot insert multiple commands into a prepared statement`. Split them; issue one call each.
- **The role is derived from `mode`, never specified.** You cannot request a privileged role.
  - `mode: "read"` — read-only queries (`SELECT`, schema inspection).
  - `mode: "write"` — data changes (`INSERT` / `UPDATE` / `DELETE`).
  - `mode: "migrate"` — DDL and privileges (`CREATE TABLE`, `ALTER`, RLS, `CREATE FUNCTION`,
    `GRANT` / `REVOKE`).
- `sql` and `sqlBase64` are two ways to pass the **same** statement — supply one. When the SQL
  contains quotes, newlines or comments that are awkward to escape, base64-encode it into
  `sqlBase64`; it only avoids escaping and does not change execution.

Example call (arguments the model provides):

```json
{
  "name": "workbuddy_cloudservice_db_exec_sql",
  "arguments": {
    "mode": "migrate",
    "sql": "CREATE TABLE items (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY)"
  }
}
```

If the capability is not wired up in the current build, say so plainly and stop. Never invent a
tool name, never fall back to a raw HTTP/console path, never fake a success.

## Inspecting First

Before creating or changing anything, look at what's there — prefer the structured tools over
hand-written `SELECT`s:

- `workbuddy_cloudservice_db_list_tables` — what exists and whether RLS is on.
- `workbuddy_cloudservice_db_describe_table` `{ table: "items" }` — the columns.
- `workbuddy_cloudservice_db_list_rls` — the policies in force.

Drop to `exec_sql` `mode: "read"` only for ad-hoc questions those tools don't answer:

```sql
SELECT status, COUNT(*) AS cnt FROM items GROUP BY status ORDER BY cnt DESC
```

## Creating Tables (app setup)

Run each statement as its own `exec_sql` `mode: "migrate"` call. Standard user-scoped shape:

```sql
CREATE TABLE items (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    TEXT        NOT NULL DEFAULT auth.uid(),
  owner_name  TEXT,
  title       TEXT        NOT NULL,
  content     TEXT,
  status      TEXT        DEFAULT 'draft',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

Conventions that matter:

- `owner_id` is **`TEXT`**, not `uuid` — `auth.uid()` returns text (e.g. `EchhGXFadSANiCSaVim2wQ`);
  declaring it `uuid` fails at table-create time with a type mismatch.
- `owner_id` carries `DEFAULT auth.uid()` — the owner is decided **server-side**. App code must not
  send it, and the INSERT policy below rejects any forged owner.
- `owner_name` is a display nickname only; it never participates in permission checks. All authz is
  on `owner_id`.

Table comment (shown in the DB management UI):

```sql
COMMENT ON TABLE items IS 'User content items with draft/publish workflow'
```

## RLS — Row Level Security

RLS is the security boundary. After `ENABLE ROW LEVEL SECURITY`, everything not explicitly allowed
by a policy is **denied by default**. Two independent gates must both pass:

1. **Table grant** — can this role touch the table at all (`GRANT ... TO ...`).
2. **Row policy** — which rows may it touch (`CREATE POLICY ...`).

Missing either gate produces `42501`, which looks like a broken policy but is often just a missing
grant.

### Roles

| Role | Who |
|---|---|
| `anon` | Not-yet-signed-in callers (publishable key only) |
| `authenticated` | Signed-in end users |

**Grant to `authenticated, anon` together** unless you specifically want to lock anonymous callers
out. Anonymous-login sessions carry the `anon` role; granting only `authenticated` makes their
writes fail with `42501` that reads like an RLS bug.

### `USING` vs `WITH CHECK`

- `USING` — which existing rows are visible to `SELECT` / `UPDATE` / `DELETE`.
- `WITH CHECK` — the condition a row must satisfy **after** an `INSERT`/`UPDATE`.
- `INSERT` has no existing row, so it uses only `WITH CHECK`.
- For `UPDATE`, write **both**: `USING` alone lets a user re-assign a row's `owner_id` to someone
  else (giving the row away); `WITH CHECK` stops that.

PostgreSQL has no `CREATE POLICY IF NOT EXISTS`, so always `DROP POLICY IF EXISTS` first. This makes
setup idempotent.

### Pattern: public read, owner-only writes (the common one)

Each line is a separate `exec_sql` `mode: "migrate"` call.

```sql
ALTER TABLE items ENABLE ROW LEVEL SECURITY
```
```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.items TO authenticated, anon
```
```sql
DROP POLICY IF EXISTS items_read_all ON items
```
```sql
CREATE POLICY items_read_all ON items FOR SELECT TO authenticated, anon USING (true)
```
```sql
DROP POLICY IF EXISTS items_insert_own ON items
```
```sql
CREATE POLICY items_insert_own ON items FOR INSERT TO authenticated, anon WITH CHECK (owner_id = auth.uid())
```
```sql
DROP POLICY IF EXISTS items_update_own ON items
```
```sql
CREATE POLICY items_update_own ON items FOR UPDATE TO authenticated, anon USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid())
```
```sql
DROP POLICY IF EXISTS items_delete_own ON items
```
```sql
CREATE POLICY items_delete_own ON items FOR DELETE TO authenticated, anon USING (owner_id = auth.uid())
```

### Other common shapes

- **Owner-only (private data)**: same as above but `SELECT` uses `USING (owner_id = auth.uid())`.
- **Public read, no client writes** (catalog/config): only the `SELECT` policy; omit
  insert/update/delete policies so all writes are denied.
- **Published + own drafts** (blogs): `SELECT` uses
  `USING (status = 'published' OR owner_id = auth.uid())`, writes owner-only.
- **Insert-only** (feedback, audit): `SELECT`/`INSERT` policies for own rows, no update/delete.
- **Server-only** (internal logs): `ENABLE ROW LEVEL SECURITY`, create **no** policies, grant
  nothing to `anon`/`authenticated` — reachable only via `exec_sql` and `SECURITY DEFINER`
  functions.
- **Team-shared**: policies check membership, e.g.
  `USING (team_id IN (SELECT team_id FROM team_members WHERE owner_id = auth.uid()))`.

### Best practice: `DEFAULT auth.uid()` + `WITH CHECK`

Use both on every owner column: `DEFAULT auth.uid()` auto-fills the owner so the client never sends
it, and `WITH CHECK (owner_id = auth.uid())` stops a malicious client from forging another user's
id. Neither alone is enough.

## Seeding Initial Data (app setup)

Seed rows with `exec_sql` `mode: "write"`. Because `owner_id` defaults to `auth.uid()`, seeding on
behalf of a specific user usually means setting `owner_id` explicitly in the seed statement (this is
a setup-time operation, not app code):

```sql
INSERT INTO items (owner_id, title, status) VALUES ('<owner-uid>', 'Welcome', 'published')
```

For fixed reference data with no owner, drop the column or use a table whose policy is public-read.

## Custom PostgreSQL Functions (RPC)

Create functions with `exec_sql` `mode: "migrate"`; the app calls them via `cloud.database.rpc(...)`
(see `code-generation.md`).

```sql
CREATE OR REPLACE FUNCTION search_items(keyword text)
RETURNS SETOF items
LANGUAGE sql STABLE
AS $$ SELECT * FROM items WHERE title ILIKE '%' || keyword || '%' $$
```

Volatility: `IMMUTABLE` (pure), `STABLE` (reads DB, no writes), `VOLATILE` (default, may write).

Two independent permission dimensions:

- **EXECUTE** — who may call it. Default is `PUBLIC`. Restrict with `REVOKE` then `GRANT`:
  ```sql
  REVOKE EXECUTE ON FUNCTION search_items(text) FROM PUBLIC
  ```
  ```sql
  GRANT EXECUTE ON FUNCTION search_items(text) TO authenticated
  ```
- **Security mode** — whose rights apply inside the body.
  - `SECURITY INVOKER` (default) — runs as the caller; RLS enforced, `auth.uid()` is the caller.
  - `SECURITY DEFINER` — runs as the creator; **bypasses RLS**, sees all rows. Use only for genuine
    cross-user needs (leaderboards, global stats), and always restrict EXECUTE to the minimum roles
    and validate inputs.

Manage them with more `exec_sql` `migrate` calls (`ALTER FUNCTION ... SECURITY DEFINER`,
`DROP FUNCTION ...`, `COMMENT ON FUNCTION ...`).

## Maintaining Existing Data

- Read/inspect: structured tools, or `exec_sql` `mode: "read"`.
- Fix/backfill: `exec_sql` `mode: "write"` with a precise `WHERE`.
- Schema change: `exec_sql` `mode: "migrate"`.

## Dangerous SQL Needs the User's Confirmation

Before running any high-risk statement, show the exact SQL and its blast radius, and get explicit
approval. That confirmation is raised by the trusted WorkBuddy UI — you do not fabricate it, and you
do not pass any "confirmed"/"force" flag to route around it.

High-risk (confirm first):

- `DROP TABLE` / `DROP FUNCTION` — permanent loss.
- `TRUNCATE`, or `DELETE` **without** a `WHERE` — wipes all rows.
- `ALTER TABLE ... DROP COLUMN` — permanent column + data loss.
- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` on a table with existing data — may lock out access.
- `REVOKE ALL` on tables/functions — can break the running app.
- Creating or switching a function to `SECURITY DEFINER` — bypasses RLS.
- Anything that modifies or deletes **existing** user data.

Safe (no confirmation): `CREATE TABLE` / `CREATE FUNCTION`, `CREATE POLICY` /
`DROP POLICY IF EXISTS`, `ALTER TABLE ADD COLUMN`, `COMMENT ON`, `CREATE INDEX`, `INSERT` of new
rows, read-only queries.

When the user says something vague like "清理一下数据" or "重置", confirm the exact scope — turn it
into clearing specific rows, never widen it into `TRUNCATE` or dropping a table on your own.

## Safety Notes

- Only touch the **current app's** database; never read or write another app's data.
- Mask sensitive fields (phone, email, identity values) when presenting data; never print whole
  rows into your reply or the logs.
- Diagnose errors by code: `42P01` (table missing → create it), `42501` (missing grant or RLS
  denied → check both gates), `23505` (unique violation).

## Completion Bar

State clearly what changed: which tables/policies/functions were created, how many rows were
seeded or affected, and whether the operation is recoverable. For a fresh setup, confirm the table
exists (`list_tables`), RLS is on with the intended policies (`list_rls`), and a round-trip write
reads back under the right owner.
