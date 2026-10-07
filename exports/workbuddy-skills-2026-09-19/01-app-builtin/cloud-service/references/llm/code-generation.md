# LLM API · Write LLM Call Code

Integrate large-model calls into the app — keyless, so the user needs no API key of their own:
chat, summarization, translation, classification, copywriting.

> Read this file only when you need to **write model-call code for the app**. To look up the model
> list or usage → read `management.md`.

## Prerequisites

1. The current app's cloud service environment is confirmed present and usable per **Environment
   Lifecycle** in `SKILL.md`.
2. The client is initialized per **How an App Talks to It** in `SKILL.md` — SDK or plain-HTML CDN.
3. To confirm the target model is available → see the model list query in `management.md`.

## Import and Initialization

The only formal SDK package is `@tencent-ai/workbuddy-cloud-sdk`
(source: `packages/workbuddy-cloud-sdk/`). The temporary legacy package has been deleted and must
not be used as a compatibility or migration alias.

npm package (projects with a build step):

```bash
npm install @tencent-ai/workbuddy-cloud-sdk
```

```ts
import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk';
```

CDN `<script>` (plain HTML, no build step) — the IIFE build exposes the global `WorkBuddyCloud`:

```html
<script src="https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js"></script>
```

Initialize the client **only** with the public config returned by the cloud-service lifecycle, and
pass **both** values — `publicConfig.endpoint` and `publicConfig.publishableKey`. `endpoint` is
required: do not omit it and rely on the SDK's same-origin fallback. Never hard-code these values,
and never source them from env vars or a BFF.

```ts
const cloud = createWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  publishableKey: publicConfig.publishableKey,
});
// CDN form: WorkBuddyCloud.createWorkBuddyCloud({ ...same options })
```

Every `cloud.llm.*` snippet below is identical in both forms.

## Capabilities

- How keyless auth works (where the credential comes from, whether the end user must be logged in).
- Basic call: single turn, full response collected from the streaming SSE chunks.
- Streaming: token-by-token output, front-end rendering, aborting a request.
- Conversation continuity: application-managed conversation IDs for chat, follow-up questions, and chat windows.
- Common parameters: model selection, temperature, max output length.
- Common patterns: chat UI, text summarization, content classification, structured output (all via `stream: true`).
- Error handling: branches and retry strategy for not-logged-in, out of quota, request timeout,
  content blocked, model unavailable.

## Model List

Before the first chat call, fetch the model list and let the user choose (or pick the first one).
An empty list is a legal result and must be handled explicitly — do not fall back to a hard-coded
model id.

```ts
const models = await cloud.llm.models.list();
if (models.length === 0) {
  showEmptyModelState();
  return;
}

// disabled / enabled handling:
// - disabled === true  → model is disabled, show as non-selectable
// - disabled === false → explicitly enabled, show as selectable
// - disabled === undefined → enabled defaults to true, show as selectable
// `disabled: true` (or `enabled: false`) means the directory currently marks
// that model as non-selectable; do not send it as a fallback or auto-select it.
const model = models.find((item) => item.disabled !== true);
if (!model) {
  showEmptyModelState();
  return;
}
const label = model.name ?? model.id;

// Sparse public fields: only show when the server explicitly provides them.
// Missing ≠ false/0 — do not disable features based on absence.
// Explicit false/0 are preserved and distinct from absence.
if (model.supportsImages === true) enableImageInput();
if (model.supportsToolCall === true) enableToolUse();
if (model.supportsReasoning === true) {
  // reasoning sub-fields are each independently sparse
  if (model.reasoning?.defaultEffort) setDefaultReasoningEffort(model.reasoning.defaultEffort);
  if (model.reasoning?.supportedEfforts?.length) setReasoningEffortOptions(model.reasoning.supportedEfforts);
  if (model.reasoning?.canDisableThinking === false) disableThinkingToggle();
}
if (model.disabledMultimodal === true) disableMultimodalInput();
if (model.credits) showCreditsLabel(model.credits); // display info, NOT billing/quota
if (model.maxInputTokens !== undefined) showInputLimit(model.maxInputTokens);
```

