---
name: cloud-service
description: Add a managed Serverless backend (database, end-user auth, file storage, keyless LLM API) to an app being built, and manage what is already there. Use when the app must persist data across reloads, needs sign-up/login or per-user data, needs to upload files or produce accessible file links, or needs to call a large model without the user supplying an API key; also when the user mentions 云服务 / 开通云服务 / 后端 / 数据库 / 登录注册 / 文件上传 / AI 能力, asks to inspect or maintain existing tables, users, files or model usage, or reports that saving data, logging in, uploading or model calls fail.
description_en: Add or manage WorkBuddy's Serverless backend for persistent databases, end-user authentication, per-user data, file storage and public file links, or keyless LLM access. Use when building or maintaining these backend capabilities, including diagnosing failures involving saved data, login, uploads, or model calls.
license: Internal
allowed-tools:
disable: false
---

# 云服务 / WorkBuddy Cloud Service

WorkBuddy's bundled Serverless backend suite for apps you build. The environment lifecycle
(inspect / activate) runs through the built-in `workbuddy_cloud_service` tool.

**This skill and that tool are a pair, and neither works alone:**

| Owns | Where |
|---|---|
| Deciding when a backend is needed, environment lifecycle, SDK entry points, per-module APIs, safety rules | **this skill** |
| Actually inspecting / activating the environment and returning `publicConfig` | **`workbuddy_cloud_service`** |

