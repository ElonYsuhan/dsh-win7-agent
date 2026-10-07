#!/bin/bash
cd /Users/ysuhan/Elon/Project/work/dsh-win7-agent
export AGENT_HOME=/tmp/dsh-agent-demo
export HOST=127.0.0.1
export PORT=8080
echo Starting DSH Win7 Agent service
echo URL http://127.0.0.1:8080
echo Keep this window open while the service is running
/Users/ysuhan/.nvm/versions/node/v24.15.0/bin/node server/index.js
