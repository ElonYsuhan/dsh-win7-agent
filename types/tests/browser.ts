import type { DshBridge, UiActionRequest, UiCapabilities } from '../browser/bridge'
const capabilities: UiCapabilities = { versions: [1, 2], components: ['chart', 'table', 'visual'] }
const action: UiActionRequest = {
  version: 1, sessionId: 'session_a', surfaceId: 'sales', revision: 1,
  expectedStateVersion: 0, requestId: 'action_1', componentId: 'send', actionId: 'analyze'
}
declare const bridge: DshBridge
void bridge.send('hello', [], [], undefined, 'session_a', capabilities)
void bridge.generativeUiAction(action, capabilities)
// @ts-expect-error UI capabilities must be an object, not a bare version number
void bridge.send('hello', [], [], undefined, 'session_a', 2)
// @ts-expect-error request IDs are strings
void bridge.generativeUiAction({ ...action, requestId: 1 }, capabilities)