So the loop is: this skill tells you to call the tool → the tool returns `publicConfig` and points
you back here for the module APIs → you write code against the docs in
[Module Docs](#module-docs), never from memory. If you arrived here from the tool's result, jump
straight to [How an App Talks to It](#how-an-app-talks-to-it) plus the module docs you need. If you
arrived from the user's request, start at [When to Use](#when-to-use).

This file carries only the **shared flow**: what the service is, when to activate, environment
lifecycle, how an app talks to it, the module index, and the safety/completion bar. **Per-module
APIs are deliberately not here** — read them on demand from [Module Docs](#module-docs).

## What It Provides

An ops-free backend: no servers to buy, no database to configure. Four modules:

| Module | Capability |
|---|---|
| Database | Structured storage and queries (CRUD, conditional queries, pagination) |
| Auth | End-user sign-up, login, sessions, identity checks |
| Storage | Files: upload/download of files, images, audio and video, access URLs |
| LLM API | Keyless large-model calls — the user needs no API key of their own |

Hard constraints:

- One app maps to exactly **one** cloud service environment.
- The environment belongs to the **current app**, not to a global account; data is never shared
  across apps.
- WorkBuddy hosts everything — the user never has to touch an underlying console.

## When to Use

Any one of these is enough:

- The app must **persist data** and restore it on the next visit (lists, records, settings, orders).
- The app needs a **user system**: sign-up, login, logout, a "me" page, per-user data isolation.
- The app needs to **store files**: avatar/image/attachment upload, accessible file links.
- The app needs to **call a large model**: chat, summarization, translation, classification, copy.
- The user says: 云服务 / 开通云服务 / 后端 / 数据库 / 登录注册 / 文件上传 / AI 能力.
- The user wants to **manage existing resources**: table data, user list, files, model usage.
- The user reports a cloud-service **failure**: data not saved, login broken, upload failing,
  model call erroring.

Do NOT use for: pure static pages, front-end-only interactions with no persistence, or when the
user already picked another backend (their own service, Supabase, …).

## Activation Confirmation Is UI-Driven — Never Ask It Yourself

Activation provisions a real resource that may carry quota/billing, so it always needs the user's
go-ahead — **but that go-ahead is collected by the trusted WorkBuddy UI, not by you.** The instant
you determine the app needs a backend, call `action: "activate"` directly; the tool then makes the
WorkBuddy UI pop a confirmation dialog and blocks until the user decides there.

**NEVER use `AskUserQuestion`, and never ask a natural-language question in chat (e.g. 「要不要开通
云服务？」/「需要我帮你开启后端吗？」), to decide whether to activate.** Doing so bypasses the trusted
confirmation dialog entirely — the UI never pops, and you end up granting or denying a billable
resource on the user's behalf. Making the *decision to call activate* is your job; collecting the
*user's authorization* is the dialog's job. Do not conflate the two.

- Correct: needs backend → `inspect` → pick the target application (reuse/create) → **call
  `activate` right away** → UI dialog decides whether to enable.
- Wrong: needs backend → ask in chat / via `AskUserQuestion` 「要不要开通」 → (dialog never shown).
  (Asking WHICH application is fine; asking WHETHER to enable is not.)

The only restraint is: do not activate for something that plainly does not need a backend (see
**When to Use**). If it genuinely needs one, do not pre-ask — activate and let the UI confirm. See
**Confirmation Is Not Yours to Fake** below.

## Environment Lifecycle

All four modules share **one** environment. **Never activate per module.**

### Decision order (mandatory)

1. Call `workbuddy_cloud_service` with `action: "inspect"` to list the applications registered in
   this session (a session may hold several — see **Which Application** below).
2. Decide which application this request belongs to, then call `action: "activate"` with the right
   `applicationMode`: `"reuse"` + `applicationId` to keep building an existing application, or
   `"create"` + `appName` to start a new independent one. Binding is idempotent and never
   double-charges, so re-activating a reused application to ensure it is on is safe. Do NOT gate the
   activation itself — NEVER use `AskUserQuestion` or a chat question like 「要不要开通」 to decide
   *whether* to enable cloud service; the trusted WorkBuddy UI raises that confirmation dialog and
   the user decides there.
3. Only write cloud-dependent code **after** activation is confirmed successful. Never write code
   against an environment you have not confirmed.

### Which Application (session may hold several)

An application comes into being two ways: its cloud service gets activated, or it is published as a
Site. So one conversation can accumulate multiple applications, and you must say which one each
`activate` targets — never let it default to the first.

- **Reuse an existing application** when the request continues one that already exists: 「继续完善刚才
  的应用」, 「给上面的记账本增加登录」, the user names an existing app, or the need is plainly an
  extension of an existing app's features. Pass `applicationMode: "reuse"` + that `applicationId`
  (from the `inspect` list).
- **Create a new application** when the request starts a separate one: 「再创建一个独立应用」, 「这是另
  一个项目」, 「不要复用刚才的应用」, or the request is for a second project that has not become an
  application yet. Pass `applicationMode: "create"` + a new `appName`.
- **When it is unclear**, you MAY ask the user a plain attribution question — e.g. 「当前会话已有
  『记账本』和『班级相册』，这次需求属于其中一个，还是要新建应用？」 — via ordinary chat or a
  structured question. If you call `activate` without a mode on a non-empty session (or reuse an id
  not in the list, or create a name that already exists), the tool returns a
  `cloud_service_application_selection_required` result with the candidate list and guidance; read
  it, decide, and call again with the right mode.

⚠️ Asking WHICH application is allowed. Asking WHETHER to enable cloud service is NOT — that stays
with the trusted UI (see the confirmation rules above and in **Confirmation Is Not Yours to Fake**).

### Publishing After Activation

Activating is **not** publishing. Activation provisions the backend environment and reserves the
app's share domain; nothing is online until you publish it with the `workbuddy_sites_deploy` tool.
When the user later asks to publish / deploy / 发布 / 上线, **reuse this app's `applicationId` as the
sites tool's `appId`** — do **not** `createNewApp`. Reusing the id keeps the reserved domain (and
therefore the cloud-service Origin); a brand-new app gets a different domain and the app's cloud
login breaks, because the server enforces an exact Origin match. The `applicationId` is the SAME id
used across cloud service and publishing.

### Status semantics

On a successful `activate`, `billingStatus` is `normal` (usable) and `provisionStatus` is `assigned`
(bound and ready). Binding is served from a warm pool and returns in seconds — there is **no
"provisioning-in-progress" state to poll**.

Once the app hits the data plane at runtime, treat runtime errors as the source of truth: quota /
auth / "environment not found" errors mean the user should upgrade or re-enable; do not retry them
as if they were transient.

### When Binding Can't Succeed Right Now

Binding is a seconds-level pull from a warm pool — there is no async "provisioning" to poll. When it
cannot succeed, the tool returns a `cloud_service_unavailable` result you must relay:

- **Pool temporarily empty** — resources are tight. Relay the "try again later" message and stop. The
  user can retry later and you will re-attempt the binding then. Do NOT loop or poll.
- **Account app-quota used up** — the result carries `useLocalImplementation: true`. Relay the message
  AND continue with a local implementation right away (do NOT ask again); a quota banner guides the
  user to upgrade or free an idle app.
- **Backend busy** — relay the "try again later" message and stop.

## Unpublished Capability & No Silent Downgrade

If the tool reports the capability is unavailable in this build, or the manager is not wired up,
**say so plainly** and stop. Specifically:

- **Never invent tool names**, and never poke the cloud-service backend directly through Bash/curl.
- **Never fake success** — don't claim an environment exists, and don't hand back a made-up
  environment id or config.
- **Never silently downgrade** to `localStorage` / an in-memory array / a mock JSON file just to
  make the feature "work". That reads as if the request was fulfilled while the data is not
  actually persisted. If a local-storage-only version is genuinely useful, **ask the user first**
  with a clear yes/no question and only proceed on explicit approval. (This is a **different**
  decision from activation: choosing a local fallback has no trusted UI dialog, so asking here is
  correct — the "never ask, just activate" rule applies only to gating `activate` itself.) The ONE
  exception: when a `cloud_service_unavailable` result carries `useLocalImplementation: true` (e.g.
  the account app-quota is used up), a local fallback is explicitly sanctioned — continue locally
  right away without asking.
- **Never retry to force it through** — not with a different action, not by re-activating.

## How to Call the Tool

Use the built-in tool `workbuddy_cloud_service`. It accepts:

- `action` (required) — `inspect` / `activate`.
- `directory` (required) — absolute path to the app source root. It scopes the session (where the
  local application manifest lives); it does NOT by itself pick WHICH application in the session this
  request targets — express that with `applicationMode` + `applicationId`.
- `applicationMode` (for `activate`) — `"create"` to start a brand-new application (requires
  `appName`; must NOT pass `applicationId`) or `"reuse"` to bind one already registered in this
  session (requires `applicationId`). May be omitted only when the session has no application yet
  (then it is treated as `create`). See **Which Application** above.
- `applicationId` (for `applicationMode: "reuse"` only, required there) — the `wbapp_` id of the
  application to reuse, taken from an `inspect` result's `applications` list.
- `appName` (optional) — a short human-friendly display name **you** summarize from what the app
  actually is (e.g. 「记账本」, 「班级相册」). Keep it under ~10 characters, in the user's language.
  Used when creating a new application; not the directory name, not the conversation title. On
  `reuse` it is ignored (the existing name is kept).
- `intent` (optional, `activate` only) — a short phrase used to build the confirmation dialog title
  **「实现{intent}需要开启云服务」**. Summarize it from the **user's own words** for what they want to
  achieve, and follow these rules:
  - Use the user's **surface wording**, not technical terms: say 「开支记录」 not 「数据」; **never** use
    「数据库」/「身份认证」/「存储」/「云数据库」.
  - If several capabilities are needed, name **at most two**, joined naturally
    (e.g. 「用户登录和积分数据保存」); if **more than two**, pass exactly 「你需要的这些功能」.
  - Keep it in the user's language, ideally ≤ 20 characters.
  - Examples: 「开支记录保存」 → 实现开支记录保存需要开启云服务; 「用户登录」 → 实现用户登录需要开启云服务;
    「用户登录和积分数据保存」 → 实现用户登录和积分数据保存需要开启云服务.
  - This is **display-only**: it does NOT decide whether the dialog pops or whether activation happens
    (that stays with the trusted UI). Omit it and a default title is used — never pass a `confirmed`-like
    value through it.

A successful call returns JSON with `activated` / `billingStatus` / `provisionStatus` /
`publicConfig` / `message`.

`publicConfig` carries exactly three fields, and they are the **only** values safe to ship inside
the app's front-end code:

- `resourceId` — the cloud service resource id.
- `endpoint` — the current application's release-domain data-plane base URL. **Required at client
  initialization — always pass it through** (see **How an App Talks to It**).
- `publishableKey` — identifies **which app** and carries **no permissions by itself**; the server
  enforces an exact Origin match. It may live in app source (it ends up visible in the browser
  anyway), but keep it out of logs.

The underlying environment id and all provider keys stay server-side and are never returned. If a
pattern seems to require the front end to hold a long-lived key, the pattern is wrong.

### Confirmation Is Not Yours to Fake

`activate` confirmation is raised by the trusted WorkBuddy UI. The tool
**deliberately rejects** `confirmed` / `confirm` / `skipConfirm` / `force`. Do not attempt to pass
them — passing them means the model is granting itself the user's authorization. **Equally, do NOT
substitute your own question for it: never use `AskUserQuestion` or a chat prompt like 「要不要开通」
to gate activation — that both skips the trusted dialog (it never pops) and quietly self-authorizes.**
If the result carries `declinedByUser: true`, the user said no: that is a **normal outcome, not an
error**. Report it and stop; do not re-ask in a loop or route around it.

## How an App Talks to It

The app initializes a client with **both** `endpoint` + `publishableKey` from `publicConfig`, then
calls each module. **Initialize once**; every module reuses that same client instance.

### `endpoint` is mandatory — never omit it

Every initialization you generate MUST contain `endpoint: publicConfig.endpoint`. This is not a
style preference:

Two things are equally forbidden, for the same reason:

- **Never hard-code an endpoint literal** (`https://xxx.workbuddy.link`, a test/staging domain, …).
  It goes stale the moment the app is republished, and the server's exact-Origin match will reject
  it.
- **Never source it from anywhere but `publicConfig`** — not `window.location`, not an env var, not
  a BFF, not a guessed convention. If you do not have a `publicConfig` in hand, you are not ready to
  write cloud code: go back to **Environment Lifecycle** and activate first.

Data-plane paths are fixed (all under `/.cloud/` so they cannot collide with the app's own routes):

| Module | Path |
|---|---|
| Auth | `/.cloud/auth/v1/**`, `/.cloud/auth/v2/**` |
| Database | `/.cloud/database/rest/**` |
| Storage | `/.cloud/storage/**` |
| LLM API | `/.cloud/llm/chat/completions` |

The client is `@tencent-ai/workbuddy-cloud-sdk`, shipped in **two** forms. Pick by whether the
project has a build step — the module APIs are **identical** either way, so module docs are written
once and apply to both. Do not initialize a second CloudBase client or hand-write module fetch
wrappers.

### Which form to use

| Project shape | Form |
|---|---|
| Has `package.json` + bundler (Vite / Next / Webpack / RN …) | **npm package** — falls back to CDN if the install fails |
| Single-file HTML, no build step, no npm (HTML artifacts, small games, one-page demos) | **CDN `<script>`** |

Never mix the two in one project, and never introduce a package manager or bundler into a
plain-HTML project just to install the SDK. The **only** legitimate reason to leave the form the
table picked is a failed npm install (see Form A below) — and that **switches** the project to the
CDN form, it never leaves the project on both.

### Form A — npm package (projects with a build step)

Install from the `dev` channel. Do not pin a specific version and do not invent a version number —
during integration the SDK ships fixes on the `dev` tag, and a pinned version silently freezes the
app on older behaviour (`latest` is **not** maintained yet, so it also points at a stale build):

```bash
npm install @tencent-ai/workbuddy-cloud-sdk@dev
# pnpm add / yarn add — same specifier
```

```ts
import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk'

export const cloud = createWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  publishableKey: publicConfig.publishableKey,
})
```

Ships ESM (`import`), CJS (`require`) and bundled `.d.ts`, so TypeScript needs no extra setup.

#### If the install fails, fall back to the CDN

A build-based project still **starts** with npm. But the install can fail for reasons you cannot fix
from inside the project — no registry access, the pinned dev version not reachable from this
network, auth errors on the `@tencent-ai` scope, or a sandbox with no network at all. When that
happens, **do not** stall, do not ask the user to fix their registry, and above all **do not
hand-write fetch wrappers or pull in a second CloudBase client** — switch this project to the
CDN form (Form B) instead:

1. Load the IIFE build from the CDN and use the `WorkBuddyCloud` global, exactly as Form B
   describes. In a bundler project, the `<script>` goes in the HTML entry (e.g. `index.html`), not
   in a module `import`.
2. Remove the failed dependency from `package.json` so the project does not carry a phantom
   dependency that breaks the next `install` / CI run.
3. Tell the user, in one line, that the SDK is loaded from the CDN because the npm install failed —
   it changes how the app is served (needs network at runtime, no bundled types), so it must not be
   silent.

Retry the `@dev` npm specifier **once** before switching; if it fails again, switch and move on
rather than looping. Everything after initialization is unchanged, so no module code needs rewriting
— only the import/init site differs.

### Form B — CDN `<script>` (plain HTML, no build step)

```html
<script src="https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js"></script>
<script>
  const cloud = WorkBuddyCloud.createWorkBuddyCloud({
    endpoint: publicConfig.endpoint,
    publishableKey: publicConfig.publishableKey,
  })
</script>
```

- The IIFE build exposes the global `WorkBuddyCloud`; every export is reached through it
  (`WorkBuddyCloud.createWorkBuddyCloud`, `WorkBuddyCloud.CLOUD_MODULE_PATHS`, …). There is **no**
  bare global `createWorkBuddyCloud`.
- Initialize **after** the script has loaded — no synchronous calls from `<head>`, and no
  `type="module"` / `import` against the CDN URL.
- Use the `@dev` channel, **not** `@latest`: `latest` is not maintained yet and points at a stale
  build. Do not substitute a pinned version either — during integration the fixes land on `dev`.

Everything after initialization is the same object shape in both forms — read the module docs below
for concrete API signatures, and translate `import { X }` to `WorkBuddyCloud.X` when on the CDN
path. **Do not re-read module docs per form.**

## Module Docs

**Read only the files the current request touches — never load all modules up front.** Decide
which modules the request hits, then read from the table below; one task usually needs 1–2 files.

`code-generation` is for **writing app code**; `management` is for **inspecting and maintaining
existing resources**. Different purposes — do not mix them up.

Auth and Storage `management.md` also define how the WorkBuddy management UI should interpret
Provider/capability state and business errors. They are not model-callable tools: use them for
troubleshooting and implementation guidance, and do not invent a service-role credential or direct
provider fallback.

### Database

- Write app code: `references/database/code-generation.md`
- Inspect and manage data: `references/database/management.md`

### Auth

- Write auth code: `references/auth/code-generation.md`
- Manage auth config and users: `references/auth/management.md`

### Storage

- Write file storage code: `references/storage/code-generation.md`
- Manage files and directories: `references/storage/management.md`

### LLM API

- Write LLM call code: `references/llm/code-generation.md`
- Inspect models and usage: `references/llm/management.md`

## Important Rules

- **Secrets never land in code.** No long-lived keys or admin credentials in front-end code, repo
  files or logs. The front end uses only end-user-facing public config.
- **The client is always initialized with both `publicConfig` values.** `endpoint` and
  `publishableKey` are each mandatory at every `createWorkBuddyCloud` call site. Never rely on the
  SDK's optional-`endpoint` same-origin fallback, never hard-code an endpoint literal, and never
  read it from `location` / env vars / a BFF (see **How an App Talks to It**).
- **Never print sensitive values.** End-user tokens, phone numbers, emails and private file URLs
  stay out of logs and out of your reply.
- **Isolate data per user.** Any read/write of user data must carry an identity constraint; no user
  may read or write another user's data.
- **Destructive operations need explicit confirmation.** Dropping tables, clearing data or
  bulk-deleting files — state the blast radius and irreversibility first.
- **Stay in scope.** Only touch the current app's environment; never read or write another app's
  resources.
- **Validate uploads.** Constrain type and size; never trust the client-supplied filename or path.
- Do not surface internal details (raw backend endpoints, internal ids beyond what
  `publicConfig` exposes) to the user.

## Completion Bar

A cloud-service task is done only when **all** of these hold:

1. Environment confirmed usable — `billingStatus` is `normal` or `expiring`, and `provisionStatus`
   is `assigned`.
2. Every module the request needs is integrated per its `code-generation.md`, and the code runs.
   Every `createWorkBuddyCloud` call site in the generated source passes `endpoint` and
   `publishableKey`, both sourced from `publicConfig` — grep for `createWorkBuddyCloud` and check
   each hit before reporting done.
3. The critical path is actually verified: written data reads back; login yields an identity;
   an uploaded file can be downloaded or opened through its signed URL; the model call returns.
4. Failure paths are handled: network failure, not-logged-in, insufficient permission and
   out-of-quota all produce a clear message — nothing fails silently.
5. Your report to the user states what was activated, which modules were integrated, and how to
   verify it — plus any quota or billing implications.
