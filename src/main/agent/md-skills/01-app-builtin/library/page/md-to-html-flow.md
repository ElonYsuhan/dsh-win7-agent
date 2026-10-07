# 一键美化：非 html 节点 → html 节点（挂到原节点下）

> **职责**：把资料库里一个**非 html 节点**一键美化成一页可视化 html，并作为**原节点的子节点**挂载（父子关系）。按源节点 `kind` 分两条分支：
>
> | 源节点 | `kind` | 分支 | database |
> |---|---|---|---|
> | 文档（md 正文） | `doc` | **分支一 · md→html** | **不建、不关联** |
> | 表格（csv 导入的数据表） | `database` | **分支二 · csv→html** | **只读动态关联原表**（禁止任何写操作）；关联走独立的 `page_database_relation.py --action link` 调用（见 entry.md §6），**不用** `import_html --databases` |
>
> - 分支一：产出自包含 html，直接挂到源 doc 下。
> - 分支二：让 html **运行时动态从原 csv（database）读数渲染**；只做**可视化只读版本**，`databaseId` 硬编码为原表 id，**绝不写回原表**（无 `addRecord`）。
>
> **美化流程引用（跨意图）**：生成 html 的视觉质量由 §3 的意图决定——意图①（纯视图转换，默认，`--format page`）与意图③（其他意图）套用 `beautify/beautify-guide.md` 做杂志级排版；意图②（汇报）恒为**翻页演示**（`--format presentation`），同样套用 `beautify/beautify-guide.md`，并按 `wbp-presentation-contract.md` §7.10 / §12 **逐张建版**。详见 §3。

---

## 0. 触发与分支仲裁

### 入口（命中任一即进；须同时满足"美化意图 + 资料库节点目标"）

- **入口 A · 「一键美化」按钮**：宿主强制 `skill="library"` + `autoSend`，prompt 含「一键美化/可视化生成 …… HTML」+ `spaceId:` / `nodeId:` / `kind:`。
- **入口 B · 对话贴链接 + 美化意图**：用户给 `workbuddy.cn/space/...`（或 `staging...` / nodeId）+ 明确要「一键美化 / 可视化 / 做成汇报页 / 演示」。

> 缺任一条件即**不属于本文件职责**：只泛泛说"做个页面 / 写个 html"而无资料库节点目标，或源节点不是非 html 节点，均不在本流程范围内。

### kind 仲裁 + 取节点标识（`manage` 的 `space.workspace.node-info`）

> **一次拿全三个值**：`node-info --url <原文档链接>`（仅接受 `/space/d/{nodeId}` 形态；`/space/s/{spaceId}` 是空间不是节点，不适用本流程）一次返回 `kind` / `nodeId` / `spaceId`（见 `manage/entry.md`）。其中 **`spaceId` 是后续 `import_html.py` 挂到源节点下的必备参数**——`parentId` 需与其所属 `spaceId` 配套提交，缺 `spaceId` 服务端无法定位父节点、会回退到默认我的文档目录（挂载失败）。

| `kind` | 路由 |
|---|---|
| `doc` | **分支一**（本文件 §1） |
| `database`（csv 表） | **分支二**（本文件 §2） |
| `web` / `page` | 已是 html page，改样式走 `edit-flow.md`，**不在本流程** |
| 其它 / 目录 | 按 `manage/entry.md` 处理 |

---

## 1. 分支一 · md → html（kind=doc，不涉及 database）

### 执行铁序

```
① 净化门：确认 md 母本只含面向读者的成品内容，剥离 token / 工具轨迹 / 本地绝对路径
② 意图分流（见 §3）：先判纯视图转换 / 汇报 / 其他意图；默认纯视图转换；汇报意图恒为翻页演示（--format presentation）
③ 读源节点正文：doc 模块按 nodeId 读正文，落为本地 md 母本
④ md_to_html.py 生成基线 html（汇报意图 --format presentation；纯视图转换 / 其他意图 --format page，见 §4）
⑤ 美化（三种意图都要，见 §4.2）：按 beautify 规范落地并产出 BEAUTIFY_OK 信号；汇报（翻页）按 `wbp-presentation-contract.md` §7.10 / §12 逐张建版
⑥ import_html.py --parent-id=<源doc节点id> --space-id=<源节点spaceId> 导入，html 挂到源节点下
   （--space-id 取自 §0 node-info 返回；缺它会回退到默认我的文档目录、挂载失败）
```

