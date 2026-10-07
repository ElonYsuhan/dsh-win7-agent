# Auth · Write Auth Code

Use this reference when adding end-user authentication to a **published** WorkBuddy application.
The cloud service environment must already be active and `publicConfig` must be available.

## Availability Boundary

Phase one exposes only capabilities that are closed end to end across SDK, gateway, environment
configuration and tests:

- Email OTP registration/login.
- Email + password login.
- Forgot-password and signed-in password change.
- Session persistence, refresh, user lookup, sign-out and auth-state events.

Do **not** generate anonymous login, phone/SMS login, username login, provider bind/unbind, captcha,
device-code, QR-code or admin user mutations. Those are not enabled in the provisioned environment
and are not part of the public SDK contract.

Auth is supported only on the application's registered HTTPS release domain. WorkBuddy preview and
localhost are not supported because they do not have the registered Origin/callback binding. Do not
add a mock or localStorage-only fallback.

Use `@tencent-ai/workbuddy-cloud-sdk`. Do not initialize `@cloudbase/js-sdk` separately and do not
call `/.cloud/auth/**` with hand-written `fetch`.

## Initialize Once

Both SDK forms are available — see **How an App Talks to It** in `SKILL.md` for how to choose.

npm package (projects with a build step):

```ts
import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk'

export const cloud = createWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  publishableKey: publicConfig.publishableKey,
})
```

CDN `<script>` (plain HTML, no build step) — same options, reached through the `WorkBuddyCloud`
global:

```html
<script src="https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js"></script>
<script>
  const cloud = WorkBuddyCloud.createWorkBuddyCloud({
    endpoint: publicConfig.endpoint,
    publishableKey: publicConfig.publishableKey,
  })
</script>
```

Both options are **required** in both forms — `endpoint` included. Never omit `endpoint` and
lean on the SDK's same-origin fallback, and never hard-code it; the only source is the
`publicConfig` returned by `workbuddy_cloud_service` (see **How an App Talks to It** in `SKILL.md`).
Every `cloud.auth.*` snippet below is form-agnostic once `cloud` exists.

The same `cloud` instance is shared by Auth, Database, Storage and LLM. After login, the shared
request layer automatically sends the latest WorkBuddy session to Database and Storage requests.

## Public Capability Table

| Capability | SDK method |
|---|---|
| Email OTP login/registration | `cloud.auth.signInWithOtp({ email })` |
| Low-level send/verify OTP | `sendOtp({ email })` + `verifyOtp(...)` |
| Email + password login | `signInWithPassword({ email, password })` |
| Verified signup after OTP | `signUp({ email, password, verificationToken })` |
| Forgot password | `resetPasswordForEmail(email)` |
| Change password while signed in | `resetPasswordForOld({ oldPassword, newPassword })` |
| Current session | `getSession()` |
| Force refresh | `refreshSession()` |
| Verified current user | `getUser()` |
| Token for the app's own backend | `getAccessToken()` |
| Sign out | `signOut()` |
| Observe changes | `onAuthStateChange(callback)` |

## Default Login UI Contract

When the user asks for login, signup, auth, account, user system, 登录, 注册, 账号体系,
or 用户系统 and does not explicitly limit the method, generate a complete email auth UI with
all of the following reachable from the page:

1. Email + password login through `cloud.auth.signInWithPassword`.
2. Email OTP login through `cloud.auth.signInWithOtp` or `sendOtp` + `verifyOtp`.
3. Verified signup with email OTP **and a password**.
4. Forgot-password flow when password login is present.

Do not implement only OTP login unless the user explicitly asks for OTP-only login. A complete
login page may use tabs, segmented controls or separate forms, but password login, OTP login and
signup must all be visible or directly reachable.

## Mandatory Auth Gate for User Data

Never solve data-access errors by adding anonymous login. Anonymous login is intentionally
unavailable in phase one. Do not create localStorage-only users, mock sessions or other fallback
identities to make protected data appear to work.

Before reading or writing user-scoped Database rows or Storage files, check the current session:

```ts
const { data: session, error } = await cloud.auth.getSession()
if (error || !session) {
  showLoginView()
  return
}
```

Only explicitly public-read tables may be queried before sign-in. Storage is for signed-in users;
do not upload, list, download, copy, move or delete user paths before sign-in. For user-owned
database rows, do not send `owner_id` from client code; the table should use
`owner_id TEXT NOT NULL DEFAULT auth.uid()` and RLS policies with
`WITH CHECK (owner_id = auth.uid())`.

