# Auth · Manage Providers and Inspect End Users

Use this reference when the user is operating the **WorkBuddy cloud-service management page** for
the current application, or asks why Email is disabled, degraded or cannot be saved. This is
different from writing a login page:

- Generated application runtime code uses `cloud.auth` and
  [`code-generation.md`](./code-generation.md).
- WorkBuddy operators manage Provider configuration through the trusted admin plane described here.
- End-user account inspection is read-only and remains a separate endpoint.

The cloud environment must already be bound to the application. Never accept an `envId`, TCB key,
COS key or service-role credential from the caller; the server resolves Application → Environment.

## Trusted Boundary

All requests require the WorkBuddy operator login and current Application ownership. A generated
application's end-user session cannot call these endpoints.

```text
WorkBuddy Auth page
  → /genie-baas/admin/auth/**
  → Agentserver resolves Application + Environment
  → TCB management API / encrypted Application credential store
```

Do not call TCB directly, do not infer Provider status from the user list, and do not use
`cloud.auth` as a management API.

## Provider State Model

The page contains a single Provider card:

1. `email`

Each card has three independent facts:

| Field | Meaning |
|---|---|
| `enabled` | The login method is currently open to application end users. |
| `configured` | All configuration required to enable it is complete. |
| `state` | `enabled`, `disabled` or `degraded`; degraded means the facts are inconsistent. |

Never render `enabled=true, configured=false` as healthy. Display `warning` and use the Provider
detail response to identify the missing source.

### Email state

Email is healthy only when the TCB Email Provider and Email login switch agree.

- `deliveryMode=platform`: TCB platform delivery. A non-null SMTP placeholder containing only
  `cloudbase_noreply@tencent.com` / security mode is **not** custom SMTP.
- `deliveryMode=custom`: host, port, account and password configuration must be complete.
- `templateMode=custom`: every non-empty template must contain `{{.VerificationCode}}`.

## Provider HTTP Contract

Public paths have **no `/v1` segment**.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/genie-baas/admin/auth/providers` | Fixed Email summary |
| `GET` | `/genie-baas/admin/auth/providers/email` | Email delivery/template detail |
| `PATCH` | `/genie-baas/admin/auth/providers/email` | Save Email Provider |
| `GET` | `/genie-baas/admin/auth/users` | Read-only end-user list |

Read requests carry `applicationId` in query. Provider PATCH requests carry it in the JSON body.
Successful responses use the common `{ code: 0, msg: "success", data }` envelope.

### Load the page

```text
GET /auth/providers?applicationId=...
  → render Email card

User opens Email card
  → GET /auth/providers/email?applicationId=...
```

Do not fetch all details just to render the list. Do not query `/auth/users` to derive card state.

## Save Email Safely

Every detail response carries `revision`; every PATCH must echo it as `expectedRevision`.

```ts
interface UpdateEmailProviderRequest {
  applicationId: string
  expectedRevision: string
  enabled?: boolean
  delivery?: {
    mode: 'platform' | 'custom'
    smtp?: {
      serverHost: string
      serverPort: number
      accountUsername: string
      accountPassword?: string
      senderAddress: string
      securityMode: 'AUTO' | 'SSL' | 'STARTSSL' | 'NO_SSL'
    }
  }
  templates?: {
    mode: 'platform' | 'custom'
    registerSignInZhCN?: string
    registerSignInEnUS?: string
    defaultTplZhCN?: string
    defaultTplEnUS?: string
  }
}
```

Rules:

- Switching to custom SMTP requires all fields including a password.
- Changing a custom SMTP host/port/account/sender/security field requires a new password.
- An empty password may preserve the old password only when no other SMTP field changes.
- Passwords never appear in responses, logs, audit details or revisions.
- Save success means the server wrote upstream configuration, read it back, and verified the
  resulting state. Do not show success before the PATCH response returns.

## Conflict and Error Handling

| HTTP | Code | Action |
|---:|---:|---|
| 400 | `18300` / `18356` | Keep the form; highlight invalid fields or missing replacement Secret. |
| 401 | — | Ask the operator to sign in again. |
| 403 | `18302` | Stop; the current operator does not own the Application scope. |
| 404 | `18301` / `18304` / `18353` | Refresh Application/cloud-service state; do not create a fake Provider. |
| 409 | `18354` / `18355` / `18310` | Reload detail. For revision conflict, let the operator reapply changes. |
| 502 | `18357` | Upstream TCB update/readback failed; keep current form and reload state. |

Never retry a mutation automatically: a multi-step upstream write may have partially completed.
Reload the Provider detail before the next operator action.

## Read-Only End Users

```http
GET /genie-baas/admin/auth/users
  ?applicationId=<application-id>
  &offset=<non-negative integer>
  &limit=<positive integer>
Authorization: Bearer <WorkBuddy operator login>
```

Response:

```ts
interface EndUser {
  uid: string
  email?: string
  phoneNumber?: string
  name?: string
  provider?: string
  isAnonymous: boolean
  createdAt: string
}

interface ListEndUsersResponse {
  items: EndUser[]
}
```

This endpoint does not disable/delete users, reset passwords, bind Providers, or indicate whether a
Provider is configured. Mask email/phone values in conversational output.

## Troubleshooting Checklist

### Email card is enabled but degraded

1. Load Email detail, not the End User list.
2. Check whether `deliveryMode` is unexpectedly `custom`.
3. A platform SMTP placeholder must map to `platform`; do not ask for SMTP credentials merely
   because TCB returned a non-null placeholder.
4. Confirm Email login switch and Provider `On` agree.
5. Confirm custom templates contain the verification-code variable.

## Completion Bar

Provider management is complete only when:

1. The list and opened detail agree on `enabled/configured/state`.
2. A save uses the latest revision and the returned detail replaces local state.
3. Secrets are absent from responses/logs and cleared from UI inputs.
4. Email platform/custom delivery is distinguishable.
5. Cross-Application access is rejected.
6. End-user inspection remains read-only and is never used as Provider truth.