`disabled: true` (or `enabled: false`) means the directory currently marks that model as non-selectable; do
not send it as a fallback. `name` is always safe for display, while `description`, limits, modalities,
capabilities, and public pricing are optional. Sparse public fields (`credits`, `supportsImages`,
`supportsToolCall`, `supportsReasoning`, `onlyReasoning`, `reasoning`, `temperature`, `top_k`, `top_p`,
`repetition_penalty`, `maxAllowedSize`, `disabledMultimodal`) follow the same rule: present only when the
server explicitly provides them; explicit `false`/`0`/empty array are preserved; absence means unknown.
Do not derive missing fields from model IDs or vendor names. `credits` is display information, not a
billing fact or available quota. Always pass the user-selected model `id` to
`chat.completions.create()`; the actual call result is determined by the response, not by the
directory entry.

## System Prompt, Conversation IDs, and Chat Context

Every chat request must start with an application-owned `system` message, or the call fails with an
error (the SDK does **not** insert a default one for you). Use it for the app's stable behavior and
safety rules; do not put end-user input in this first message.

```ts
const systemPrompt = 'You are a helpful customer-support assistant. Be concise and do not invent facts.';
const messages = [
  { role: 'system', content: systemPrompt },
  { role: 'user', content: prompt },
];
```

**Every generated call site must include this first message — check this before finishing any task
that adds or edits a `chat.completions.create()` call.** If the app has no specific system prompt
requirement, use this fallback rather than omitting the message:

```ts
{ role: 'system', content: 'You are a helpful assistant. Be concise and helpful.' }
```

`conversationId` is a **conversation routing and association ID**. It keeps related requests
associated for queueing, metering, auditing, and diagnostics. It is not a server-side chat-history
store and does not by itself make the model remember prior messages.

For summarization, classification, translation, and other one-shot questions, do **not** pass a
`conversationId`: each request is independent. For a chat window or follow-up flow, the application
must generate, store, restore, rotate, and reuse its own conversation ID. Pass that ID explicitly
to every related `create()` call.

The SDK does not create or persist conversations, and it does not provide a conversation namespace
or default browser storage. The server validates the ID and supplies its own request/message IDs;
do not send `requestId` or `messageId`.

The `messages` array is the model context for the current request. If the product needs the model
to see prior turns, the application must maintain the needed history and include it in `messages`
on each call. Use the same `conversationId` as well so related requests retain stable routing.

```ts
const conversationId = currentChat.conversationId; // App-owned state/storage.
const messages = [
  { role: 'system', content: currentChat.systemPrompt },
  ...currentChat.modelContext, // App-owned, bounded history after system.
  { role: 'user', content: prompt },
];

for await (const chunk of cloud.llm.chat.completions.create({
  model: model.id,
  messages,
  stream: true,
  conversationId,
})) {
  renderChunk(chunk);
}
```

When the user starts a new chat, generate and save a new application-owned ID and switch to that
chat's own context. When reopening a chat, restore both its ID and the application-owned history.
Do not assume that reusing only `conversationId` restores prior messages.
## Streaming Chat (recommended for interactive UI)

Use `stream: true` for token-by-token rendering. Pass an `AbortController` signal so the user can
stop generation; aborting closes the SSE stream and ends the current call (no resume, no reconnect).

```ts
const controller = new AbortController();

try {
  for await (const chunk of cloud.llm.chat.completions.create({
    model: model.id,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: prompt },
    ],
    stream: true,
    stream_options: { include_usage: true },
    temperature: 1,
    signal: controller.signal,
  })) {
    const choice = chunk.choices[0];
    if (choice?.delta?.content) appendAnswer(choice.delta.content);
    if (chunk.usage) showUsage(chunk.usage.total_tokens);
  }
} catch (error) {
  showLLMError(error);
} finally {
  setGenerating(false);
}

stopButton.onclick = () => controller.abort();
```

### Sampling Parameters: What `create()` Actually Accepts

`models.list()` shows `temperature` / `top_k` / `top_p` / `repetition_penalty` as **model-recommended
values for display** (e.g. pre-filling a settings UI) — do not assume every one of them can be passed
to `chat.completions.create()`:

| Field | Passable to `create()`? |
|---|---|
| `temperature` | Yes — standard OpenAI param. |
| `top_p` | Yes — standard OpenAI param. |
| `repetition_penalty` | Yes — Genie BaaS extension; effect depends on the selected model. |
| `top_k` | **No.** `models.list()` shows it only as a reference value; passing it to `create()`
  has no effect (the SDK does not even type it there). |

```ts
for await (const chunk of cloud.llm.chat.completions.create({
  model: model.id,
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: prompt },
  ],
  stream: true,
  temperature: model.temperature,
  top_p: model.top_p,
  repetition_penalty: model.repetition_penalty, // pass through only if the model provides one
})) {
  // ...
}
```

## Non-Streaming Is Not Supported

The API only supports streaming chat completions (`stream: true`). There is no non-streaming
(JSON) `ChatCompletion` response. Do **not** omit `stream` or set it to `false` — the SDK rejects
such input with `CloudOpenAIError` (`error.code = 'request_stream_required'`, `error.param = 'stream'`)
before any network request is sent.

### One-shot patterns still use streaming

For classification, summarization, translation, structured output, or any result that the UI does
not need to render token-by-token, still call `create()` with `stream: true` and collect the full
text from the SSE chunks yourself:

```ts
let answer = '';
for await (const chunk of cloud.llm.chat.completions.create({
  model: model.id,
  messages: [
    { role: 'system', content: 'You are a precise text classifier. Reply with JSON only.' },
    { role: 'user', content: 'Classify this text as positive or negative.' },
  ],
  stream: true,
  response_format: { type: 'json_object' },
})) {
  const delta = chunk.choices[0]?.delta?.content;
  if (delta) answer += delta;
}
// answer now holds the full JSON string; parse it on the caller side.
const result = JSON.parse(answer);
```

Key points for one-shot patterns:
- Always pass `stream: true`. The SDK will throw `request_stream_required` otherwise.
- `response_format` and `stream_options` (e.g. `{ include_usage: true }`) are forwarded as-is when
  `stream: true`; use `stream_options` to receive a final `usage` chunk.
- Collect content deltas until the stream ends. Do **not** expect a `ChatCompletion` JSON response
  object — only `ChatCompletionChunk` objects arrive over SSE.
- Parse structured output (JSON, classification labels, etc.) from the accumulated text on the
  caller side; the SDK does not synthesize a non-streaming completion.

## SSE Frame Handling

The streaming response consists of SSE `data:` frames, each carrying a `ChatCompletionChunk`.
Understanding the frame sequence is essential for correct consumption.

### Frame sequence

A complete successful stream follows this order:

1. **Role init frame** — `delta.role = "assistant"`, `delta.content = ""`. This is the first chunk;
   the empty content is a placeholder, not real text. Do not render it.

2. **Content delta frames** — `delta.content` carries text fragments (e.g. `"p"`, `"ong"`).
   Concatenate them in order to build the full reply. Skip `null` and empty strings.

3. **Reasoning delta frames** (optional, model-dependent) — `delta.reasoning_content` carries
   the model's thinking/reasoning process. Accumulate it **separately** from `content`; it is
   not part of the visible assistant reply. Whether to display it is an application decision.

4. **Tool-call delta frames** (when the model calls tools) — `delta.tool_calls` carries fragments
   identified by `index`. The first fragment for a given `index` typically includes `id` and
   `function.name`; subsequent fragments append `function.arguments` pieces. The SDK only forwards
   these deltas; **the business layer decides when to execute the tool** — the SDK/protocol does
   not define tool-execution rounds, retry, or idempotency.

5. **Finish frame** — `delta = {}`, `finish_reason` is non-null (`stop`/`length`/`tool_calls`/
   `content_filter`). `usage` typically appears in this frame when `stream_options.include_usage`
   is set.

6. **[DONE]** — `data: [DONE]` signals normal stream termination.

### Safe text accumulation

