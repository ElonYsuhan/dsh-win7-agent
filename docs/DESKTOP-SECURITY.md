# 桌面三层防护与验收边界

## 当前实现

1. 界面：Electron 22.3.27 的 sandbox、contextIsolation、nodeIntegration=false、webSecurity；拒绝 webview 与设备权限。应用 CSP 禁止远程脚本、eval、修改 base 和表单跳转。文档预览仍保留原有受限 iframe/blob 能力，不放开 Node。
2. 通信：共享 ipc-security 适配器核对确切窗口、主框架与允许的本地页面/服务 origin。设置写入只接受独立设置页；菜单、主题和终端订阅也校验来源。服务 API 拒绝跨站 Origin/Sec-Fetch-Site，本地监听模式拒绝非本地主机 Host，页面响应禁止被嵌入并设置 nosniff。原有业务 Schema、工具权限、审批和 Cordis 授权边界继续执行。此检查不替代远程部署的用户认证、TLS 或网络隔离；允许的同源脚本若遭 XSS，仍需靠业务权限限制影响。
3. 主进程与发布代码：默认构建仍执行 agent-source-v1 的 AES-256-GCM、压缩和轻量混淆；新增独立 Ed25519 发布代码签名。code-integrity.json 覆盖包内 JS、加密载荷、HTML、CSS、package.json 与保护报告。加载器内置公钥，启动仅验小清单及入口文件，CommonJS/载荷按加载验证，服务在发送页面资源前验证实际响应字节，本地页面和 preload 在 file 请求时校验。校验失败拒绝相关加载，不删除用户数据、不扫描或结束其他应用。已加载模块沿用 CommonJS 缓存，不进行持续的全盘扫描。

签名清单限定发布代码，不能当作可信在线更新清单；desktop-build、distribution、授权状态、客户扩展和工作区不属于本清单。用户扩展仍是受信任进程内插件，遵循 Cordis 生命周期，不能把宿主检查当作恶意插件沙箱。没有新增业务状态、容器、后台定时扫描或生产依赖。

## 发布签名密钥

构建机先执行 `node scripts/desktop/release-signing.js init`，在 `~/.agent-release-authority/` 创建 `private.pem` 与 `public.pem`。已有公钥却缺失私钥时拒绝重新生成。构建缺少私钥时失败，校验缺少可信公钥时失败。私钥只用于构建签署，不复制到客户端、签发工具或仓库。换构建机需安全迁移发布私钥及公钥；客户机无需取得它们。

这对密钥与 `~/.agent-license-authority/` 的客户授权密钥完全独立。授权设备摘要、申请协议、已有许可证与10分钟试用行为保持兼容。

## 申请标识与签发工具

显示设备摘要前9个十六进制字符的大写分组，例如 `ABC-DEF-123`；客户端移除复制设备码按钮，只显示申请标识。申请与授权默认文件名分别为 `Agent-ABC-DEF-123.agentreq` 与 `Agent-ABC-DEF-123.agentlic`。申请仍保存完整摘要，签发与激活只依据完整摘要。短标识可能碰撞，文件名不是安全凭据；同名申请应分别存放，管理员核对完整申请和客户信息。相同系统标识的克隆机器仍可能共享摘要。

签发工具沿用产品图标并增加工具徽标，图标可由构建机的 `python3 scripts/make-authority-logo.py` 重建（Pillow 仅用于制作资源，不随目标机运行）。签发工具本身也执行沙箱、源码保护与发布代码签名；2026-10-28起桌面与浏览器统一使用带登录、会话及CSRF校验的HTTP签发服务，不再暴露签发IPC。签发私钥仍只从管理员电脑的外部目录读取。

## 明确限制

此机制提高篡改与提取成本，不承诺不可反编译。掌握客户机管理员权限的人仍可能修改 Electron、加载器或其中的信任公钥。签名检查的信任根需要操作系统层的正式代码签名配合；Mac ad-hoc 签名不是 Apple Developer ID 或公证，Windows 未配置 Authenticode 发布证书。没有把自有 Ed25519 清单称为系统认可的发布者证书。

运行时固定 Electron22 / Node16.17.1 / Chromium108；不启用未经该版本验证的 Fuse，也不升级运行时。模块/传输适配可独立替换，契约、纯策略与 reducer 不依赖此层。Node16检查、构建校验和本机Mac回归不等同于Win7真机验收。

## 验证入口

- `npm run check`、`npm run check:node16`：包括 IPC 正反例、权限拒绝、监听器回收、签名/公钥/文件篡改拒绝、GCM路径绑定与旧授权回归。
- `node scripts/protected-runtime-smoke.js <Agent.app>`：受保护真实 Cordis、工作流与节点设计运行。
- `node scripts/licensing-e2e-smoke.js <Agent.app>`：真实包的短标识、申请导出命名、无复制按钮、授权/试用/重启及跨站请求拒绝。
- `node scripts/license-authority-ui-smoke.js <签发工具.app>`：签发工具隔离密钥、简洁标识、有效来源IPC与错误申请拒绝。
- `node scripts/source-protection-perf.js <Agent.app>`：隔离进程比较未保护基线与最终保护包，记录启动和反复模块切换资源，不能冒充全平台性能验收。
