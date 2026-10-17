'use strict'

// Application composition only. Cordis owns plugin activation and lifecycle.
const { foundation } = require('./plugins/foundation')
function defaultProfile(options) {
  return [
    ...foundation(options),
    require('./plugins/model'),
    require('./plugins/sessions'),
    require('./plugins/memory'),
    require('./plugins/agent-loop'),
    require('./plugins/agents')
  ]
}
module.exports = { defaultProfile }