> 完成即止：**不** `list_page_artifacts`、**不**建 database、**不**注入 SDK、**不**回绑。产物是一页纯静态自包含 html，作为源 doc 的子节点。

### 落库形态

```
doc（源节点，md 正文）
└── html（page 节点）   ← import_html --parent-id=<源doc节点id> --space-id=<源节点spaceId>
```

### 回执前自检

- [ ] 是否按 §3 完成意图分流（默认纯视图转换 `--format page`；汇报意图恒为翻页 `--format presentation`）？
- [ ] 是否用 `md_to_html.py`（而非手写）生成基线 html？
- [ ] 三种意图是否都已过 §4.2 美化硬门（回执含 `BEAUTIFY_OK`）？汇报（翻页）是否已逐张建版、`data-wbp-source` 残留为 0？
- [ ] 是否遵守 §4.0 内容要求（图片零丢失、不掺无关内容）？
- [ ] 交付前已走 `entry.md` §2「图片托管」流程？
- [ ] 是否 `import_html.py --parent-id + --space-id`（两者配套）挂到源节点下并拿到 `KS_IMPORT_OK` 与访问 url？（缺 `--space-id` 会挂载失败、回退默认目录）

---

## 2. 分支二 · csv → html（kind=database，只读动态关联原表）

> 源 csv 节点即 `database` 节点，其 **nodeId 即 databaseId**。本分支不新建表，让 html 运行时用 `__SMART_PAGE__.database` **只读** SDK 从原表拉数渲染。

### 执行铁序

```
① 净化门：同 §1①
② 意图分流（见 §3）：同 §1②（默认纯视图转换 `--format page`；汇报意图恒为翻页 `--format presentation`）
③ 读原表结构与少量样本（不读全表）：
     ../database/get_database_schema.py --database-id=<源节点id>                → 字段名/类型/选项
     ../database/query_database_record.py --database-id=<源节点id> --page-size 5 → 取前几行样本（仅用于判断可视化形态：表/看板/图表）
   据此构造"可视化母本"（图表/看板/卡片布局的 md 骨架，含字段语义，不写死数据行）
④ md_to_html.py 生成基线 html 骨架（汇报 --format presentation；纯视图转换 / 其他 --format page，见 §4）
⑤ 美化（三种意图都要，见 §4.2）：按 beautify 规范落地可视化视图排版并产出 BEAUTIFY_OK 信号；汇报（翻页）按 `wbp-presentation-contract.md` §7.10 / §12 逐张建版
⑥ Agent 注入只读渲染脚本（见 §4）：
     硬编码 DATABASE_ID = <源节点id>；用 db.query / db.getSchema 拉数渲染；
     只读——禁止 addRecord 及任何写 / 改 / 删原表的调用
     数据全部来自运行时读取，禁 mock / fallback 兜底，读不到显示空态提示（见 §5 数据真实性红线）
⑦ lint：../page/lint_database_sdk_usage.py 校验 SDK 调用，并人工确认无 addRecord（见 §4 只读红线）
⑧ import_html.py --parent-id=<源节点id> --space-id=<源节点spaceId>   不传 --databases
     html 挂到源 csv 下；从 KS_IMPORT_OK 取 node_block_id 与 url
     （--space-id 取自 §0 node-info 返回；缺它会回退到默认我的文档目录、挂载失败）
⑨ ⑧ 成功拿到 node_block_id 后，单独建 csv ↔ html 关联（调用形态见 entry.md §6）：
     page_database_relation.py --action link --page-id=<node_block_id> --database-id=<源节点id>
```

