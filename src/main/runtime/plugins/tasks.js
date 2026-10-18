'use strict'
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto')
const contract = require('../../contracts/tasks'), policy = require('../../flow/task-policy')
const { TaskRepository } = require('../../tasks/repository')
module.exports = {
  name: 'core/tasks', inject: ['agentConfig', 'agents', 'tools', 'contracts'],
  apply(ctx) {
    let fault = ''
    let repo = null, pool, emit = () => {}, timer, active = null, closed = false, clock = () => Date.now(), pending = Promise.resolve(), jobs = new Set()
    const now = () => clock(), notify = () => emit({ type: 'tasks:changed' })
    const configuration = () => { const settings = ctx.agentConfig.settings; return settings && (settings.data || settings.all()) || {} }
    function requireRepo() { if (!repo || closed) throw new Error('TASKS_NOT_READY') }
    function workspace(projectId) {
      const settings = configuration(), project = (settings.projects || []).find(p => p.id === projectId)
      const value = projectId ? project && (project.folders || [])[0] : settings.workspacePath
      if (!value || !fs.statSync(value).isDirectory()) throw new Error('TASK_WORKSPACE_INVALID')
      return fs.realpathSync(value)
    }
    function tasksSave(tasks) { repo.save(tasks); notify() }
    function createRun(task, trigger, scheduledAt, status, summary) {
      const id = trigger === 'manual' ? crypto.randomUUID() : task.id + ':' + scheduledAt
      if (repo.runs.has(id)) return repo.runs.get(id)
      return repo.append({ version: 1, sequence: 1, id, taskId: task.id, sessionId: status === 'skipped' ? '' : 'task_' + crypto.createHash('sha256').update(id).digest('hex').slice(0,32), task: JSON.parse(JSON.stringify(task)), trigger, scheduledAt, createdAt: now(), status, summary: summary || '' })
    }
    async function execute(run) {
      if (active || closed) return
      if (pool.runningCount() >= Math.max(1, pool.maxConcurrentRuns - 1)) return
      active = run
      const monotonicStart = process.hrtime.bigint(), duration = () => Math.round(Number(process.hrtime.bigint() - monotonicStart)/1000000)
      try {
        repo.transition(run.id, { status: 'running', startedAt: now() }); notify()
        const task = run.task
        if (task.projectId && !(configuration().projects || []).some(p=>p.id===task.projectId)) throw new Error('TASK_PROJECT_UNAVAILABLE')
        if (!fs.statSync(task.workspaceRoot).isDirectory() || fs.realpathSync(task.workspaceRoot)!==task.workspaceRoot) throw new Error('TASK_WORKSPACE_CHANGED')
        const result = await pool.runUnattended(run.sessionId, task.prompt, { workspaceRoot: task.workspaceRoot,
          settings: { permissionMode: task.permission, approveCommands: false, maxIterations: task.maxSteps, turnTimeoutMs: task.timeoutMs, requestTimeoutMs: task.timeoutMs, maxTokens: Math.min(task.maxTokens,task.tokenBudget), contextAutoCompress: false,
            unattended: { tools: task.tools, commands: task.commands, origins: task.origins, tokenBudget: task.tokenBudget, maxRequests: task.maxRequests, outputBytes: task.outputBytes } } })
        const messages = result && result.messages || [], execution = result && result.execution
        const denied = messages.filter(m => m.role === 'tool' && /^(DENIED|DISABLED):/.test(String(m.content)))
        const last = messages.slice().reverse().find(m=>m.role==='assistant'&&m.content)
        const status = denied.length ? 'needs_attention' : execution && execution.status === 'completed' ? 'completed' : execution && ['cancelled','timed_out','exhausted','interrupted'].includes(execution.status) ? execution.status : 'failed'
        repo.transition(run.id, { status, endedAt: now(), durationMs: duration(), summary: denied.length ? denied.map(m=>String(m.content)).join('\n').slice(0,2000) : status === 'completed' ? String(last && last.content || '任务完成').slice(0,1000) : '任务未完成：' + status + (execution && execution.reason ? ' · ' + execution.reason : ''), blockedOperations: denied.map(m=>String(m.content)).slice(0,20) })
      } catch (error) { repo.transition(run.id, { status: 'failed', endedAt: now(), durationMs: duration(), summary: error.message.slice(0,1000) }) }
      finally {
        active = null
        const result = repo.runs.get(run.id), index = repo.tasks.findIndex(t=>t.id===run.taskId)
        if (index !== -1) {
          const task = repo.tasks[index], failures = result.status === 'completed' ? 0 : result.status === 'cancelled' ? task.failures : task.failures + 1
          tasksSave(repo.tasks.map(t=>t.id===task.id?{ ...t, failures, enabled: failures >= task.failureLimit ? false : t.enabled, lastRun: { id: result.id, status: result.status, at: result.createdAt } }:t))
        }
        active = null; repo.compact(); notify()
        /* 每次跑完都发一条：渲染层判断「这条会话当前没打开」才亮通知点（2026-10-17 用户要求）。
           带 runId / sessionId，气泡列表点条目就能直接打开那次运行的会话。 */
        const needsAttention = ['failed','needs_attention','interrupted','timed_out','exhausted'].includes(result.status)
        emit({ type: 'tasks:notification', taskId: run.taskId, runId: result.id, sessionId: run.sessionId,
          title: run.task.name, status: result.status,
          message: needsAttention ? '定时任务需要关注，请查看运行记录。' : '定时任务已执行完成。' })
        if (!closed) scheduleTick()
      }
    }
    function launch(run) {
      const job = execute(run)
      jobs.add(job); job.then(()=>jobs.delete(job),error=>{jobs.delete(job);fault=error.message;emit({type:'tasks:error',message:error.message})})
    }
    async function tick() {
      requireRepo()
      if (fault) return
      for (const task of repo.tasks.slice()) {
        const trigger = policy.due(task, now()); if (!trigger) continue
        const overlap = Array.from(repo.runs.values()).some(r=>r.taskId===task.id&&['running','pending'].includes(r.status))
        // Persist the occurrence first. A crash before schedule advancement is deduplicated by id.
        createRun(task, trigger, trigger === 'catchup' ? policy.latest(task.rule,task.nextAt,now()) : task.nextAt, overlap || trigger === 'skipped' ? 'skipped' : 'pending', overlap ? '上次任务尚未结束，本次跳过' : trigger === 'skipped' ? '错过执行窗口，未补跑' : '')
        tasksSave(repo.tasks.map(t=>t.id===task.id?{ ...t, nextAt: policy.advance(t.rule,t.nextAt,now()) }:t))
      }
      for (const run of repo.runs.values()) if (run.status === 'pending') {
        if (now() - run.createdAt > 86400000) { repo.transition(run.id,{status:'cancelled',endedAt:now(),summary:'排队超过24小时，未自动执行'}); continue }
        if (!repo.tasks.some(t=>t.id===run.taskId)) { repo.transition(run.id,{status:'cancelled',endedAt:now(),summary:'任务已删除'}); continue }
        launch(run); if (active || closed) break
      }
    }
    function scheduleTick() { pending=pending.then(tick).catch(error=>{fault=error.message;emit({type:'tasks:error',message:error.message})});return pending }
    const service = {
      attach(options) {
        if (closed || repo) throw new Error('TASKS_ALREADY_ATTACHED_OR_CLOSED')
        pool=options.pool;emit=options.emit||emit;clock=options.clock||clock
        repo=new TaskRepository(options.home)
        try { repo.open(); for(const task of repo.tasks){contract.definition(task);if(typeof task.id!=='string'||!task.id||!Number.isFinite(task.nextAt)||!Number.isInteger(task.revision)||typeof task.workspaceRoot!=='string')throw new Error('TASK_STORE_INVALID')} } catch(e) { if(repo)repo.close();repo=null; throw e }
        const queueTick = scheduleTick
        if (options.timer !== false) { timer=setInterval(queueTick,30000); if(timer.unref)timer.unref(); queueTick() }
        return service
      },
      list() { requireRepo(); return { version:1, error:fault || repo.failed || '', tasks:repo.tasks, runs:Array.from(repo.runs.values()).sort((a,b)=>b.createdAt-a.createdAt), host:os.hostname(), running:active&&active.id, tools:contract.TOOLS.filter(name=>ctx.tools.get(name)) } },
      preview(rule) { return policy.next(contract.definition({name:'preview',prompt:'preview',rule}).rule,now()) },
      save(raw) {
        requireRepo(); const input=contract.definition(raw), old=repo.tasks.find(t=>t.id===raw.id)
        if (raw.id && !old) throw new Error('TASK_NOT_FOUND')
        if (!old && repo.tasks.length >= 100) throw new Error('TASK_LIMIT_100')
        const task={ ...input, id:old?old.id:crypto.randomUUID(), revision:old?old.revision+1:1, workspaceRoot:workspace(input.projectId), failures:0, nextAt:policy.next(input.rule,now()), updatedAt:now(), lastRun:old&&old.lastRun||null }
        tasksSave(old?repo.tasks.map(t=>t.id===task.id?task:t):repo.tasks.concat(task));return task
      },
      remove(id) { requireRepo(); if(active&&active.taskId===id)throw new Error('TASK_RUNNING_STOP_FIRST'); tasksSave(repo.tasks.filter(t=>t.id!==id)); for(const r of repo.runs.values())if(r.taskId===id&&r.status==='pending')repo.transition(r.id,{status:'cancelled',endedAt:now(),summary:'任务已删除'});notify() },
      run(id) { requireRepo(); if(fault)throw new Error('TASK_STORAGE_FAULT: '+fault);const task=repo.tasks.find(t=>t.id===id);if(!task)throw new Error('TASK_NOT_FOUND'); if(Array.from(repo.runs.values()).some(r=>r.taskId===id&&['running','pending'].includes(r.status)))throw new Error('TASK_ALREADY_RUNNING');const run=createRun(task,'manual',now(),'pending');notify();launch(run);return run },
      stop(id) { requireRepo();if(active&&(!id||active.taskId===id))pool.abort(active.sessionId);for(const r of repo.runs.values())if(r.status==='pending'&&(!id||r.taskId===id))repo.transition(r.id,{status:'cancelled',endedAt:now(),summary:'用户停止'});notify() },
      conversation(runId) { requireRepo();const r=repo.runs.get(runId);if(!r||!r.sessionId)throw new Error('TASK_RUN_NOT_FOUND');if(pool.isRunning(r.sessionId)){const worker=pool.acquire(r.sessionId);return {run:r,session:{messages:worker.messages,memory:worker.memory,execution:worker.state.execution}}}const file=path.join(pool.sessionDir(r.sessionId),'last-session.json');return {run:r,session:fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{messages:[]}} },
      tick, async close() { if(closed)return;closed=true;if(timer)clearInterval(timer);if(active)pool.abort(active.sessionId);await pending;await Promise.allSettled(Array.from(jobs));if(repo)repo.close() }
    }
    ctx.contracts.assertService('tasks',service)
    ctx.provide('tasks',service)
    ctx.effect(()=>()=>service.close())
  }
}
