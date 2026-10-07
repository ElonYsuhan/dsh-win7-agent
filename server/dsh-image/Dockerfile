FROM docker.m.daocloud.io/library/node:22-bookworm-slim

RUN npm install -g @deepseek-ai/dsh@0.1.5-rc.1

RUN mkdir -p /data
ENV DSH_HOME=/data
ENV DSH_PORT_FWD=3180
ENV DSH_PORT_FWD_TO=3080

COPY server/dsh-image/start-dsh.sh /usr/local/bin/dsh-start
COPY server/dsh-image/dsh-port-fwd.js /usr/local/bin/dsh-port-fwd.js
RUN chmod +x /usr/local/bin/dsh-start /usr/local/bin/dsh-port-fwd.js

EXPOSE 3080 3180
ENTRYPOINT ["/usr/local/bin/dsh-start"]