```ts
let content = '';
let reasoning = '';
let finishReason: string | null = null;

for await (const chunk of cloud.llm.chat.completions.create({
  model: model.id,
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: prompt },
  ],
  stream: true,
  stream_options: { include_usage: true },
})) {
  const delta = chunk.choices[0]?.delta;

  // Content — always check for null/empty before appending
  if (delta?.content) {
    content += delta.content;
    appendAnswer(delta.content); // incremental render
  }

  // Reasoning — accumulate separately, never mix with content
  if (delta?.reasoning_content) {
    reasoning += delta.reasoning_content;
    appendReasoning(delta.reasoning_content);
  }

  // Refusal — model declined to answer
  if (delta?.refusal) {
    appendRefusal(delta.refusal);
  }
}

// After loop: content holds the full reply, reasoning holds the thinking trace
```

### Tool-call delta accumulation

Tool calls arrive as fragments. Accumulate them by `index`:

```ts
interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

const toolCalls: Map<number, AccumulatedToolCall> = new Map();

for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta;
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const existing = toolCalls.get(tc.index) ?? { id: '', name: '', arguments: '' };
      if (tc.id) existing.id = tc.id;
      if (tc.function?.name) existing.name = tc.function.name;
      if (tc.function?.arguments) existing.arguments += tc.function.arguments;
      toolCalls.set(tc.index, existing);
    }
  }
  if (chunk.choices[0]?.finish_reason === 'tool_calls') {
    // All tool-call deltas have been received.
    // The SDK/protocol does NOT decide when to execute — that is the
    // business layer's responsibility. Do not define retry/round logic here.
    for (const [, tc] of toolCalls) {
      const args = JSON.parse(tc.arguments); // Parse accumulated arguments
      // executeTool(tc.name, args) — business-layer decision
    }
  }
}
```

Key rules:
- `index` is the only required field on each tool-call delta; use it to assemble fragments.
- `id`, `type`, `function.name`, and `function.arguments` are all optional on individual chunks.
- Empty `function_call` or empty `tool_calls` arrays are placeholder frames — skip them safely.
- The SDK only passes tool deltas through; it does not execute, schedule, or retry tool calls.

### Finish reason and usage

```ts
for await (const chunk of stream) {
  const choice = chunk.choices[0];
  if (choice?.finish_reason) {
    // 'stop' — natural end
    // 'length' — hit max_tokens
    // 'tool_calls' — model wants to call tools
    // 'content_filter' — content filtered
  }
  if (chunk.usage) {
    // Basic fields (always present when usage is sent):
    const { prompt_tokens, completion_tokens, total_tokens } = chunk.usage;

    // OpenAI-standard extensions (present per OpenAI's own spec):
    // chunk.usage.prompt_tokens_details?.cached_tokens — prompt tokens that hit cache
    // chunk.usage.completion_tokens_details?.reasoning_tokens — thinking-token count

    // Genie BaaS extensions — NOT part of the OpenAI contract, provider-dependent,
    // diagnostic/billing-signal only. Do not treat missing or zero-valued fields as
    // errors, and do not assume any of them survive a model/provider switch:
    // chunk.usage.prompt_cache_hit_tokens — mirrors prompt_tokens_details.cached_tokens (flat, no nesting)
    // chunk.usage.prompt_cache_miss_tokens — prompt tokens NOT served from cache
    // chunk.usage.prompt_cache_write_tokens — prompt tokens newly written to cache this call
    // chunk.usage.cache_read_input_tokens / cache_creation_input_tokens — raw provider field
    //   names surfaced before being normalized into the two fields above
    // chunk.usage.completion_thinking_tokens — mirrors completion_tokens_details.reasoning_tokens
    // chunk.usage.credit — credits spent on this call; NOT a final bill or balance,
    //   always 0 for external/custom models (billed by the upstream provider instead)
  }
}
```

These usage extensions are useful for **cost/cache-efficiency dashboards** (e.g. show the user how
many tokens were served from cache, or how many credits a call spent) — do not treat missing or
zero-valued fields as errors, and do not assume any of them survive a model or provider switch.

### DONE and stream errors

