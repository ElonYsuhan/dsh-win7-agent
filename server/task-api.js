'use strict'
async function handleTaskApi(request, response, url, options) {
  if (!url.pathname.startsWith('/api/tasks')) return false
  const { tasks, json, readBody } = options
  try {
    const route = url.pathname.slice('/api/tasks'.length)
    if (route === '' && request.method === 'GET') json(response,200,tasks.list())
    else if (route === '' && request.method === 'POST') json(response,200,{task:tasks.save(await readBody(request))})
    else if (['/saveWorkflow','/removeWorkflow'].includes(route) && request.method === 'POST') json(response,200,tasks[route.slice(1)](await readBody(request)))
    else if (route === '/preview' && request.method === 'POST') json(response,200,{nextAt:tasks.preview((await readBody(request)).rule)})
    else if (route === '/delete' && request.method === 'POST') {tasks.remove((await readBody(request)).id);json(response,200,{ok:true})}
    else if (route === '/run' && request.method === 'POST') json(response,202,{run:tasks.run((await readBody(request)).id)})
    else if (route === '/stop' && request.method === 'POST') {tasks.stop((await readBody(request)).id);json(response,200,{ok:true})}
    else if (route === '/conversation' && request.method === 'GET') json(response,200,tasks.conversation(url.searchParams.get('runId')))
    else json(response,404,{error:'TASK_ROUTE_NOT_FOUND'})
  } catch(error) { json(response,400,{error:error.message}) }
  return true
}
module.exports={handleTaskApi}
