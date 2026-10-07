# Page 编辑流程

本文档描述已托管 Page 的编辑流程。该流程面向已经导入 / 发布在 WorkBuddy Page 平台上的页面，通过 Page Agent 事务协议拉取产物、修改下载的文件、只上传改动文件并提交新版本。

> 本流程同时执行 `../mutation.md`。

## 1. 触发条件

用户要求修改一个已经托管在 Page 平台上的页面，并给出以下任一信息时，走本流程：

- `nodeId`
- `/space/d/<nodeId>` 链接
- 上游模块已经解析出的 Page 节点 ID
- 上游 `node-info` 返回 `kind=web` 或 `kind=page`
- 用户要求"根据评论修改页面 / 处理页面评论"，并给出 Page `nodeId`，可选 `discussionId`

### 1.1 落点路由

| 用户意图 | 走哪条路 |
| --- | --- |
| page 链接 + 改页面内容 / 读取内容 / 定位文本 / 修改文案 | 本流程：拉取产物 → 本地修改 → 增量提交 |
| database 链接 + 改数据 | 改 database（record/field），关联 page 下次加载即反映 |
| 根据评论修改 / 处理评论 | 先用 `manage/get_node_comments.py` 拉取评论，再走本流程编辑 HTML |

## 2. 协议架构映射

| 方案设计点 | skill 体现 |
| --- | --- |
| 控制流走业务后台 | `list_page_artifacts.py` / `create_page_transaction.py` / `get_page_upload_url.py` / `commit_page_transaction.py` 分别对应 4 个后端接口 |
| 数据流直连 COS/CDN | Agent 从 `data.url + path` 拉产物；拿 `uploadUrl` 后直接 PUT |
| Lazy-Copy | Agent 只上传修改过的文件；未修改文件由后端 `commit` 按 `baseVersion` 补齐 |
| 无协议级 `confirm` 步骤 | 协议流程为 `create → list → upload → commit`；用户交互层面的发布态确认见 §5.1 |

## 3. 调用形态

> 运行模式：沙箱模式直接调用下列脚本，删掉 token 管道与 `--token-stdin`；客户端模式才先按 `manage/entry.md` 获取 `<token>`，并使用下面的 token 管道写法。

```bash
# 1. 开启事务；stdout 直接输出服务端 JSON 信封，data 含 transactionId 和 baseVersion
python3 "${CODEBUDDY_PLUGIN_ROOT}/skills/library/page/create_page_transaction.py" --token-stdin --node-id "<page_node_id>"

# 2. 用事务返回的 baseVersion 查询产物列表，确保拉取的产物版本与事务基线一致
python3 "${CODEBUDDY_PLUGIN_ROOT}/skills/library/page/list_page_artifacts.py" --token-stdin --node-id "<page_node_id>" --version "<baseVersion>"

# 3. 按 list 响应中的 data.url + artifacts[].path 下载产物到本轮自建的临时目录（见 §5 阶段 2）
#    url 已包含版本目录；只下载 artifacts 中列出的可编辑文件

# 4a. 对每个被修改的文件，先获取事务工作区上传 URL
python3 "${CODEBUDDY_PLUGIN_ROOT}/skills/library/page/get_page_upload_url.py" --token-stdin --transaction-id "<tx_id>" --path "index.html"

# 4b. 用 HTTP PUT 将待上传文件内容发送到 data.uploadUrl
#    不要把 uploadUrl 回显给最终用户

# 5. 提交事务
#    优先带 --pnid；若按下方规则仍找不到，则省略 --pnid
python3 "${CODEBUDDY_PLUGIN_ROOT}/skills/library/page/commit_page_transaction.py" --token-stdin --transaction-id "<tx_id>" --pnid "<data_page_node_id>" --message "更新页面"
```

## 4. stdout 契约

后台接口脚本成功时直接输出服务端 JSON 信封，不额外包 `KS_*` 前缀。

