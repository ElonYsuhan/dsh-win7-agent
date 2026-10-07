#!/usr/bin/env node
// ============================================================
// dsh-port-fwd — TCP 转发: 0.0.0.0:3180 → 127.0.0.1:3080
// dsh web 出于安全只允许绑 127.0.0.1 (硬性拒绝 --host 0.0.0.0),
// 容器端口发布到 eth0 后无法直达 loopback, 故用此转发器打通;
// 纯 net 模块, http/WebSocket 通用, 无需额外依赖。
// 对外暴露面仍由 compose 限制 (宿主机 loopback) + dsh token 鉴权。
// ============================================================
const net = require("net");

const TARGET = {
  host: "127.0.0.1",
  port: Number(process.env.DSH_PORT_FWD_TO || 3080),
};
const LISTEN_PORT = Number(process.env.DSH_PORT_FWD || 3180);
const WATCH_PID = Number(process.env.DSH_PID || 0);

// 等 dsh 监听就绪再开听 (最多 ~30s), 避免启动窗口期连接被拒
function waitTarget(cb, tries) {
  const s = net.connect(TARGET);
  s.once("connect", () => { s.destroy(); cb(); });
  s.once("error", () => {
    if (tries <= 0) {
      console.error("[dsh-port-fwd] target never came up, exiting");
      process.exit(1);
    }
    setTimeout(() => waitTarget(cb, tries - 1), 500);
  });
}

waitTarget(() => {
  net.createServer((client) => {
    const upstream = net.connect(TARGET);
    client.pipe(upstream).pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  }).listen(LISTEN_PORT, "0.0.0.0", () => {
    console.log(
      `[dsh-port-fwd] listening 0.0.0.0:${LISTEN_PORT} -> ${TARGET.host}:${TARGET.port}`,
    );
  });

  // dsh 退出时转发器跟着退出 → 容器退出 → restart 策略拉起整套
  if (WATCH_PID) {
    setInterval(() => {
      try { process.kill(WATCH_PID, 0); } catch {
        console.log("[dsh-port-fwd] dsh exited, quitting");
        process.exit(0);
      }
    }, 2000);
  }
});