### 落库形态

```
database（源节点，csv 表）
└── html（page 节点，可视化只读版）   ← ⑧ --parent-id 决定树形位置
        ├─ ⑨ --action link 登记 pageId=<html节点id> / databaseId=<源节点id>
        └─ 运行时 db.query({databaseId:<源节点id>}) 动态读原表渲染
```

### 回执前自检

- [ ] 意图分流（§3）、`md_to_html.py` 生成、`import_html.py --parent-id + --space-id`（配套）挂载三项是否完成？（缺 `--space-id` 会挂载失败）
- [ ] 三种意图是否都已过 §4.2 美化硬门（回执含 `BEAUTIFY_OK`）？汇报（翻页）是否已逐张建版、`data-wbp-source` 残留为 0？
- [ ] 是否遵守 §4.0 内容要求（图片零丢失、不掺无关内容）？
- [ ] 交付前已走 `entry.md` §2「图片托管」流程？
- [ ] html 中 `DATABASE_ID` 是否硬编码为**源节点 id**，数据是否**运行时 `db.query` 动态读取**（非写死）？
- [ ] 是否**只有只读调用**（`query`/`getSchema`/`getRecord`），**无 `addRecord`** 或任何写操作？
- [ ] html 数据是否**全部来自运行时读取**，无任何 mock / fallback 兜底数据？读不到时是否显示空态提示（而非假数据）？
- [ ] 导入时仅传 `--parent-id` + `--space-id`，再用 `page_database_relation.py --action link` 建立 csv ↔ html 关联？

---

## 3. 意图分流（§1/§2 两分支共用）

> §1/§2 执行铁序里的「② 」到这里落地：两条 kind 分支进入本节后，**先按用户意图分流再生成**。
>
> 术语区分：**「分支」=按源节点 kind 分的 §1 md→html / §2 csv→html；「意图」= 本节按用户诉求分的纯视图转换 / 汇报 / 其他**。默认意图是纯视图转换。

### 3.0 意图判定（按用户输入，命中即定）

| 意图 | 触发 | 生成方式 | 详见 |
|---|---|---|---|
| **纯 html 视图转换**（默认） | 未提任何汇报/演讲诉求，只要求「一键可视化生成 HTML 页面 / 转成网页 / 做成 html / 美化成网页」等 | `--format page` 滚动长页 + **套用 `beautify/beautify-guide.md`** 产出杂志级排版，气质按其风格路由随原文题材 | §3.1 |
| **汇报**（恒为翻页演示） | 用户明确提到汇报 / 演讲 / PPT 化 / 演示 / 幻灯片 / 路演 / pitch / 述职 / 复盘汇报等 | `--format presentation` 出翻页空框架 + **套用 `beautify/beautify-guide.md`**，按 `wbp-presentation-contract.md` §7.10 / §12 逐张建版 | §3.2 |
| **其他意图** | 用户给出上述之外的明确诉求（如「做成产品介绍页 / 落地页 / 数据看板 / 简历页 / 按某风格做」等） | `--format page` + **先满足用户独立诉求**，再套用 `beautify/beautify-guide.md` | §3.3 |

> 判定优先级：用户显式意图 > 默认。分不清是纯视图转换还是汇报时，默认纯视图转换（长页），可一句话告知"也可做成翻页汇报/演示版，需要的话告诉我"，不擅自套汇报。
>
> **美化流程全意图覆盖**：三种意图生成 html 时都**必须**按 `beautify/beautify-guide.md` 做美化。差异在产物形态与工作方式：意图①/③ 为滚动长页，在基线上做整篇排版富化；意图②（汇报）为翻页演示，基线是空框架，须按 `wbp-presentation-contract.md` §7.10 / §12 **逐张建版**。

### 3.1 纯 html 视图转换（默认意图 · 走美化流程）

> ⚠️ **"纯视图转换" ≠ "轻量直转/原样转网页"**：这里的"纯"只表示**不判为汇报翻页**，**不代表**跳过美化——本意图仍须走 §4.2 美化富化。

