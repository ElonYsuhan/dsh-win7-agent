#!/usr/bin/env bash
# ============================================================
# ai-agent-start — 容器启动脚本, 同时拉起三个进程:
#   2) dsh web         (后台) — DeepSeek Harness Agent UI, 127.0.0.1:3080
#   3) dsh-port-fwd.js (前台) — TCP 转发 0.0.0.0:3180 → 127.0.0.1:3080
# 为什么有 3): dsh 出于安全硬性拒绝 --host 0.0.0.0 (远程代码执行暴露风险),
#   只绑容器 loopback, 端口发布后宿主机无法直达 → 转发器打通。
# 容器生命周期跟随转发器; 它监视 dsh, dsh 一死转发器即退出 → 容器重启兜底。
# ============================================================
set -e


# DSH_TRUSTED_HOSTS (可选): 空格分隔的 host[:port] 列表, 透传 dsh --trusted-host,
# 用于内网多人直连场景放行 /api browser-trust 围栏 (见 docker-compose.yml / .env.example)
DSH_ARGS=(web --no-open)
for h in ${DSH_TRUSTED_HOSTS:-}; do
  DSH_ARGS+=(--trusted-host "$h")
done

dsh "${DSH_ARGS[@]}" &
DSH_PID=$!
echo "[ai-agent] dsh web started (pid=$DSH_PID)"

export DSH_PID
exec node /usr/local/bin/dsh-port-fwd.js
