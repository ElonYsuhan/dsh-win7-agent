# DSH Offline Agent Service

A small HTTP/SSE agent service for an offline intranet.

It does not include a model service. Configure any OpenAI-compatible endpoint
through environment variables or through the web Settings page.

## Endpoints

- `GET /` Web UI
- `GET /api/health`
- `GET /api/state`
- `POST /api/settings`
- `POST /api/workspace`
- `POST /api/chat`
- `POST /api/stop`
- `POST /api/clear`
- `POST /api/approve`
- `GET /api/events` SSE stream

## Environment

- `AGENT_HOME` default `/data`
- `HOST` default `0.0.0.0`
- `PORT` default `8080`
- `MODEL_BASE_URL` default `http://127.0.0.1:11434/v1`
- `MODEL_API_KEY` default `ollama`
- `MODEL_NAME` default `qwen3.5:4b`
- `WORKSPACE_PATH` default `$AGENT_HOME/workspace`

## Build offline image

On an internet-connected x64 machine:

```bash
docker buildx build --platform linux/amd64 -t dsh-agent-service:0.1.0 -f server/Dockerfile .
docker save dsh-agent-service:0.1.0 -o dsh-agent-service-0.1.0-linux-amd64.tar
```

Copy the tar file and `server/docker-compose.yml` to the intranet.

On the offline server:

```bash
docker load -i dsh-agent-service-0.1.0-linux-amd64.tar
docker compose -f server/docker-compose.yml up -d
```

Then open:

```text
http://SERVER_IP:8080
```

Set the model Base URL in the web Settings page.

## Run without Docker

Node.js 22 is required.

```bash
AGENT_HOME=./data PORT=8080 HOST=0.0.0.0 node server/index.js
```
