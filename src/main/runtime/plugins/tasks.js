'use strict'
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto')
const contract = require('../../contracts/tasks'), policy = require('../../flow/task-policy')
const { TaskRepository } = require('../../tasks/repository')
module.exports = {
  name: 'core/tasks', inject: ['agentConfig', 'agents', 'tools', 'contracts', 'workflows', 'licensing'],
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
      return repo.append({ version: 1, sequence: 1, id, taskId: task.id, sessionId: status === 'skipped' || task.workflow ? '' : 'task_' + crypto.createHash('sha256').update(id).digest('hex').slice(0,32), task: JSON.parse(JSON.stringify(task)), trigger, scheduledAt, createdAt: now(), status, summary: summary || '' })
    }
    async function execute(run) {
      if (!ctx.licensing.status().allowed || active || closed || run.task.workflow&&!ctx.workflows.canStart()) return
      if (!run.task.workflow && pool.runningCount() >= Math.max(1, pool.maxConcurrentRuns - 1)) return
      active = run
      const monotonicStart = process.hrtime.bigint(), duration = () => Math.round(Number(process.hrtime.bigint() - monotonicStart)/1000000)
      try {
        repo.transition(run.id, { status: 'running', startedAt: now() }); notify()
        const task = run.task
        if(task.workflow){
          await Promise.resolve()
          if(closed||repo.runs.get(run.id).status!=='running'){if(repo.runs.get(run.id).status==='running')repo.transition(run.id,{status:'cancelled',endedAt:now(),summary:'已取消尚未触发的流程'});return}
          const result=ctx.workflows.runScheduled({workflowId:task.workflow.id,revision:task.workflow.revision,taskId:task.id,taskRunId:run.id})
          repo.transition(run.id,{status:'completed',endedAt:now(),durationMs:duration(),workflowRunId:result.id,summary:'已触发流程实例；节点进度和人工待办请在流程实例中查看。'});return
        }
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
          title: run.task.name, status: result.status, ...(result.workflowRunId?{workflowId:run.task.workflow.id,workflowRunId:result.workflowRunId}:{}),
          message: needsAttention ? '定时任务需要关注，请查看运行记录。' : run.task.workflow?(result.workflowRunId?'已触发流程，请查看实例进度。':'定时触发已取消。'):'定时任务已执行完成。' })
        if (!closed) scheduleTick()
      }
    }
    function launch(run) {
      const job = execute(run)
      jobs.add(job); job.then(()=>jobs.delete(job),error=>{jobs.delete(job);fault=error.message;emit({type:'tasks:error',message:error.message})})
    }
    const workflowBusy=task=>!!task.workflow&&ctx.workflows.hasActive({id:task.workflow.id})
    async function tick() {
      requireRepo()
      if (fault || !ctx.licensing.status().allowed) return
      for (const task of repo.tasks.slice()) {
        const trigger = policy.due(task, now()); if (!trigger) continue
        const overlap = workflowBusy(task)||Array.from(repo.runs.values()).some(r=>r.taskId===task.id&&['running','pending'].includes(r.status))
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
        requireRepo(); const input=contract.definition(raw), old=repo.tasks.find(t=>t.id===raw.id)||(!raw.id&&input.workflow?repo.tasks.find(t=>t.workflow&&t.workflow.id===input.workflow.id):undefined)
        if(old&&old.workflow&&raw.revision!==old.revision)throw Error('定时任务已被其他窗口修改，请重新打开流程属性')
        if(old&&old.workflow&&!input.workflow)throw Error('请从流程属性管理此定时任务')
        if(input.workflow){const workflow=ctx.workflows.list().workflows.find(w=>w.id===input.workflow.id);if(!workflow||workflow.revision!==input.workflow.revision)throw Error('流程已修改或删除，请重新打开流程属性');if(repo.tasks.some(t=>t!==old&&t.workflow&&t.workflow.id===input.workflow.id))throw Error('此流程已有定时任务')}
        if (raw.id && !old) throw new Error('TASK_NOT_FOUND')
        if (!old && repo.tasks.length >= 100) throw new Error('TASK_LIMIT_100')
        const task={ ...input, id:old?old.id:crypto.randomUUID(), revision:old?old.revision+1:1, workspaceRoot:input.workflow?'':workspace(input.projectId), failures:0, nextAt:old&&input.workflow&&old.enabled===input.enabled&&JSON.stringify(old.rule)===JSON.stringify(input.rule)?old.nextAt:policy.next(input.rule,now()), updatedAt:now(), lastRun:old&&old.lastRun||null }
        tasksSave(old?repo.tasks.map(t=>t.id===task.id?task:t):repo.tasks.concat(task));return task
      },
      saveWorkflow(raw){
        requireRepo();const schedule=raw.schedule||{},definition=raw.definition,existing=repo.tasks.find(t=>t.workflow&&t.workflow.id===definition.id)
        if(existing&&(schedule.taskId!==existing.id||schedule.taskRevision!==existing.revision)||!existing&&schedule.taskId)throw Error('定时任务已被其他窗口修改，请重新打开流程属性')
        const normalized=contract.definition({name:String(definition.name||'').slice(0,100),prompt:'流程触发',rule:(schedule.enabled===true?schedule.rule:existing&&existing.rule)||{kind:'daily',time:'09:00',timezone:'Asia/Shanghai'},enabled:schedule.enabled===true,catchUp:schedule.catchUp===true})
        if(normalized.enabled&&Array.isArray(definition.nodes)&&definition.nodes.some(n=>['agent','tool','rest'].includes(n.type))&&schedule.confirmed!==true)throw Error('请先确认定时流程的接口、工具与执行限额')
        if(normalized.enabled&&!existing&&repo.tasks.length>=100)throw Error('TASK_LIMIT_100')
        const workflow=ctx.workflows.save(definition)
        try{const task=existing||normalized.enabled?service.save({...normalized,id:existing&&existing.id,revision:existing&&existing.revision,name:workflow.name.slice(0,100),prompt:workflow.description||('执行流程：'+workflow.name),workflow:{id:workflow.id,revision:workflow.revision}}):null;return{workflow,task}}
        catch(error){return{workflow,task:null,syncError:error.message}}
      },
      removeWorkflow(raw){requireRepo();const result=ctx.workflows.remove(raw);try{for(const t of repo.tasks.filter(t=>t.workflow&&t.workflow.id===raw.id))service.remove(t.id);return result}catch(error){return{...result,syncError:error.message}}},
      remove(id) { requireRepo(); if(active&&active.taskId===id)throw new Error('TASK_RUNNING_STOP_FIRST'); tasksSave(repo.tasks.filter(t=>t.id!==id)); for(const r of repo.runs.values())if(r.taskId===id&&r.status==='pending')repo.transition(r.id,{status:'cancelled',endedAt:now(),summary:'任务已删除'});notify() },
      run(id) { ctx.licensing.assert('chat'); requireRepo(); if(fault)throw new Error('TASK_STORAGE_FAULT: '+fault);const task=repo.tasks.find(t=>t.id===id);if(!task)throw new Error('TASK_NOT_FOUND'); if(workflowBusy(task)||Array.from(repo.runs.values()).some(r=>r.taskId===id&&['running','pending'].includes(r.status)))throw new Error('TASK_ALREADY_RUNNING');const run=createRun(task,'manual',now(),'pending');notify();launch(run);return run },
      stop(id) { requireRepo();const workflowRuns=Array.from(repo.runs.values()).some(run=>run.workflowRunId&&(!id||run.taskId===id))?new Map(ctx.workflows.list().runs.map(run=>[run.id,run])):new Map();for(const run of repo.runs.values())if(run.workflowRunId&&(!id||run.taskId===id)){const target=workflowRuns.get(run.workflowRunId);if(target&&['pending','running','waiting','paused'].includes(target.status))ctx.workflows.stop({id:target.id})}if(active&&(!id||active.taskId===id)){if(active.task.workflow){const current=repo.runs.get(active.id);if(current.status==='running')repo.transition(active.id,{status:'cancelled',endedAt:now(),summary:'用户取消尚未触发的流程'})}else pool.abort(active.sessionId)}for(const r of repo.runs.values())if(r.status==='pending'&&(!id||r.taskId===id))repo.transition(r.id,{status:'cancelled',endedAt:now(),summary:'用户停止'});notify() },
      conversation(runId) { requireRepo();const r=repo.runs.get(runId);if(!r||!r.sessionId)throw new Error('TASK_RUN_NOT_FOUND');if(pool.isRunning(r.sessionId)){const worker=pool.acquire(r.sessionId);return {run:r,session:{messages:worker.messages,memory:worker.memory,execution:worker.state.execution}}}const file=path.join(pool.sessionDir(r.sessionId),'last-session.json');return {run:r,session:fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{messages:[]}} },
      tick, async close() { if(closed)return;closed=true;if(timer)clearInterval(timer);if(active&&!active.task.workflow)pool.abort(active.sessionId);await pending;await Promise.allSettled(Array.from(jobs));if(repo)repo.close() }
    }
    ctx.contracts.assertService('tasks',service)
    ctx.provide('tasks',service)
    ctx.effect(()=>()=>service.close())
  }
}