| 命令 | 成功 stdout | 说明 |
| --- | --- | --- |
| `list_page_artifacts.py` | 服务端 JSON 信封 | `data` 含 `version`、`url`、`artifacts` |
| `create_page_transaction.py` | 服务端 JSON 信封 | `data` 含 `transactionId`、`baseVersion`；上层比较 `baseVersion` 与修改基线 |
| `get_page_upload_url.py` | 服务端 JSON 信封 | `data` 含 `uploadUrl`、`method` |
| `commit_page_transaction.py` | 服务端 JSON 信封 | 成功时 `data` 含 `newVersion`、`url` |
| `commit` 状态/版本冲突 | `error_handling.md` 错误码行动表中的冲突码 | 必须废弃该事务并从 §5 第 1 步重做 |

失败输出 stdout 单行 `{"error":"<脱敏错误>"}` 后 `exit 0`；后端 / HTTP 失败含安全 `code/msg`，下一步只按 `error_handling.md` 错误码行动表执行。

## 5. 标准编辑流程

| 阶段 | Agent 动作 | 决策 |
| --- | --- | --- |
| 1 | `create_page_transaction.py` 开启事务 | 记录返回的 `transactionId` 和 `baseVersion` |
| 2 | `list_page_artifacts.py --version <baseVersion>` 把产物拉到自建临时目录 `<tmp_dir>`，这份是**工作副本**，后续改动都落在它上面；再把它原样拷一份到 `<tmp_dir>/.baseline/` 作**基线副本**，拷完不再改动 | baseVersion 见 §7；基线副本是 §5.2 自查唯一依据。`<tmp_dir>` 由 Agent 自选、本轮内固定。运行环境已有临时目录约定时优先沿用 |
| 3 | 分析并修改工作副本 | 只改与用户需求相关的文件；保留未修改文件；按"HTML 元素定位与 pnid 记录规则"定位目标元素并记录本轮修改对应的 `pnid`，找不到则允许为空 |
| 3.5 | 按 `entry.md` §2「图片托管」执行图片托管 + 交付前自检（收口点 2） | 自检不过即回炉；不静默提交带外链隐患的页面 |
| 3.6 | 按 §5.2「改动范围双向自查」比对基线副本与工作副本（收口点 3） | 自查不过即回炉；**禁止**带需求外改动或上下文残留内容提交事务 |
| 3.7 | 按 §5.3 校验 `<img>` 上的图片裁剪元信息（`data-original-src` / `data-last-crop-*`）是否按规则保留 / 更新 / 清除 | 属性被吞、或裁剪未基于原图，即回炉 |
| 4 | 对每个修改过的文件调用 `get_page_upload_url.py`，随后 PUT 文件 | `--path` 必须使用产物相对路径，不允许绝对路径或 `..`；只上传经 §5.2 自查通过的文件 |
| 5 | `commit_page_transaction.py` | 提交前根据本次修改生成 50 个字以内的中文 `message`，例如"更新文案""调整样式""修复链接"；有 `pnid` 时带 `--pnid`，没有则省略；成功后读取返回的 `url`，向用户展示"Agent已为您完成相应的修改，[点击查看](<url>)"；冲突处理见 §7 |
| 6 | 收尾：整体删除 `<tmp_dir>` | commit 成功后递归删净；挂起等用户时保留；仅删该目录，属常规收尾无需确认 |

### 5.1 已发布态感知：编辑后询问是否同步发布态（诉求）

> 一次编辑（commit 新版本）默认只更新**在线编辑版本**。若该 page **当前处于已发布状态**（存在对外发布态 / publishUrl），需在 commit 成功后**询问用户是否把本次改动同步到发布态**，而不是静默只改在线版、让发布态停在旧内容。

| 步骤 | 动作 |
| --- | --- |
| a | commit 前/后判断发布态：`list_page_artifacts.py` / `node-info` 若返回非空 `publishUrl` 或发布标记，视为**已发布** |
| b | commit 成功后，若已发布 → **询问用户**：「这个页面已经发布过了，要不要把这次修改也同步更新到发布版本？」 |
| c | 用户确认「要」→ 触发发布态更新（重新发布 / 同步到 publishUrl 对应版本）；用户说「不用，只改在线版」→ 保持发布态为旧版本，仅在线版更新 |
| d | 未发布（无 publishUrl / 发布标记）→ **不询问**，直接完成，正常回执在线版链接 |

