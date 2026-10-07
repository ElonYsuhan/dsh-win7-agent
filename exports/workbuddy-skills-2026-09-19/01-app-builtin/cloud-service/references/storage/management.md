# Storage · Manage Runtime Files

Use this reference for the **WorkBuddy Storage management page** of the current Application:
browse/search files, inspect metadata, upload/replace, create a displayed folder, download, delete,
copy, move or rename. Generated application runtime code uses `cloud.storage` and
[`code-generation.md`](./code-generation.md); it must not call the admin API.

The cloud environment must already be bound and must include the `storage` resource capability.

## Trusted Boundary and Resource Model

```text
WorkBuddy Storage page
  → /genie-baas/admin/storage/**
  → Agentserver resolves Application + Environment
  → TCB Storage management provider
  → logical bucket runtime
```

- Requests use the WorkBuddy operator login, not an application end-user session.
- Callers send `applicationId`; they never send `envId`, physical COS Bucket, BasePath or
  service-role credentials.
- One physical COS Bucket is shared by environments; TCB isolates each environment with its
  automatic envId BasePath. The SDK/admin page does not need to know that BasePath.
- Logical Bucket is fixed to `runtime`.
- Public paths have **no `/v1` segment**.

## Preflight Before Rendering an Operable Page

Do not show a usable empty root merely because the Application has a cloud-service binding.

1. Resolve the bound cloud service.
2. Require a usable provision state.
3. Require `resources` to contain `storage`.
4. Resolve the Storage admin provider.
5. Only then return the root entries or enable mutations.

If the Application is bound to a historical non-Storage environment, return capability unavailable
instead of synthetic `users/shared` folders. The UI should disable Storage actions and explain that
the current environment has no Storage capability.

## Paths, Scope and Owner

| Scope | Physical logical prefix | Read | Modify/delete |
|---|---|---|---|
| `user_private` | `users/<uid>/...` | owner + Application admin | owner + Application admin |
| `app_shared`, end-user owner | `shared/<uid>/...` | signed-in Application users + admin | owner + admin |
| `app_shared`, Application owner | `shared/_application/...` | signed-in Application users + admin | admin |

The management UI supplies a scope, owner reference and **relative path**. Agentserver constructs
and validates the full logical path. Never allow arbitrary full keys, reserved-prefix injection,
`..`, encoded traversal, backslashes, NULs or cross-Application paths.

Owner references:

```ts
type StorageOwnerRef =
  | { type: 'application_admin' }
  | { type: 'end_user'; uid: string }
```

Use the Storage Owner endpoint for upload/folder forms. Do not reuse the unsearchable Auth user list.

## Management API

Base path:

```text
/genie-baas/admin/storage
```

| ID | Method | Path | Purpose |
|---|---|---|---|
| S1 | `GET` | `/owners` | Search/select Application admin or end-user Owner |
| S2 | `GET` | `/objects` | Browse a directory or recursively search |
| S3 | `GET` | `/objects/info` | File metadata or folder aggregate |
| S4 | `POST` | `/objects/download-url` | Short-lived preview/download URL |
| S5 | `POST` | `/objects/upload/prepare` | Validate and issue staged upload URL |
| S6 | `PUT` | opaque URL returned by S5 | Upload bytes |
| S7 | `POST` | `/objects/upload/commit` | Publish staged upload and owner metadata |
| S8 | `POST` | `/folders/create` | Create a virtual/displayed folder |
| S9 | `POST` | `/objects/delete/prepare` | Expand targets and return exact impact |
| S10 | `POST` | `/objects/delete/execute` | Queue confirmed delete |
| S11 | `GET` | `/operations/:operationId` | Poll delete progress/result |
| S12 | `POST` | `/objects/copy` | Copy a file to a validated destination |
| S13 | `POST` | `/objects/move` | Move or rename with version protection |

Mutation requests requiring idempotency must carry an opaque, unique `Idempotency-Key`.

## Page Load and Browsing Flow

```text
GET /objects?applicationId=...&path=&limit=...
  → capability preflight
  → root/browse result

Open entry
  ├─ folder → GET /objects with entry.path
  └─ file   → GET /objects/info
```

Use `cursor` / `nextCursor` while `hasNext=true`. Search resets the cursor and returns a flat list
under the selected path. Do not assume the first page contains the whole directory.

Folder details return:

- `objectCount`
- `totalSizeBytes`
- `statisticsComplete`

If statistics are incomplete, label them as partial; do not present them as exact totals.

## Upload or Replace

