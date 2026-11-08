import { assertSnapshot, own } from '../../../src/main/contracts/generative-ui-interaction.js'
import { createSurfaceView, restoreSurfaceState, updateField, updateSlider } from './surface-view'
import type { Surface, SurfaceState, SurfaceView } from './types'

export interface ChangeIntent { readonly componentId: string; readonly value: string | number | boolean }
export interface ActionIntent { readonly componentId: string; readonly actionId: string }
export interface InteractionHost {
  read(request: unknown): Promise<unknown>
  change(request: unknown): Promise<unknown>
  dispatch(request: unknown): Promise<unknown>
  confirm(message: string): Promise<boolean>
  requestId(): string
  onRun?(sessionId: string, phase: 'begin' | 'rejected' | 'duplicate'): void
}
interface Receipt { readonly requestId: string; readonly surfaceId: string; readonly revision: number; readonly status: string; readonly sequence: number }
interface Snapshot {
  readonly version: 1; readonly sessionId: string; readonly sequence: number; readonly running: boolean
  readonly surfaces: Readonly<Record<string, { readonly revision: number; readonly stateVersion: number; readonly state: SurfaceState }>>
  readonly receipts: readonly Receipt[]
  readonly definitions: Readonly<Record<string, Surface>>
}
export interface InteractionPresentation {
  readonly revision: number
  readonly state: SurfaceState
  readonly canAct: boolean
  readonly note: string
}
interface Pending extends ChangeIntent { readonly requestId: string }

