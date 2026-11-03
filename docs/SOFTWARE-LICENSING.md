# 软件授权（离线设备绑定首版）

2026-10-24：按用户要求启用发布包强制授权、不可关闭的授权蒙版和一次试用。
2026-11-02：试用时长按用户要求由 10 分钟改为 **1 天**（`TRIAL_MS=86400000`，仍是唯一真源）。
软件使用授权与节点运行权限相互独立。源码开发模式不启用授权；默认平台交付构建必须
从签发目录读取公钥，缺少公钥时构建失败，不允许静默发布未授权模式。

## 使用与签发

1. 客户打开程序，在授权蒙版的“本机设备与授权申请”导出 `.agentreq`。
2. 管理员打开独立的“Agent 授权签发工具”，导入申请，填写客户与有效天数，生成
   `.agentlic`。此工具也支持粘贴完整申请内容。
3. 客户拖拽或点击上传授权文件。签名、产品、设备、有效期全部验证后原子保存；
   错误导入不会覆盖已有有效授权。设置 → 软件授权显示当前客户、有效期和设备码，
   可再次上传续期文件。

签发方只有一对 Ed25519 密钥，每份许可证绑定不同设备。私钥默认位于
`~/.agent-license-authority/private.pem`，公钥清单位于同目录 `public-keys.json`，
签发台账为 `issuance.jsonl`。私钥不进入仓库、构建缓存、客户端或签发工具包；
应将整个目录离线备份并限制访问。丢失私钥不能通过重新生成让旧客户端信任新签发方。
签发工具在新电脑初始化的是新身份，须同步重新构建客户端公钥策略或恢复旧密钥备份。

可复现命令：

```
node scripts/license-authority.js init --dir /独立目录
node scripts/license-authority.js issue --request /设备.agentreq --customer 客户 --days 365 --out /授权.agentlic --dir /独立目录
node scripts/build-license-authority.js
node scripts/build-desktop.js mac-arm64 --stage-only
```

签发工具目前交付本机 macOS 架构的独立 `.app`；客户运行程序仍沿用五平台交付契约。
日常包不升级产品或 Electron 版本。签发工具和客户程序无需联网授权。

## 协议与边界

外层严格字段为 `version/keyId/payload/signature`，版本1，签名使用 Ed25519。
`payload` 为规范化（对象字段按字典序）的 UTF-8 JSON 字节再 Base64 编码；签名
覆盖该原始字节。内部字段为 `version/product/licenseId/customer/deviceDigest/issuedAt/
notBefore/expiresAt/sequence/features`。拒绝未知字段、重复字段、非法类型、超长字段、
未知 keyId、非规范化编码和超过64KB文件。只接收签发工具输出的紧凑外层 JSON。
同一 licenseId 记录已见最大 sequence，拒绝序号下降；签发GUI当前为每次签发分配新ID。
CLI可用 `--id`、`--sequence` 管理同一许可证修订。首版签发工具仅签发全部功能范围，
不提供版本、维护截止日或功能套餐管理，也不把产品版本当成授权序号。

申请只携带设备摘要、平台/架构和主机名，不含原始硬件ID或用户业务数据。
Mac 使用 IOPlatformUUID，Windows 使用注册表 MachineGuid（Win7 自带 reg.exe），
Linux 使用 machine-id。摘要带产品与绑定版本命名空间。它代表当前系统/设备身份，
不是不可伪造的硬件证明；重装系统、克隆虚拟机或管理员修改标识可能影响绑定。
硬件读取失败时明确报错，不退回可复制的随机安装ID来放行。

`contracts/licensing` 定义纯格式；`flow/license-policy` 计算状态；原生 Cordis
`licensing` 服务持有设备适配、验签、时间与文件存储。实际状态保存在 AGENT_HOME 的
`licensing/state.json`，以临时文件、fsync、原子替换和跨进程互斥保存事实。
HTTP/IPC写入口、模型、工具（含长时间权限确认后的复查）、任务派发及流程节点边界
均检查该服务。到期不删除用户数据；正在发生的外部副作用不强行重放或回滚，后续节点
在既有状态迁移中暂停，模型/工具调用拒绝继续。停止、退出与授权入口保留可用。

