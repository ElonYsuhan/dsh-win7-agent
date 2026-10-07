# Storage · Write Runtime File Code

Use this reference for **application runtime files**: user uploads, avatars, attachments, generated
media and application-shared files. Project source/static assets remain in the repository and
publish system. The cloud environment must already be active.

## Fixed Resource Model

- Physical storage is a platform-managed COS Bucket.
- TCB automatically isolates environments using the `envId` BasePath.
- The SDK exposes exactly one logical Bucket: `runtime`.
- Application code never sees the physical Bucket, region, envId or BasePath.
- Directories are object-key prefixes; the generated SDK has no `mkdir` API. Uploading below a
  missing prefix creates the effective directory structure automatically. The WorkBuddy admin
  page's virtual-folder operation is a separate management-plane API.

```text
runtime/
├── users/<uid>/...          owner read/write/delete
└── shared/<ownerUid>/...    all signed-in app users read; owner writes/deletes
```

Storage is for signed-in users. Public Bucket/public URL access is not exposed.

Before any runtime Storage operation, follow Auth's **Mandatory Auth Gate for User Data**. If no
session exists, render the login/signup UI instead of calling Storage:

```ts
const { data: session } = await cloud.auth.getSession()
if (!session) {
  showLoginView()
  return
}
```

Do not create anonymous storage fallbacks, public Bucket workarounds or local-only file mirrors for
protected files. Build `userPath` / `sharedPath` only after a session is available.

## Client and Safe Paths

`cloud` is the client created per **How an App Talks to It** in `SKILL.md` — either the npm package
`@tencent-ai/workbuddy-cloud-sdk@dev`, or the CDN
`https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js` for plain
HTML. Do not create a second client here. Every `cloud.storage.*` call below is identical in both
forms; only named exports differ — on the CDN path reach them through the global
(`WorkBuddyCloud.CloudStoragePathError`) instead of `import`.

```ts
const runtime = cloud.storage.from('runtime') // optional; cloud.storage already targets runtime

const privatePath = cloud.storage.userPath(
  session.user.id,
  `avatars/${crypto.randomUUID()}.png`,
)
const sharedPath = cloud.storage.sharedPath(
  session.user.id,
  `reports/${crypto.randomUUID()}.pdf`,
)
```

Do not accept a full object key from untrusted input. The SDK rejects absolute paths, backslashes,
NULs, empty segments, `.`/`..`, encoded traversal and paths outside `users`/`shared`.

## Public Capability Table

| Capability | SDK method |
|---|---|
| Upload new file / optional upsert | `upload(path, body, options?)` |
| Replace an existing owned file | `update(path, body, options?)` |
| Offset list | `list(prefix?, options?)` |
| Cursor list | `listPage(options?)` |
| Metadata / existence | `info(path)` / `exists(path)` |
| Blob / stream download | `download(path)` / `download(path).asStream()` |
| Delete explicit objects | `remove(paths)` |
| Copy / move | `copy(from, to)` / `move(from, to)` |
| Signed download | `createSignedUrl(path, ttl?)` |
| Batch signed download | `createSignedUrls(paths, ttl?)` |
| Signed upload | `createSignedUploadUrl()` + `uploadToSignedUrl()` |
| Safe path helpers | `userPath()` / `sharedPath()` |

## Upload and Update

```ts
const uploaded = await cloud.storage.upload(privatePath, file, {
  contentType: file.type,
  cacheControl: '3600',
  upsert: false,
  metadata: { purpose: 'avatar' },
})
```

Uploading to a missing prefix needs no preparation. Use `upsert: true` only for an intended
same-name overwrite. RLS still requires the current user to own the destination.

Use `update()` when replacing an existing owned object:

```ts
await cloud.storage.update(privatePath, replacement, {
  contentType: replacement.type,
})
```

## List and Pagination

```ts
const page = await cloud.storage.list(`users/${session.user.id}`, {
  limit: 100,
  offset: 0,
  sortBy: { column: 'name', order: 'asc' },
})
```

All application-shared files are visible under `shared`:

```ts
const shared = await cloud.storage.listPage({
  prefix: 'shared',
  limit: 100,
  cursor,
  with_delimiter: true,
  sortBy: { column: 'created_at', order: 'desc' },
})
```

When `hasNext` is true, pass `nextCursor` into the next call. Never assume one page contains all
objects before a cleanup operation.

## Info, Exists and Download

```ts
const info = await cloud.storage.info(privatePath)
const exists = await cloud.storage.exists(privatePath)
const blob = await cloud.storage.download(privatePath)
const stream = await cloud.storage.download(privatePath).asStream()
```

## Signed URLs

Default download URL lifetime is 600 seconds; the SDK accepts 1–3600 seconds.

```ts
const one = await cloud.storage.createSignedUrl(sharedPath, 600)
const many = await cloud.storage.createSignedUrls([pathA, pathB], 600)
```

Signed upload:

```ts
const signed = await cloud.storage.createSignedUploadUrl(privatePath, {
  upsert: true,
})
if (!signed.error) {
  await cloud.storage.uploadToSignedUrl(
    signed.data.path,
    signed.data.token,
    file,
    { contentType: file.type },
  )
}
```

Permission is checked when a signed URL/token is issued. Treat it as a short-lived secret: do not
log it or persist it long-term.

## Copy, Move and Delete

```ts
await cloud.storage.copy(source, destination)
await cloud.storage.move(source, destination)
await cloud.storage.remove([pathA, pathB])
```

- Copy requires source read and destination write permission.
- Move also requires source delete permission.
- Every signed-in user may read `shared/<ownerUid>/...`; only that owner may overwrite, move or
  delete it.
- To delete a displayed directory, paginate the prefix, show the object count, ask for explicit
  confirmation, and delete the explicit keys. Never delete rows directly from `storage.objects`.

## Result and Error Handling

Storage methods return `{ data, error }`. Path validation throws `CloudStoragePathError` before a
request is sent; API failures return `CloudStorageError`. Handle both:

```ts
try {
  const result = await cloud.storage.upload(path, file)
  if (result.error) showStorageError(result.error.message)
} catch (error) {
  if (error instanceof CloudStoragePathError) showStorageError(error.message)
  else throw error
}
```

## Unsupported in Generated Applications

- Creating, updating, emptying, deleting or switching logical Buckets.
- Public Buckets/public URLs.
- Supplying a COS Bucket, region, BasePath or envId.
- Cross-application access.
- Old sandbox-file migration.
- Usage accounting, billing, account quotas, CLS/Kafka or moderation configuration.

## Completion Bar

Verify with two signed-in users:

1. A can read/write/delete `users/A/...` and cannot read `users/B/...`.
2. A and B can read `shared/A/...`; B cannot overwrite/move/delete it.
3. Upload/update/list/info/exists/download/copy/move/delete are exercised.
4. Signed single/batch download and signed upload obey the same permissions.
5. Pagination and unsafe-path failure paths are tested.

If the WorkBuddy Storage page cannot list the root or create a folder, do not compensate in SDK
code. Follow [`management.md`](./management.md): the bound environment may not include the Storage
resource, in which case a Storage-capable environment/pool is required.