The stream is considered complete only when `data: [DONE]` is received. If the stream ends
without `[DONE]` and without an `event: error`, the SDK throws `CloudOpenAIError` with
`error.code = 'gateway_stream_interrupted'`.

All in-stream errors carry `requestId` (from the `X-Request-Id` response header) for diagnostics:

| Error scenario | `error.code` | Has `requestId`? |
|---|---|---|
| `event: error` SSE event | upstream code | Yes |
| Chunk-embedded `error` object | upstream code | Yes |
| JSON parse failure | `gateway_invalid_response` | Yes |
| Missing `[DONE]` interruption | `gateway_stream_interrupted` | Yes |
| HTTP non-2xx | upstream code | Yes (via `httpError`) |

```ts
try {
  for await (const chunk of cloud.llm.chat.completions.create({ ... })) {
    // consume chunks
  }
} catch (error) {
  if (error instanceof CloudOpenAIError) {
    console.error('Request failed:', error.error.code);
    if (error.requestId) {
      console.error('Request ID for support:', error.requestId);
    }
  }
}
```

Preserve already-rendered text when a stream is interrupted; offer the user a regenerate button.

## Error Handling

All LLM errors surface as `CloudOpenAIError`, an OpenAI-compatible error object with Genie BaaS
diagnostic extensions. Do not read SDK-private fields — only use the public shape below.

```ts
interface CloudOpenAIError extends Error {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
  status?: number;
  requestId?: string;
  retryAfterMs?: number;
}
```

Handle by the stable `error.code` prefix:

| code prefix | UI behavior |
|---|---|
| `request_` | Parameter or model mismatch; do not auto-retry. |
| `auth_` | Cloud credential / Origin invalid; do not ask the end user to log in. |
| `quota_` | Creator quota exhausted or rate-limited; only `quota_rate_limited` with `retryAfterMs` suggests retry. |
| `gateway_` / `model_` | Model service temporarily unavailable; offer a regenerate button. |
| `internal_` | Generic failure; show the `requestId`, never backend stacks. |

If a stream starts but ends without `[DONE]` and without an `event: error`, the SDK throws
`CloudOpenAIError` with `error.code = 'gateway_stream_interrupted'`. Preserve the already-rendered
text and offer regenerate.

## Safety Notes

- **Keyless is not protection-free**: the channel belongs to the current app — never expose it as an
  open proxy anyone can call.
- Never hard-code any model-service key into the front end; if a pattern requires the front end to
  hold a long-lived key, the pattern is wrong.
- Process user input before splicing it into a prompt so it cannot rewrite the system instructions
  via prompt injection.
- Never feed sensitive user data (phone numbers, identity details, credentials) into the model raw.
- **Model output is untrusted**: never execute it as code, never splice it into SQL or shell
  commands, and escape it before rendering it into the page.
- Rate-limit calls that end users can trigger, so the quota cannot be drained in one go.

## Forbidden Patterns

The following are always wrong for generated app code:

- Importing the deleted legacy package or any alias of it — use `@tencent-ai/workbuddy-cloud-sdk`
  only (npm specifier, or the CDN `index.global.js` for plain HTML).
- Using tenant API keys or platform tokens in the browser.
- Building a BFF / Node API route / server proxy to call the model service directly from the front end.
- Passing `Authorization: Bearer <server-key>` or `X-User-Id` from the browser.
- Splicing `/.cloud/llm/*` paths manually instead of calling the SDK methods.
- Reading or inventing internal model fields such as provider URL, request headers, request body,
  routing, fallback, gray policy, or credentials. `models.list()` exposes only its documented
  public model DTO fields.
- Inventing Config V3, model-usage, or quota/billing APIs that the SDK does not expose — see
  `management.md` for what is actually available.

## Completion Bar

Calls actually return; streaming renders correctly and can be aborted; non-streaming input is
rejected with `request_stream_required` before any network call; out-of-quota, timeout and
content-blocked produce a clear message instead of failing silently. Every `chat.completions.create()`
call site has a `system` message as `messages[0]` — grep the generated source for
`chat.completions.create` and confirm each call passes it before reporting done.