无授权、到期、设备或存储故障时，最高层蒙版禁止关闭，背景 inert，限制焦点和 Esc；
仍可使用系统退出。强制蒙版是本次用户明确要求，优先于一般弹窗 Esc 关闭规则。
试用由后端记录首次启用时间，1 天后前端锁定且后端拒绝执行；正常退出、重启和更新
不重置试用。进程单调时钟与持久化已见时间用于识别明显回拨，客户端不依赖 localStorage
决定授权。异常读写失败保持受限状态。

## 授权门界面规则（2026-11-02）

用户对照实际截图提的六条，全部落在 `src/renderer/licensing.{js,css}`：

1. **按钮全部收到底部一行**：`导出申请文件` 从「本机设备与授权申请」区块里搬出来，和
   `重新检查`、`试用`、新增的 `取消` 一起放进 `.license-actions`。顺序按统一弹窗规范：
   取消在左，主操作（试用）在右并用反色底。
2. **取消 = 关闭软件**：新增 `app:quit` 通道（`licensedHandle` + `publicChannels`，未授权态必须
   可用），preload 暴露 `dsh.quitApp()`，浏览器桥同名空实现。走 `app.quit()` 而不是
   `process.exit`，这样 `before-quit` 的 tasks/pool/pluginHost 清理照常执行。