```text
S1 select Owner
  → S5 prepare
  → S6 PUT bytes to opaque signed URL
  → S7 commit
  → refresh list/detail
```

Prepare request distinguishes:

- `mode=create`: destination must not already exist.
- `mode=replace`: requires `expectedVersion`; only the owner/admin may replace.

Rules:

- Do not expose the staged URL in logs or conversational output.
- S5 success alone is not a completed upload. Only S7 success makes the object visible.
- If S6 fails, do not call S7.
- If S7 reports version conflict, reload object info before offering retry.
- Keep file size/type validation in both UI and server; client validation is only usability.

## Displayed Folder Creation

`POST /folders/create` creates a **virtual folder marker/prefix for the management experience**.
This is an admin-plane operation and is not the same as the generated SDK, where uploading to a
missing prefix automatically creates the effective directory structure.

Required inputs:

```ts
interface StorageCreateFolderRequest {
  applicationId: string
  scope: 'user_private' | 'app_shared'
  ownerRef: StorageOwnerRef
  parentRelativePath?: string
  name: string
}
```

Before enabling the button, capability preflight must have passed. A historical environment without
Storage should produce HTTP 503, not a generic 500 and not a fake successful folder.

## Download and Preview

Use S4; never manufacture a COS URL.

- `disposition=inline` for preview.
- `disposition=attachment` for download.
- URLs are short-lived secrets. Open them directly and do not persist or log them.
- Permission is checked when the URL is issued.

## Delete Flow

Deletion is always two-phase:

```text
S9 prepare targets
  → show exact files/folders/bytes/sample paths
  → explicit operator confirmation
  → S10 execute with Idempotency-Key
  → S11 poll until succeeded/partial/failed
```

Do not call execute without a fresh prepare operation. Report partial failures separately. Never
empty/delete `runtime`, and never mutate `storage.objects` directly.

## Copy, Move and Rename

- Copy requires source read plus destination write permission.
- Move/rename also requires source delete permission.
- Use `expectedVersion` for move when editing a known object version.
- `overwrite=true` must be an explicit operator choice; never silently replace an existing object.
- Destination is expressed as scope + owner + relative path and is rebuilt server-side.

## HTTP and Business Error Handling

| HTTP | Meaning | UI action |
|---:|---|---|
| 400 | Invalid path, owner, folder name or request | Keep form open and identify the invalid field. |
| 401 | Operator login missing | Ask the operator to sign in again. |
| 403 | Application scope or file permission denied | Stop; do not retry with another Owner/path. |
| 404 | Application/cloud service/object not found | Refresh Application or directory state. |
| 409 | Environment not ready, object/version conflict | Reload status/detail before retry. |
| 413 | File/object-count limit exceeded | Reduce upload or deletion batch. |
| 422 | Content rejected | Explain rejection without exposing moderation internals. |
| 502 | Provider upload/delete/upstream failure | Keep operation state and allow a deliberate retry. |
| 503 | Module disabled or environment lacks Storage | Disable the page's mutations; a new Storage-capable environment is required. |

The response keeps the WorkBuddy business `code/msg/requestId`. Do not collapse every failure into
“500” or “network error”.

## Known Test4 Failure Pattern

Symptom:

```text
Create folder → HTTP 500
upstream: Target Storage bucket does not exist
```

Interpretation:

- This message alone is insufficient to identify the cause. First capture `applicationId`,
  `requestId`, bound `resourceId/envId`, resource profile and the provider response for the same
  request. Do not reuse evidence from another Application.
- Possible branches include: the Application is bound to an old environment without `storage`;
  Storage source/runtime bucket initialization failed; or the environment points at a different
  Bucket/region than the current test4 configuration.
- The fix is not to retry folder creation and not to expose the physical Bucket.
- The server must return capability unavailable during root/preflight.
- New applications must bind only to ready environments whose resource profile matches
  `postgresql,storage`; old `flexdb` environments must not occupy that pool water level.
- Deployment must enable Storage and replenish a matching pool before testing a newly created app.

## Completion Bar

Storage management is complete only when:

1. Non-Storage environments render a disabled/error state before any mutation.
2. Browse/search/detail pagination works without leaking physical storage identifiers.
3. Upload reaches commit and reads back; staged upload alone is not counted as success.
4. Folder creation works only on a Storage-capable environment.
5. Delete shows exact impact, requires confirmation and reports partial failures.
6. Copy/move enforce source/destination permissions and version conflicts.
7. Every mutation uses the current Application scope and required idempotency key.
8. Signed URLs and credentials never appear in logs or the final report.