> 询问只在「**已发布** + 本次有实际内容改动」时触发；未发布或用户已明确「只改草稿/在线版」时不打扰。发布态更新的具体接口以平台发布能力为准；`commit` 只产出在线新版本，发布态同步是其后的独立确认动作。

### 5.2 改动范围双向自查（收口点 3 · 硬门）

上传前把工作副本与 §5 阶段 2 留存的基线副本比一遍（类比 `git diff` 自审），逐处确认改动都来自本轮用户需求；两向都通过才进入阶段 4。

```bash
# 纯文本产物（HTML / CSS / JS）逐文件比对
diff -u "<tmp_dir>/.baseline/index.html" "<tmp_dir>/index.html"
# 也可对临时目录做递归 diff；基线副本在 <tmp_dir> 内，必须排除
diff -ruN --exclude=.baseline "<tmp_dir>/.baseline" "<tmp_dir>"
```

| 方向 | 逐 hunk 确认 |
| --- | --- |
| **A · 原文只在该改处被改**（`-` 行） | 每一处被删除 / 替换的原文，都属于本轮需求要改的内容；其余原文（含排版、缩进、注释）保持原样 |
| **B · 新增内容都有出处**（`+` 行） | 每一处新增都能对应本轮需求。出处只认「本轮用户需求 + 本次下载内容」；上一轮已回滚 / 已删除的旧文案、旧字段、旧 `__SMART_PAGE__.database` 调用、旧 `databaseId`、旧 DOM 属于无出处新增，按下方回炉处理 |

- **两向全部通过** → 放行 §5 阶段 4 上传。
- **出现需求外改动 / 无出处新增** → 把该处按基线副本原内容还原，重新自查。
- **反复不过** → 停止提交，向用户说明具体位置并确认取舍。

> B 是 A 的镜像，须同时做：被写回的旧内容在 diff 里表现为 `+` 行，只看 A 无法发现。B 漏掉残留的 `__SMART_PAGE__.database.*` 调用还会污染 §6.5 的引用集合差集，导致误 `link` 已解除关联的表。

### 5.3 图片裁剪元信息 · `data-*` 保留（收口点 3.7 · 硬门）

`<img>` 上的 `data-original-src`（原图 URL）+ `data-last-crop-x/y/w/h`（上次裁剪区在**原图像素坐标系**的偏移与宽高）由前端写入，用于每次裁剪都基于原图、避免逐次裁剪掉画质。

- **改写 HTML**（改文案 / 改样式 / §3.5 回写 `src`）→ 这几个属性**原样保留**，不丢弃。
- **裁剪** → 读 `data-original-src` 拿原图裁（不拿当前 `src` 二次裁）→ 新图按 `entry.md` §2 托管后回写 `src` → 更新 `data-last-crop-*`，`data-original-src` 不变；原本没有 `data-original-src` 时，把裁剪前的 `src` 写入它。
- **换图** → 清除 `data-original-src` 与全部 `data-last-crop-*`。

自检：在 §5.2 的 diff 里确认这些属性没被吞——未做裁剪/换图时应与基线完全一致。

### HTML 元素定位与 pnid 记录规则

`pnid` 用于告诉后端本轮修改对应的首个页面节点，来源于 HTML 元素的 `data-page-node-id` 字段。只要用户、上游或评论提供了 `pnid` / `data-page-node-id`，都优先用它定位 HTML 元素；没有显式锚点时，再根据本轮实际修改位置反向记录 `pnid`。

定位优先级：

