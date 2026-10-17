FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV AGENT_HOME=/data
ENV HOST=0.0.0.0
ENV PORT=8080

COPY package.json ./package.json
COPY src/main ./src/main
COPY src/renderer ./src/renderer
COPY server ./server

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