**目标**：把原文（doc 正文 / csv 数据）转成一页**杂志级排版、视觉精致**的可读 html，弥补基线生成质量不足。

- `md_to_html.py` 用 `--format page`（滚动长页）。
- **必守美化规范**：按 `beautify/beautify-guide.md` 做美化富化（长页无翻页结构约束，可用完整 beautify）。
- 遵守 §4.0「内容要求」。
- csv 分支（§2）在本意图下同样只做「原表数据的可读可视化视图」，仍遵守 §2 只读红线；美化规范同样适用于可视化视图的排版。

### 3.2 汇报意图（外层演示框架 + 每页杂志级排版）

> 只要 §3.0 判为「汇报」，产物即为翻页演示（`--format presentation`，WBP native 档）。
>
> **关键认知**：`presentation` 只决定**外层框架**适配演示模式（可翻页、16:9、带提词器）；**每一页的内容仍是杂志级排版网页**，不是传统 PPT 版式。

- `md_to_html.py` 用 `--format presentation` 生成**翻页空框架**（自动切页、四区结构、每页 md 原料 + 草稿逐字稿，页内无可见 DOM，见 §4.1）。
- **逐张按 beautify 建版**：每张 slide 读原料，按 `beautify/beautify-guide.md` 选板块语义、套 5 级排版与视觉技法，做成**一屏杂志级排版网页**；16:9 适配与结构红线见 `wbp-presentation-contract.md` §7.10。
- 遵守 §4.0「内容要求」；产出 §4.2 `BEAUTIFY_OK` 硬门信号后方可导入。

> **内容适配提示**：若内容形态更像长文报告（信息密度高、以阅读为主、无演示诉求），应归为意图①（长页），而非硬塞进翻页。汇报=翻页是**用户明确要汇报/演示**时的产物形态，不是对所有长内容强制分页。

### 3.3 其他意图（先满足独立诉求，再走美化流程）

用户给出汇报之外的明确页面诉求（产品介绍页 / 落地页 / 数据看板 / 简历页 / 指定风格等）时：`--format page`，**先满足用户的独立诉求**（按其指定的页面形态 / 风格 / 结构组织），**再套用 `beautify/beautify-guide.md` 美化规范**做视觉富化——用户显式诉求与美化规范冲突时以用户诉求为准，未冲突处按美化规范执行。仍须遵守 §4.0「内容要求」与安全边界（§7）。

---

## 4. 基线生成器 md_to_html.py（纯本地，不触网/不读 token）

> ⚠️ **`md_to_html.py` 只做结构、不做设计**：长页格式（`--format page`）出结构正确的半成品；演示格式（`--format presentation`）只出**空框架**（页内无可见 DOM）。两者的配色都是**无彩占位灰**，都须经 §4.2 才算交付。

```bash
python3 "${CODEBUDDY_PLUGIN_ROOT}/skills/library/page/md_to_html.py" --md "<source.md>" \
  --out "<out.html>" --title "<主题>" --format page          # 意图①/③：滚动长页
python3 "${CODEBUDDY_PLUGIN_ROOT}/skills/library/page/md_to_html.py" --md "<source.md>" \
  --out "<out.html>" --title "<主题>" --format presentation   # 意图②汇报：翻页演示
```

> **脚本不做设计**：`md_to_html.py` 把 `:root` 变量填为**无彩占位灰**（零色相零饱和，刻意不好看），实际配色/字体一律由 §4.2 按 `beautify/beautify-guide.md` 风格路由**覆写 `:root`** 落地。占位灰残留即视为未美化。

| 参数 | 必填 | 说明 |
|---|---|---|
| `--md <path>` | 是 | 本地 md 母本路径 |
| `--out <path>` | 否 | 输出 html；缺省同目录 `<stem>.html` |
| `--title <str>` | 否 | 缺省取 front-matter `title` / 首个 H1 / 文件名 |
| `--format <str>` | 否 | `page`(默认，滚动长页)/`presentation`(WBP 翻页空框架) |