The OTP challenge shortcut is suitable for OTP-only login. For full signup with a password, use the
low-level `sendOtp` + `verifyOtp` chain below so the password can be passed on the signup path.
`sendOtp`, `verifyOtp` and `signUp` are public for flows that need explicit steps, but they must
preserve the same verification-token chain.

## Email OTP

```ts
const started = await cloud.auth.signInWithOtp({ email })
if (started.error) {
  showLoginError(started.error.message)
  return
}

const completed = await started.data.verify({ token: verificationCode })
if (completed.error) {
  showLoginError(completed.error.message)
  return
}

const user = completed.data.user
```

The SDK performs the closed flow:

```text
POST /v1/verification
  → verificationId + isExistingUser
POST /v1/verification/verify
  → one-time verificationToken
POST /v1/signin or /v1/signup
  → WorkBuddy session
```

Do not expose whether an email is registered in user-facing copy.

## Email + Password

```ts
const { data: session, error } = await cloud.auth.signInWithPassword({
  email,
  password,
})
if (error) {
  showLoginError('Wrong account or password')
  return
}
```

There is no unverified email+password signup. Signup requires a `verificationToken` obtained from
email OTP verification.

## Verified Signup with Password

A signup form that creates an account usable by password login must verify the email first and pass
the chosen password on the signup path. Prefer this explicit chain for signup forms:

```ts
const sent = await cloud.auth.sendOtp({ email })
if (sent.error) {
  showSignupError(sent.error.message)
  return
}

const completed = await cloud.auth.verifyOtp({
  verificationId: sent.data.verificationId,
  token: verificationCode,
  email,
  isExistingUser: sent.data.isExistingUser,
  password: sent.data.isExistingUser ? undefined : password,
})

if (completed.error) {
  showSignupError(completed.error.message)
  return
}
```

If the form is explicitly a signup form and `sent.data.isExistingUser` is true, route the user to
login with neutral copy instead of exposing account-existence details. Do not create an account with
an empty password when the UI promises password login.

## Password Recovery

```ts
const started = await cloud.auth.resetPasswordForEmail(email)
if (started.error) {
  showLoginError(started.error.message)
  return
}

const completed = await started.data.updateUser({
  nonce: verificationCode,
  password: newPassword,
})
if (completed.error) showLoginError(completed.error.message)
```

On success the SDK signs the user in and emits `PASSWORD_RECOVERY`.

Signed-in password change:

```ts
const result = await cloud.auth.resetPasswordForOld({
  oldPassword,
  newPassword,
})
if (result.error) showLoginError(result.error.message)
```

## Session and Route Guard

```ts
const { data: session, error } = await cloud.auth.getSession()
if (error || !session) {
  navigate('/login')
  return
}
```

`getSession()` refreshes near expiry. Use `refreshSession()` only when a forced refresh is needed.
`getUser()` calls `GET /.cloud/auth/v1/user/me`, so use it when server validation matters.

```ts
const unsubscribe = cloud.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') navigate('/login')
  renderUser(session?.user ?? null)
})
```

The SDK stores only the WorkBuddy access token and an opaque `wbrt_...` refresh handle. Provider
tokens remain in Cloud Backend Service. Never log tokens or put them in a URL.

## Calling the Application's Own Backend

```ts
const token = await cloud.auth.getAccessToken()
if (!token) throw new Error('Sign in required')

await fetch('/api/orders', {
  headers: { Authorization: `Bearer ${token}` },
})
```

The application backend may validate that token through the current application's Auth data plane;
it must not copy the Cloud Backend Service signing key.

## Error Handling

Every Auth method except `getAccessToken()` returns `{ data, error }`. Branch on stable
`error.kind`, not message text. Treat `unauthenticated`/`invalid_grant` as a request to sign in again;
keep the current session on transient `network`/`backend-unavailable` errors.

## Completion Bar

For a default login/signup request, inspect generated source before completion:

- It must include `signInWithPassword`.
- It must include `signInWithOtp` or `sendOtp` + `verifyOtp`.
- It must include `signUp` or a verified signup path that passes `password` to `verifyOtp`.
- It must include an auth gate before user-scoped Database or Storage calls.
- It must not include `signInAnonymously`, localStorage-only users or mock sessions.
- It must not initialize `@cloudbase/js-sdk` or hand-write `fetch('/.cloud/auth/**')`.

Verify on the published domain:

1. OTP registration and existing-user OTP login.
2. Password login and both password-reset flows.
3. Session survives reload and refresh; concurrent refresh performs one exchange.
4. Database/Storage requests automatically carry the current session.
5. `getUser()` returns the signed-in user and sign-out removes access.

If Email appears disabled/degraded in the WorkBuddy management page, do not patch around
it in generated application code. Use [`management.md`](./management.md) to inspect Provider truth.
