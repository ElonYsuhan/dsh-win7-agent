'use strict'

// Application composition only. Cordis owns plugin activation and lifecycle.
const { foundation } = require('./plugins/foundation')
function defaultProfile(options) {
  return [
    ...foundation(options),
    require('./plugins/skill-library'),
    require('./plugins/model'),
    require('./plugins/plans'),
    require('./plugins/mcp'),
    require('./plugins/extensions'),
    require('./plugins/knowledge'),
    require('./plugins/knowledge-tools'),
    require('./plugins/sessions'),
    require('./plugins/memory'),
    require('./plugins/agent-loop'),
    require('./plugins/agents'),
    require('./plugins/tasks'),
    require('./plugins/workflow-agent'),
    require('./plugins/workflow-nodes'),
    require('./plugins/workflows'),
    require('./plugins/workflow-tools')
  ]
}
module.exports = { defaultProfile }