- 解析 front-matter → inline md → block md。`page` 格式按 H1/H2 切卡片并渲染正文；`presentation` 格式只切页、不渲染页内正文（原料存 `data-wbp-source`）。两者都内联全部 css/js 产出**自包含** html。
- **mermaid 代码块**（```` ```mermaid ````）：`page` 格式渲染成 `<div class="mermaid">`，加载 mermaid.js 期间显示 loading 占位；页面加载时按需从固定版本 CDN（白名单域 `cdn.jsdelivr.net`）动态加载画成图；无网/加载失败/超时才退回代码块文本（`data-mermaid-src` 兜底，零丢失；无 JS 环境有 `<noscript>` 兜底）。图内配色/连线/字体通过 `themeVariables` 运行时读取页面 `:root`（`--accent`/`--panel`/`--text` 等）动态套用，随覆写后的 `:root` 变量走。`presentation` 格式的 mermaid 加载器同样内置，agent 建版时产出 `.mermaid` 容器即可生效。
- `:root` 只填无彩占位灰（`#8f8f8f` / `#121212` / `#1c1c1c` 等），**不代表任何设计选择**；滚动揭示动效对 `prefers-reduced-motion` 降级。
- 输出契约：成功 `KS_MD2HTML_OK <JSON>`（`{html_path,title,sections,format}`）；失败 `{"error":...}` exit 0。
- `:root` 变量清单见 `wbp-presentation-contract.md` §7；基线须经 §4.2 才交付（见本节引言）。

### 4.0 内容要求（三种意图通用 · 生成 html 时必守）

1. **图片等资源零丢失**：原文（doc 正文 / md 母本）中的图片、附件引用，转换后必须完整保留并正确渲染，不得丢弃或替换成占位。图片按 `entry.md` §2 图片托管流程转内链后回写，不静默留空。
2. **不掺入与原文无关的内容**：只呈现原文本身的信息，不得凭空添加原文没有的段落、结论、数据。
3. **视觉气质来源**：三种意图的视觉气质、配色、排版**统一以 `beautify/beautify-guide.md` 的风格路由为准**（AI 依原文题材匹配气质标签与配色，通过覆写 `:root` 变量落地）。
4. **尊重用户显式诉求**：用户对内容有补充、增删或明确生成要求时（如新增某段、强调某数据、按某结构/风格组织），以用户指令为准，与之冲突的前 1~3 条默认约束让位；未提及的部分仍守前 1~3 条。

### 4.1 --format presentation（WBP 演示档 · 汇报意图恒用）

> **何时用**：§3.0 判为「汇报」意图时用 `--format presentation`。若内容更像长文报告、无演示诉求，应归意图①（长页 `--format page`）。

- 产物是**空框架**：`<main data-wbp-deck>` + 每页 `<section data-wbp-slide>` 外壳 + 每页不可见 `<script data-wbp-source>`（该页 md 原料）+ 隐藏 `<aside data-wbp-notes>`；**页内没有任何可见 DOM**。根标记 `<html data-wbp ...>`；不写翻页 JS（容器职责）。
- 切分：H1→cover；H2→section，按 16:9 盒高预估自动分页（长 section 拆续页）；末页 cta。
- **页内版面由 §4.2 建版产出**：agent 逐张读原料、自行决定版式、写出页内 DOM 与 CSS，完成后删除该页原料。约束与操作指引见 `wbp-presentation-contract.md` §7.10、§12。
- **导入前硬门**（不通过先修再导入）：
  - 产物中 `data-wbp-source` 命中数为 **0**，且每个 `data-wbp-slide` 内有可见 DOM——残留即该页未建版。
  - `:root` 中无基线占位灰残留（`#8f8f8f` / `#121212` / `#1c1c1c`）——残留即未按风格路由换肤。
  - `[data-wbp-notes]` 的 `display: none` 规则仍在，页面正文无「演讲提示 / 演讲口播 / 备注」类可见旁白块（见契约 §5.1）。