3. **按钮要与卡片底色区分**：卡片是 `--panel`(#2b2b2b)，按钮提到 `--btn #3f3f3f` + `#636363` 描边
   （浅色 `#efefef`/`#c9c9c9`）；主操作用 `--send-bg`/`--send-text` 反色。
4. **整页观感：遮罩完全不透明**（2026-11-02 二次调整）：`#licenseGate` 把 `--dialog-overlay` 直接取
   `var(--bg)`，同时去掉 `backdrop-filter` 模糊 —— 用户反馈「测试的时候整个页面就不要了吧，浮层」，
   半透明 + 模糊仍能看出下层界面轮廓。现在启动门就是一片纯背景 + 居中卡片，主界面一个像素都看不到。
   没有采用「锁定期间 `#app{visibility:hidden}`」：一批真窗口 smoke（theme / typography / drag …）
   跑在未授权态，`visibility` 一变 hidden，它们的 visible 断言会集体误红；遮罩不透明之后下层本来
   也看不见，没必要动 DOM。注意 style.css 末尾统一收口是 `.modal:not(#approvalModal)`（特异性 1,1,0），
   单写 `.license-gate` 会被压住，所以覆盖变量。
5. **本机设备与授权申请不折叠**：`<details>/<summary>` 换成常驻 `section`，标题、说明、
   申请标识三行全部显示。
6. **试用用过之后不再显示**：`trialAvailable:false` 时顶部提示 `#licenseGateDescription`、
   试用按钮、试用说明一起置 `hidden`（按钮不再以「试用已使用」的禁用态留着）。
   倒计时按 1 天格式化（≥1 小时显示 `HH:MM:SS`）。

7. **拖拽上传区的图标走图标库**：原来是文字字符 `↑`，字形跟字体走、粗细大小不可控。现在用
   `data-icon="upload"` + `window.applyIcons()`（宿主页不引 `icons.js` 就只剩空 span，验收里也钉了）。
   注意 `applyIcons` 只在**子节点**里找 `[data-icon]`，所以标记要挂在里层 span 上。
   尺寸规则要用 `.license-drop .license-upload-icon svg`（0,2,1）—— `style.css` 那条全局
   `button .icon svg`（0,1,2）会把图标压回 20px，而 `.license-drop` 本身就是 `<button>`。

布局上还有一条：申请区常开后卡片会变高，所以卡片改成「内容区滚动 + 按钮行常驻」
（`#licenseGate .license-gate-card` 外层 `overflow:hidden`，`.license-body` 内层滚动），
小窗口下 `取消` 不会被挤出可视区。

验收：`check:licensing:gate`（真 Electron 窗口，27 条：按钮收口与顺序、按钮行完整可见、
内容区滚动、申请区展开、遮罩不透明与满屏、上传图标是 28px 的 SVG、深浅两套主题下的底色对比、
试用用过后的三处隐藏、`quitApp` 调用）+ `licensing-smoke`（1 天边界，假时钟）+
`licensing-e2e-smoke`（打包态，mac，文本与到期夹具已同步）。
截图：`release/validation/license-gate-trial.png`、`license-gate-trial-used.png`。

## 迁移、保护与限制

人工迁移：客户从新设备重新导出申请，管理员确认旧授权作废，在人工台账补充旧新
设备、原因和经办后签发新设备文件。迁移业务数据不等于迁移授权。完全离线的旧设备
无法即时接收撤销，因此不能承诺“一迁移旧设备立即失效”。首版没有联网激活或远程撤销。

本地管理员删除/恢复整个状态目录、回滚磁盘快照、修改系统身份或篡改客户端，都不能
靠纯离线软件完全防止。一次试用约束针对正常使用与重启，不宣称不可重置的硬件级DRM。
发布包策略模块与自研代码一起加密混淆，但内置密钥可被运行时分析，不承诺绝对防破解。
后续可替换设备适配、增加在线租约和受信任时间；纯协议与 Cordis 上层业务边界不变。

## 验证

`licensing-smoke.js` 在构建机和内嵌 Node16 验证签名、设备、有效期、错误导入保留、
序号下降、试用准确边界及重启、回拨、状态损坏、构建仅复制公钥与真实 Cordis 模型/工具
拒绝执行。`licensing-e2e-smoke.js` 隔离运行实际受保护 Mac 包，验证蒙版、焦点、Esc、
错误拖拽、点击上传、设置页、试用重启、到期重新锁定及 HTTP 拒绝；试用到期的UI场景
使用隔离状态中过去的试用事实，不等待真实 1 天，准确 86400000ms 由核心假时钟验证。
深浅主题截图与报告在 `release/validation/`。这些不是 Win7 真机、Windows 或Linux的
硬件采集实测；跨平台实际行为仍需对应目标机验收。

## 简洁申请标识（2026-10-28）

界面只显示设备摘要前9位的大写分组 `XXX-XXX-XXX`，移除复制设备码按钮。申请和授权默认文件名均使用 `Agent-XXX-XXX-XXX`，分别以 `.agentreq` / `.agentlic` 结尾。申请文件内仍保留完整设备摘要，旧申请/旧授权兼容。短标识可能重复，仅用于人工对照；签发必须导入完整申请文件，不接受短码替代摘要。发布代码签名使用另一对独立密钥，参见 DESKTOP-SECURITY.md。

## 浏览器与桌面统一登录签发（2026-10-28）

在签发电脑打开“Agent 授权签发工具”，服务默认从 TCP 8787 起尝试最多10个端口；占用时顺延，绝不接入未知旧服务。桌面工具显示管理员登录页，内网浏览器通过登录后的页面所示 IP 地址访问同一个服务。关闭工具即停止服务。默认只有内置账号 `admin` / `admin123`，按用户内网要求固定，不提供注册。凭据哈希留在服务端；浏览器脚本不包含密码或私钥，也没有绕过登录的签发 IPC。

成功登录创建随机 HttpOnly/SameSite=Strict 会话 Cookie，与页面会话的 CSRF token 分离。10分钟无操作或最长8小时后失效；浏览器轮询不会续期，操作才续期。退出/服务重启会撤销会话；每次初始化和签发都在服务端再次检查会话。最多8个有效会话、2个并行口令计算；单来源15分钟内连续5次错误暂时限制登录。界面在失效时锁定并清除当前申请内容。

申请文件从浏览器提交，签名始终调用签发电脑现有 issuer 和 `~/.agent-license-authority/private.pem`，授权文件由浏览器下载；审计仍记录在签发电脑的 issuance.jsonl。迁移浏览器不迁移签发身份，已有公私钥不更换，旧客户端继续验证原签名。服务端不提供读取私钥/任意文件或注册接口。

适配器使用Node16内置HTTP/crypto/fs，无生产依赖；不介入客户Agent的Cordis业务状态。仅允许回环、私有/链路本地网络来源并核对Host与Origin，拒绝跨站调用；默认HTTP面向可信内网，不提供传输加密，不能将其作为公网服务。真实内网可达性仍取决于电脑网络和防火墙，自动化验证不冒充另一台物理电脑验收。

`node scripts/license-authority-web-smoke.js` 验证真实HTTP登录、无注册、鉴权签发、私钥保留、会话轮换/退出/空闲/绝对时限/重启失效、限流、CSRF/Host/Origin及上传边界；纳入check与Node16检查。`license-authority-ui-smoke.js` 在隔离真实保护包中验证登录、短标识、签发下载及深浅主题。

签发身份面板将实际内网地址逐条显示为可点击链接，旁边提供“复制地址”；使用实际监听端口，不固定写死8787。复制结果通过状态区提示，兼容HTTP内网浏览器。