export function createInteractionController(sessionId: string, surface: unknown, host: InteractionHost, render: (value: InteractionPresentation) => void) {
  const initial = createSurfaceView(sessionId, surface)
  let view = initial, committed = initial, snapshot: Snapshot | null = null
  let definition: Surface | null = null
  let queue: Pending[] = [], task: Promise<void> | null = null, submitting = false, closed = false, error = '', ready = false
  function active(): boolean { return !closed }
  function latestReceipt(): Receipt | undefined { return snapshot?.receipts.filter(item => item.surfaceId === initial.surface.id && item.revision === initial.surface.revision).sort((a, b) => b.sequence - a.sequence)[0] }
  function entry() { if (!definition) return null; const result = (snapshot ? own(snapshot.surfaces, initial.surface.id) : null); return result?.revision === initial.surface.revision ? result : null }
  function show(): void {
    if (!active()) return
    const receipt = latestReceipt(), waiting = receipt && ['accepted', 'running'].includes(receipt.status)
    const interrupted = receipt?.status === 'interrupted'
    const note = error || (!ready ? '正在读取已保存的参数…' : !entry() ? '此界面仅供本地预览，交互记录尚不可用。' : submitting ? '正在提交界面操作…' : queue.length ? '正在保存参数…' : snapshot?.running || waiting ? 'Agent 正在处理，可停止当前会话。' : interrupted ? '上次操作已中断，不会自动重试；请先核对结果。' : receipt && receipt.status !== 'completed' ? '上次操作未完成，请核对会话中的执行结果。' : '参数已保存。')
    render({ revision: initial.surface.revision, state: view.state, canAct: Boolean(ready && entry() && !error && !submitting && !queue.length && !snapshot?.running && !waiting), note })
  }
  function apply(value: SurfaceView, intent: ChangeIntent): SurfaceView {
    const component = value.surface.components.find(item => item.id === intent.componentId)
    return component?.type === 'slider' ? updateSlider(value, intent.componentId, intent.value) : updateField(value, intent.componentId, intent.value)
  }
  function receive(input: unknown): void {
    assertSnapshot(input)
    const next = input as Snapshot
    if (next.sessionId !== sessionId) throw new Error('GENERATIVE_UI_INTERACTION_SESSION_MISMATCH')
    if (snapshot && next.sequence < snapshot.sequence) return
    const value = own(next.surfaces, initial.surface.id)
    if (value && value.revision === initial.surface.revision) {
      if (entry() && value.stateVersion < entry()!.stateVersion) return
      committed = restoreSurfaceState(initial, value.state)
      view = queue.reduce(apply, committed)
    }
    snapshot = next; ready = true
    show()
  }
  async function refresh(): Promise<void> {
    const input = await host.read({ version: 1, sessionId, surfaceId: initial.surface.id })
    assertSnapshot(input)
    const result = input as Snapshot
    const published = own(result.definitions, initial.surface.id)
    if (published && JSON.stringify(published) !== JSON.stringify(initial.surface)) throw new Error('GENERATIVE_UI_DEFINITION_MISMATCH')
    definition = published || null
    receive(result)
  }
  async function pump(): Promise<void> {
    try {
      while (queue.length) {
        const current = queue[0], value = entry()
        if (!value) throw new Error('GENERATIVE_UI_STATE_UNAVAILABLE')
        const request = { version: 1, sessionId, surfaceId: initial.surface.id, revision: initial.surface.revision, expectedStateVersion: value.stateVersion, requestId: current.requestId, componentId: current.componentId, value: current.value }
        let result: unknown
        try { result = await host.change(request) }
        catch (cause) {
          if (!String(cause).includes('STATE_UI_STATE_CONFLICT')) throw cause
          queue = []; await refresh()
          error = '参数已在其他窗口修改，请核对后重新调整。'; return
        }
        assertSnapshot(result)
        const updated = result as Snapshot
        const saved = own(updated.surfaces, initial.surface.id)
        if (updated.sessionId !== sessionId || !saved || saved.revision !== initial.surface.revision || saved.stateVersion < request.expectedStateVersion + 1) throw new Error('GENERATIVE_UI_SAVE_UNCONFIRMED')
        queue.shift(); receive(result); view = queue.reduce(apply, committed)
      }
    } catch (_) { error = '参数保存失败，尚未保存的调整不会回传 Agent；请重新读取后再试。' }
    finally { show() }
  }
  function flush(): Promise<void> {
    if (!task && queue.length && ready && entry()) {
      task = pump().finally(() => { task = null; show() })
    }
    return task || Promise.resolve()
  }
  function change(intent: ChangeIntent): void {
    if (!active() || submitting) return
    view = apply(view, intent)
    if ((!ready || entry()) && !error) {
      const pending = { ...intent, requestId: host.requestId() }
      const last = queue.length - 1
      if (last > 0 && queue[last].componentId === intent.componentId) queue[last] = pending
      else if (queue.length < 128) queue.push(pending)
      else { error = '待保存的调整过多，请重新读取后再试。'; show(); return }
      void flush()
    }
    show()
  }
  async function submit(intent: ActionIntent): Promise<void> {
    if (!active() || submitting || error || !entry() || snapshot?.running || ['accepted', 'running'].includes(latestReceipt()?.status || '')) return
    const component = initial.surface.components.find(item => item.id === intent.componentId)
    const action = initial.surface.actions.find(item => item.id === intent.actionId)
    if (!component || component.type !== 'button' || component.actionId !== intent.actionId || !action) return
    submitting = true; show()
    let began = false
    try {
      await flush()
      if (error || queue.length || !active()) return
      const confirmed = await host.confirm('将「' + component.label + '」及当前已保存的参数发送给 Agent？\n\n' + action.message + '\n\n后续工具仍受当前权限和审批约束。')
      if (!confirmed || !active()) return
      const current = entry()
      if (!current || snapshot?.running) return
      const requestId = host.requestId()
      began = true; host.onRun?.(sessionId, 'begin')
      const result = await host.dispatch({ version: 1, sessionId, surfaceId: initial.surface.id, revision: initial.surface.revision, expectedStateVersion: current.stateVersion, requestId, componentId: intent.componentId, actionId: intent.actionId })
      if (!result || typeof result !== 'object' || !('snapshot' in result) || !('started' in result) || typeof result.started !== 'boolean') throw new Error('GENERATIVE_UI_ACTION_UNCONFIRMED')
      receive(result.snapshot)
      if (!result.started) host.onRun?.(sessionId, 'duplicate')
    } catch (_) {
      if (began) host.onRun?.(sessionId, 'rejected')
      error = began ? '提交结果暂不确定，不会自动重试。请重新读取状态并核对执行结果。' : '操作确认失败，尚未提交。'
      try { await refresh() } catch (_) {}
    } finally { submitting = false; show() }
  }
  async function reload(): Promise<void> {
    if (submitting || !active()) return
    await flush(); queue = []; error = ''; ready = false; show()
    try { await refresh() } catch (_) { ready = true; error = '交互记录暂不可用；本地调整不会自动提交。'; show() }
  }
  show()
  void refresh().then(() => { if (queue.length) void flush() }, () => { ready = true; error = '交互记录暂不可用；本地调整不会自动提交。'; show() })
  return Object.freeze({ change, submit, receive, reload, flush, dispose(): void { void flush(); closed = true } })
}
