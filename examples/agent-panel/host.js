// 本机开发示例：回环 HTTP 需显式启用；远程部署须改为实际 HTTPS Service origin。
// 宿主后端（不是浏览器）持有用户 Bearer，负责创建会话并按需签发一次性面板票据；
// 浏览器只拿到短期票据与面板令牌，不接触长期密钥。
// 本示例依赖宿主实现 /agent-session-ticket；不代表真实 HESYN 联调或验收。
import AgentPanel from 'http://127.0.0.1:18090/panel/1.0.8/agent-panel.js'
import { createHostStorage } from 'http://127.0.0.1:18090/panel/1.0.8/host-storage.js'

const SERVICE = 'http://127.0.0.1:18090'
let sessionId = sessionStorage.getItem('agent-session-id') || ''
let panel = null

async function ticket(request) {
  // 宿主后端：已有会话时调用 POST /api/v1/sessions/:id/tickets，
  // 新会话时调用 POST /api/v1/sessions，返回 { sessionId, credential }。
  // request.sessionId 是组件请求的会话（内置“历史/新建”切换时会传入），必须优先采用。
  const requested = request && typeof request.sessionId === 'string' ? request.sessionId : sessionId
  const response = await fetch('/agent-session-ticket?sessionId=' + encodeURIComponent(requested), { method: 'POST' })
  if (!response.ok) throw new Error('无法获取 Agent 会话票据：' + response.status)
  const value = await response.json()
  sessionId = value.sessionId
  sessionStorage.setItem('agent-session-id', sessionId)
  return { sessionId, credential: value.credential }
}

async function mount() {
  panel = await AgentPanel.mount(document.getElementById('agent'), {
    endpoint: SERVICE,
    sessionId: sessionId || undefined,
    auth: { ticket },
    // 必须由宿主注入；组件不会自行创建 IndexedDB。
    storage: createHostStorage({ databaseName: 'hesyn-agent-sessions' }),
    theme: 'auto',
    // 可选：宿主侧连接器生命周期与通知；工具执行仍由 Service 侧 Host Connector 完成。
    hostConnector: {
      attach({ sessionId: id, emit }) { console.log('Agent 会话已连接', id) },
      detach() {}
    },
    onEvent(event) { console.log('agent-panel', event.type) }
  })
}

function unmount() {
  if (!panel) return
  AgentPanel.unmount(panel)
  panel = null
}

function destroy() {
  if (!panel) return
  panel.destroy()
  panel = null
}

mount().catch(error => console.error('AgentPanel 挂载失败', error))