1. 用户或上游明确给出 `pnid=<id>`，或给出 `data-page-node-id=<id>` 时，在下载到临时目录的 HTML 文件中查找 `data-page-node-id="<id>"` 的元素，并以该元素作为修改落点。
2. 评论修订中，从 `thread.props.pageAnchors[]` 读取 `pnid`，优先使用第一个能在 HTML 中匹配到的 `data-page-node-id="<pnid>"` 元素。
3. 若用户给出普通 CSS selector，可用于辅助定位；但提交事务时仍必须从命中的元素或最近祖先读取真实 `data-page-node-id` 作为 `--pnid`，不要把 CSS selector 当作 `pnid`。
4. 若用户只给出文本、截图描述或自然语言位置，先在 HTML 中搜索目标文本或结构，再取命中元素自身或最近带 `data-page-node-id` 的祖先元素。
5. 若删除元素，必须在删除前记录被删除元素自身或最近带 `data-page-node-id` 的祖先元素。
6. 若只修改 CSS / JS，取本轮第一个明确受影响的目标 HTML 元素或其最近带 `data-page-node-id` 的祖先元素。
7. 若是全局样式、全局脚本逻辑、动态生成 DOM，或按上述规则仍无法定位到 `data-page-node-id`，则不传 `--pnid`，直接提交事务。

定位示例：

```html
<h1 data-page-node-id="kfu9ejFfcrTFjkLrbGsLIG">学生名册</h1>
```

当输入 `pnid=kfu9ejFfcrTFjkLrbGsLIG` 或 `data-page-node-id=kfu9ejFfcrTFjkLrbGsLIG` 时，修改这个 `h1` 或其必要子元素；提交时 `--pnid` 传 `kfu9ejFfcrTFjkLrbGsLIG`。

## 6. 评论修订流程

**场景**：用户说"根据评论修改页面 / 评论说这里要改 / 处理页面评论"。输入通常包含 Page `nodeId`，可选 `discussionId`。

评论修订是标准编辑流程的一个输入分支：先读取评论，再进入标准编辑流程。Page 评论锚点来自 `thread.props.pageAnchors[]`；在标准流程第 2 阶段，按"HTML 元素定位与 pnid 记录规则"读取其中的 `pnid` 并定位目标元素。

### 前置：拉取评论

指定评论线：

```bash
python3 "${CODEBUDDY_PLUGIN_ROOT}/skills/library/manage/get_node_comments.py" \
  --token-stdin --node-id "<page_node_id>" --discussion-id "<discussion_id>"
```

全文 / 全节点评论（没有 `discussionId`）：

```bash
python3 "${CODEBUDDY_PLUGIN_ROOT}/skills/library/manage/get_node_comments.py" \
  --token-stdin --node-id "<page_node_id>"
```

stdout 示例：

```text
KS_DOC_COMMENTS	pg_xxx	1
[
  {
    "discussionId": "disc_abc",
    "resolved": false,
    "commentType": "inline",
    "anchorText": "学生名册",
    "props": {
      "pageAnchors": [
        {
          "pnid": "kfu9ejFfcrTFjkLrbGsLIG",
          "selector": "h1[data-page-node-id=\"kfu9ejFfcrTFjkLrbGsLIG\"]",
          "tag": "h1",
          "textContent": "学生名册"
        }
      ]
    },
    "comments": [
      {
        "commentId": "cmt_001",
        "authorId": "uid_zhang",
        "plainText": "标题需要更活泼一点",
        "createdAt": 1700000000000
      }
    ]
  }
]
```

### 评论定位与修改

对每条要处理的评论：

1. 从 `thread.props.pageAnchors[]` 取 `pnid`，按 §5"HTML 元素定位与 pnid 记录规则"定位目标元素。
2. 以该元素作为本条评论的修改锚点，根据 `comments[].plainText` 和 `anchorText` 修改该元素或其必要子元素。
3. 若所有 `pnid` 都无法在 HTML 中匹配，先用 `textContent` / `anchorText` 辅助搜索确认页面是否已变化；仍无法确认时，不要盲改，向用户说明该评论锚点已失效或页面版本已变化。

如果评论要求"标题需要更活泼一点"，可只修改这个 `h1` 的文本：

```html
<h1 data-page-node-id="kfu9ejFfcrTFjkLrbGsLIG">学生名册 · 信息看板</h1>
```

之后继续执行标准编辑流程第 3.5-5 阶段：图片托管自检、§5.2 改动范围双向自查、上传改动文件、提交事务。`commit_page_transaction.py --pnid` 传本轮第一个成功匹配并修改的 `thread.props.pageAnchors[].pnid`；`--message` 使用 50 个字以内中文描述，例如"处理评论""更新标题"。

