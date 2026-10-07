'use strict'

/**
 * builtin/self-validate —— 自我验证闭环：进程生命周期 + 就绪等待 + 验证账本 +
 * 证据优先的编排约束。与 builtin/browser-tools（CDP 浏览器驱动 + TestReport）合起来，
 * 覆盖「拆解 → 落地 → 验证 → 修补 → 再验证」整条链。
 *
 * 设计原则（对齐 WorkBuddy 的完成判定）：
 *   完成 = 验收标准被真实运行的证据满足，而不是「代码改完了」。
 *   于是这里补的是四件事：跑得起来（start/stop/list + 日志）、等得准（wait_ready）、
 *   记得住（账本落文件，上下文压缩后不丢）、停得下来（连续无进展就停，不靠数轮）。
 */

const not = (value) => value ? false : true
const { ProcessManager, waitReady } = require('../../../agent/process-manager')
const { initLedger, appendLedger, readLedger } = require('../../../agent/validation-ledger')

const PROCESS_TOOLS = [
  {
    name: 'start_process',
    permission: 'command',
    description: 'Start a long-running process in the background (dev server, watcher, API). Returns immediately with a pid — the process keeps running for later tool calls. Name it (e.g. "dev") and use the same name for process_logs / stop_process. Only processes started here can be stopped by stop_process. After starting a service, call wait_ready before testing it.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Handle for this process: letters, digits, dot, dash, underscore (1-32).' },
        command: { type: 'string', description: 'Command line, e.g. "npm run dev".' },
        cwd: { type: 'string', description: 'Workspace-relative working directory. Default is .' },
        env: { type: 'object', description: 'Extra environment variables (optional).' }
      },
      required: ['name', 'command']
    }
  },
  {
    name: 'stop_process',
    permission: 'command',
    description: 'Stop a background process started earlier with start_process (kills its whole process tree). Use it before restarting a service after a code change.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name given to start_process.' }
      },
      required: ['name']
    }
  },
  {
    name: 'list_processes',
    permission: 'read',
    description: 'List background processes started in this conversation: name, pid, running, exit code, command, uptime.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'process_logs',
    permission: 'read',
    description: 'Read the captured stdout/stderr of a background process (ring buffer, last 256KB). Use grep to find errors and tail to read the last lines. This is the primary evidence source when a service fails to start.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Process name.' },
        grep: { type: 'string', description: 'Only return lines containing this text (optional).' },
        tail: { type: 'number', description: 'Only return the last N lines (optional).' }
      },
      required: ['name']
    }
  },
  {
    name: 'wait_ready',
    permission: 'read',
    description: 'Wait until a service is actually reachable before testing it: polls an HTTP url (any response counts as ready, the status code is returned) or a TCP port until ready or timeout. Returns ready=false with the last error when it never came up — then read process_logs for the startup failure instead of blaming the test.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'HTTP url to poll, e.g. http://127.0.0.1:3000/health' },
        port: { type: 'number', description: 'TCP port to poll (alternative to url).' },
        host: { type: 'string', description: 'Host for port mode. Default 127.0.0.1.' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds. Default 30000.' }
      }
    }
  },
  {
    name: 'validate_ledger',
    permission: 'write',
    description: 'The validation ledger for the current task (<workspace>/.agent/validation/<task>.md, append-only). action=init: record the requirement and the checkable acceptance criteria BEFORE changing code. action=append: after each verification round, write what was run, what the evidence was (command exit code / HTTP status / assertion actual value / log line) and the conclusion. action=read: re-read the ledger (do this after context compression, or at the start of a resumed task).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'init | append | read' },
        task: { type: 'string', description: 'Short task name — same value across calls for one task.' },
        requirement: { type: 'string', description: 'For init: the original request, verbatim.' },
        criteria: { type: 'array', description: 'For init: checkable acceptance criteria, one sentence each.' },
        note: { type: 'string', description: 'For append: round record (what ran, evidence, conclusion, next step).' }
      },
      required: ['action', 'task']
    }
  }
]

