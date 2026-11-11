'use strict'

// Development only. Set environment variables outside source control.
const { startHesynBridge } = require('../src/main/host-connector/hesyn-local')

startHesynBridge({
  serviceOrigin: process.env.HESYN_SERVICE_ORIGIN || 'http://127.0.0.1:18090',
  origin: process.env.HESYN_ORIGIN || 'http://127.0.0.1:5180',
  hostId: process.env.HESYN_HOST_ID,
  hostToken: process.env.HESYN_HOST_TOKEN,
  userToken: process.env.HESYN_USER_TOKEN,
  home: process.env.HESYN_HOST_HOME,
  port: 18100
}).then(bridge => {
  console.log('HESYN local bridge listening on 127.0.0.1:18100')
  const stop = () => bridge.close().then(() => process.exit(0), () => process.exit(1))
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}).catch(error => { console.error('HESYN bridge failed:', error.message); process.exitCode = 1 })