- 完整契约见 `wbp-presentation-contract.md`。

### 4.2 美化 / 建版 · 产出信号与验收（三种意图硬门）

> **为什么要有这一节**：`md_to_html.py` 有 `KS_MD2HTML_OK`、`import_html.py` 有 `KS_IMPORT_OK`、图片托管（`entry.md` §2）有 grep 硬门——唯独美化此前只有一句话跳转、**没有可验证的完成信号**，最容易被"基线能看就直接导入"跳过。本节给该步骤补上产出契约。

**长页（意图①/③）必做动作**：
1. **读规范**：`read_file` 读 `beautify/beautify-guide.md`（按需读 `beautify/visual-techniques.md`），不得凭记忆套。
2. **定风格**：按 guide 风格路由**依原文题材自行判定**气质与配色（不向用户征询），覆写 `:root` 的占位灰。
3. **套技法**：从 `visual-techniques.md` 选 2~3 种技法落地（替换占位符为实际色值）。
4. **重排版**：按 guide「内容处理原则」做叙事重排 / 信息密度控制，不照搬基线的朴素堆叠。
5. **过红线**：逐条对照 guide「反模式红线」自查。

**汇报（意图②）必做动作**：基线是空框架，工作是**逐张把原料排成杂志级排版网页**——
1. **读规范**：读 `beautify/beautify-guide.md`（版面语言，按需读 `beautify/visual-techniques.md`）+ `wbp-presentation-contract.md` §7.10 / §12（建版流程与 16:9 适配）。
2. **定风格**：按 guide 风格路由**依原文题材自行判定**配色/字体（不向用户征询），覆写 `:root` 的占位灰。
3. **逐张建版**：每张 slide 读 `<script data-wbp-source>` 原料 → 按 guide 选板块语义（`DocHero`/`DataHighlight`/`QuoteBlock`/`TimelineList`/`ComparisonGrid`…）与视觉技法 → 写出页内 DOM 与样式（**目标是一屏杂志级网页，不是 PPT 版式**）→ 补足该页逐字稿 → **删除该页原料**。
4. **过自检**：过 guide「美化质量自检清单」+ 契约 §7.10「建版后自检」（含 `data-wbp-source` 归零、占位灰归零、每页不是 PPT、页页不同）。

**产出信号（写进回执）**：完成上述后，在给用户/上游的回执中**显式标注一行**。`主色=` 必须填**产物 `:root` 里 `--accent` 的实际色值**（可 grep 核对，不得是占位灰）：

```
# 长页（意图①/③）
BEAUTIFY_OK 形态=page 风格=<气质标签> 主色=<#实际色值> 技法=<用到的2~3种> 红线自查=pass
# 汇报（意图②）
BEAUTIFY_OK 形态=presentation 风格=<气质标签> 主色=<#实际色值> 逐张建版=<页数>页 原料残留=0 红线自查=pass
```

- **无 `BEAUTIFY_OK` 标注 = 该步骤未完成**：三种意图的自检（§1/§2 硬门项）均判不通过，**不得进入导入步骤**。
- `主色=` 与产物 `:root` 的 `--accent` 不一致，或仍为占位灰 → 判未美化，同样不得导入。
- 汇报的 `红线自查=pass` 须同时覆盖 guide 反模式红线（含"不是 PPT 味"）与 `wbp-presentation-contract.md` §7.10.3 的外壳与时序约束。
- 该标注只是**流程自检信号**，不写进 html 页面内容、不暴露给最终读者。

---

## 5. csv 分支 · 只读动态数据契约（仅分支二）