/* 编排约束：证据优先、轮次不是指标、无进展就停 —— 直接对应「怎么算搞好了」 */
const VERIFICATION_PROMPT = [
  '## Verification discipline (self-validation loop)',
  'Completion means the acceptance criteria were satisfied by REAL EVIDENCE from tool results — never because you edited code or reason that it should work.',
  '1. Before changing code: turn the request into checkable acceptance criteria and record them with validate_ledger (action=init). A criterion must be decidable by a tool result ("POST /api/x returns 200", "the list has one more row", "no console errors"), not by an opinion.',
  '2. Proof only comes from tools: command exit code, HTTP status, DOM/app-state read, assertion actual value, log line, screenshot. Your own reasoning is not evidence.',
  '3. After every change re-run the SAME verification. Before declaring done, re-run the previously passing cases as well (regression), because fixing A often breaks B.',
  '4. Rounds are not the metric — progress is. Each retry must add new evidence. If two consecutive rounds fail on the same assertion with the same actual value, STOP repeating: change strategy (fix the environment, fix the assertion itself, restart the service, or ask the user with a failure report) instead of trying the same edit again.',
  '5. Verification classes, cheapest first: static (lint / typecheck / build) → unit tests → HTTP health & status → DOM & app state → console / network → process logs → screenshot. Always prefer the cheapest class that can decide the question.',
  '6. Long-running services: start_process to launch, wait_ready BEFORE testing, process_logs when startup fails, stop_process + start_process to restart after a code change. Never assume a service is up because you started it.',
  '7. If something cannot be verified, say so explicitly ("not verified") in the final report. Do not imply success you cannot prove.',
  '8. Clean up after every round: browser_close the verification window you launched, and stop_process the services you started, unless the user still needs them. Verification that leaves stray windows or background processes behind is not finished.',
  '9. In the final reply, state: the acceptance criteria, the evidence for each (pass/fail), what you changed, and anything left unverified.'
].join('\n')

function apply(ctx) {
  /* 每个会话一台 worker，进程表挂在 agent 实例上（与 browser driver 同款隔离） */
  const managerFor = (toolCtx) => {
    const agent = toolCtx && toolCtx.agent
    if (not(agent)) {
      throw new Error('PROCESS_NO_CONTEXT: 需要会话上下文')
    }
    if (not(agent._processManager)) {
      agent._processManager = new ProcessManager({ workspaceRoot: toolCtx.workspaceRoot })
    }
    agent._processManager.setWorkspace(toolCtx.workspaceRoot)
    return agent._processManager
  }

  for (const tool of PROCESS_TOOLS) {
    ctx.registerTool({
      name: tool.name,
      permission: tool.permission,
      description: tool.description,
      parameters: tool.parameters,
      execute: async (args, toolCtx) => {
        const input = args && typeof args === 'object' ? args : {}
        const root = (toolCtx && toolCtx.workspaceRoot) || ''
        if (tool.name === 'start_process') {
          const result = managerFor(toolCtx).start(input)
          return JSON.stringify(result)
        }
        if (tool.name === 'stop_process') {
          return JSON.stringify(await managerFor(toolCtx).stop(input.name))
        }
        if (tool.name === 'list_processes') {
          const list = managerFor(toolCtx).list()
          return list.length ? JSON.stringify(list) : '(no background processes)'
        }
        if (tool.name === 'process_logs') {
          const outcome = managerFor(toolCtx).logs(input.name, { grep: input.grep, tail: input.tail })
          return 'name=' + outcome.name + ' running=' + outcome.running + ' exitCode=' + outcome.exitCode +
            ' bytes=' + outcome.bytes + '\n' + outcome.text
        }
        if (tool.name === 'wait_ready') {
          const outcome = await waitReady(input)
          return JSON.stringify(outcome)
        }
        if (tool.name === 'validate_ledger') {
          if (not(root)) {
            throw new Error('LEDGER_NO_WORKSPACE: 先选择工作区')
          }
          const action = String(input.action || '').toLowerCase()
          if (action === 'init') {
            const outcome = initLedger(root, input.task, { requirement: input.requirement, criteria: input.criteria })
            return (outcome.created ? 'ledger created: ' : 'ledger already exists (kept as-is): ') + outcome.path + '\n' + outcome.text
          }
          if (action === 'append') {
            const outcome = appendLedger(root, input.task, input.note)
            return 'appended to ' + outcome.path + ' (now ' + outcome.bytes + ' bytes)'
          }
          if (action === 'read') {
            const outcome = readLedger(root, input.task)
            if (not(outcome.exists)) {
              return 'ledger not found: ' + outcome.path + ' — run action=init first'
            }
            return 'ledger ' + outcome.path + '\n' + outcome.text
          }
          throw new Error('LEDGER_BAD_ACTION: ' + action)
        }
        throw new Error('UNKNOWN_TOOL: ' + tool.name)
      }
    })
  }

  ctx.addSystemPrompt(() => VERIFICATION_PROMPT)
  /* 后台进程的回收：ProcessManager 自己在 process 退出时尽力杀自己拉起的进程树
     （Windows 用 taskkill /T /F，POSIX 用进程组）。会话中途不主动杀 —— 用户可能
     正在用那个 dev server；要停就显式 stop_process。 */
}

module.exports = {
  name: 'builtin/self-validate',
  version: '0.1.0',
  description: 'Self-validation loop: background process lifecycle, readiness waiting, validation ledger and evidence-first completion rules.',
  apply: apply,
  VERIFICATION_PROMPT: VERIFICATION_PROMPT,
  PROCESS_TOOLS: PROCESS_TOOLS
}