关键规则：

- 有 `discussionId` 时只处理该评论线；没有 `discussionId` 时拉取 node 下全部活跃评论并综合判断。
- `discussionId` 只用于拉评论和回执溯源，不是事务 ID，也不传给 `commit_page_transaction.py`。
- Page 评论修订是直接提交 Page 新版本，不生成 doc 审阅卡片。
- 多条评论默认合并到一次 Page 事务提交；除非用户明确要求拆分，或评论诉求互相冲突。
- 已 resolved 的评论线默认不返回；需要包含时才传 `--include-resolved`。

## 6.5 关联关系同步：编辑改动 page↔database 引用时同步登记（诉求）

> 本轮编辑若**改变了 page 引用的 database 集合**（HTML 里增删了对某 `databaseId` 的 `__SMART_PAGE__.database.*` SDK 调用，或用户要求关联/解除某张表），则 commit 新版本**不会**同步后端关联表，必须额外登记，否则「page 引用了哪些 database」与页面实际内容不一致。只改文案/样式、引用集合没变时不动关联关系。

编排：先完成标准编辑流程（§5 阶段 1–5）提交 HTML 新版本，再用 `entry.md §6` 的 `list` 拉已登记关联，与编辑后 HTML 实际引用的 `databaseId` 集合做差集——多出来的引用 `link`，不再被引用的 `unlink`。命令、参数、幂等语义以 `entry.md §6` 为准。

> 拿不准某 `databaseId` 是否仍被引用时，先做上述 list + HTML 比对确认，不要凭印象 unlink，避免误删他人建立的关联。

## 7. 并发与版本规则

- `create_page_transaction.py` 返回的 `data.baseVersion` 永远以后端当前最新版本为准。
- 必须使用 `baseVersion` 作为 `list_page_artifacts.py --version` 的入参，确保拉取的产物与事务基线严格一致。
- **每次事务必须从远端重新下载产物**：只有本次事务通过 `list_page_artifacts` 返回的 URL 下载的文件才可作为编辑基线。
- **同轮第 N 次编辑同样是完整编辑**：从 §5 阶段 1 重走（重开事务 → 重新下载 → 重存基线）。上一次的本地目录、基线副本、上下文里的产物文本，**一律不得**当基线；"刚下载过、直接改本地那份"违规。阶段 6 清理 `<tmp_dir>` 也是这条的物理保障——目录已删，只能重新下载。
- **内容层唯一依据 = 本次下载内容**：不只版本号，内容也以后端为准。本轮改动一律在本次下载内容之上构建；与上下文记忆 / 上一轮产物不一致时以下载内容为准（含用户回滚过页面的情形）。
- **跨轮取舍**：作废「文件内容副本、内容记忆、旧 `transactionId` / `baseVersion` / 基线副本、上轮 diff 结论」；保留「用户意图与已确认口径、已托管图片 COS 直链、`databaseId` 与 schema 认知」；`pnid` 仅作线索保留，须在本次 HTML 重新匹配验证，匹配不上按 §6「评论定位与修改」第 3 条处理。即：可带走「要做什么」，不可带走「页面长什么样」。

- `commit` 命中 `SKILL.md` 状态/版本冲突码时，当前事务不可继续使用；必须从 §5 第 1 步完整重走编辑流程。
- `upload` / `commit` 如果因事务过期失败，按失败处理并重新开始编辑流程。

## 8. 安全与边界

- 不输出 token、Cookie、接口原始响应、COS header。
- `uploadUrl` 仅供 Agent 内部 PUT 使用，不得向最终用户回显。
- 只上传实际修改过、且已过 §5.2 双向自查的文件；不要为了"完整版本"上传未改动文件。
- `<tmp_dir>`（含 `.baseline/`）只用于本轮本地加工：不作为产物上传、不出现在 `get_page_upload_url.py --path` 中、不列为交付物、不做文件预览；回执只给 commit 返回的远端 `url`，不提本地路径。