- **SDK 注入与方法 / 参数 / `FieldValue`**：见 `database-sdk-contract.md`（§1 注入、§2 方法、§4 Query、§6 FieldValue）。
- **动态读取渲染写法**：复用 `data-page-flow.md` §3 阶段 4 **情况 2（数据展示类）** 的 `db.getSchema` + `db.query` 渲染模板——本分支即其特化：`DATABASE_ID` 硬编码为**源 csv 节点 id**，只渲染、不提交。
- **schema / lint 校验**：按 `data-page-flow.md` §1.6 用 `../database/get_database_schema.py`（`--database-id=<源节点id>`）取真实 schema，再跑 `../page/lint_database_sdk_usage.py`。

### 只读红线（本分支唯一强约束，区别于 data-page-flow.md 的读写页）

| 约束 | 说明 |
|---|---|
| **只读方法** | 仅 `db.query` / `db.getSchema` / `db.getRecord` / `db.onUpdated`（`onUpdated` 只订阅变更、不写数据，属只读）；**禁止 `db.addRecord`** 及任何写/改/删原表调用——本分支只产出可视化只读版本 |
| **databaseId = 源节点 id** | 硬编码为源 csv 节点 id，不新建表、不从别处拼|
| **数据/ schema 动态读取** | 运行时拉原表最新数据与字段渲染，不写死数据行；**推荐注册一次 `db.onUpdated`** 订阅原表变更（原表由他人持续维护时尤其建议），收到通知后如何响应（重新 `query` 重渲染 / 只刷图表 / 提示已更新）由页面自定，可免用户重载（见 `database-sdk-contract.md` §8） |
| **数据真实性（无 mock/fallback）** | 展示数据全部来自运行时 `db.query`/`db.getSchema`；禁止 mock 示例数据或 fallback 兜底假值，读取失败 / 无数据时显示空态提示（如"暂无数据"），不用假数据填充 |

> `lint_database_sdk_usage.py` 白名单含 `addRecord`，**只读约束需本分支自行把关**：lint 通过后仍须人工确认 html 内无 `addRecord`，且无硬编码示例数据行或 `catch` 里回填的兜底假数据。

---

## 6. 输出契约速查

| 脚本 / 步骤 | 成功 | 失败 |
|---|---|---|
| `md_to_html.py` | `KS_MD2HTML_OK <JSON>` | `{"error":...}` exit 0 |
| **美化 / 建版（三种意图硬门）** | 回执含 `BEAUTIFY_OK 形态=… 风格=… … 红线自查=pass`（格式见 §4.2） | 无 `BEAUTIFY_OK` = 未完成，禁止进入导入步骤 |
| `import_html.py` | `KS_IMPORT_OK <JSON>`（含 `node_block_id`/`url`） | 静默 exit 0 |
| `get_database_schema.py` | `{"id","title","properties":[...]}` | `{"error":...}` exit 0 |
| `query_database_record.py` | `{"results":[...],"next_cursor","has_more"}` | `{"error":...}` exit 0 |
| `lint_database_sdk_usage.py` | `MINDX_DBSDK_LINT_OK` | `MINDX_DBSDK_LINT_FAIL <rule> <target>: <reason>` exit 2 |
| `page_database_relation.py` | 服务端 JSON 信封（`link` 含 `linked=true`） | `{"error":...}` exit 0 |

---

## 7. 安全边界

- `md_to_html.py` 纯本地，不触网/不读 token；仅处理用户显式给出的路径，不遍历目录、不接通配符。
- **mermaid 例外**：生成脚本本身仍纯本地不触网；仅产物 html 在浏览器**运行时**按需从固定版本 CDN（白名单域 `cdn.jsdelivr.net`）加载 mermaid.js 渲染流程图，用 mermaid 默认安全等级（strict）、不启用 htmlLabels，失败退回代码块。除此之外产物不引任何外部资源。
- md→html 渲染对文本做 HTML 转义；html 中不保留任何 token / 密钥。
- 分支二只注入**只读** SDK（`query`/`getSchema`/`getRecord`），仅硬编码 `databaseId`，绝不写回原表；写 DOM 不用 `innerHTML`。
- 网络脚本遵循 `SKILL.md` §调用方式与运行模式（客户端模式 token 走 stdin 首行 + `--token-stdin`）。
