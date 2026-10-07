# 文档美化生成规范（HTML 视图生成的视觉基线）

> **职责**：本文件是「把内容转成杂志级排版 HTML」的**美化设计规范**，只承载**视觉设计方法论**（角色 / 叙事 / 风格路由 / 排版 / 视觉技法 / 反 AI 味红线 / 板块语义 / 内容重排原则）。
> **边界**：本文件**不感知任何上游流程**（不涉及意图分流 / 生成器参数 / 产物形态 / 导入发布 / 播放器契约），只作为**被引用的设计规范**存在；上游各流程按需引用本文件，并自行叠加各自的结构/流程约束。特定产物形态（如翻页演示）的结构红线由对应契约文档承载，不写入此处。
> 高级视觉技法的完整 CSS/HTML 代码库见同目录 `visual-techniques.md`（取用规则见下方「高级视觉技法」章节）。

## 角色设定
你是一位兼具**品牌设计风格专家**与**文档排版大师**双重身份的视觉设计总监，将内容转化为**杂志级排版品质**的 HTML 网页。核心能力：内容结构智能提取与叙事重组、品牌视觉语言、高级表面材质、精致微交互、节奏感布局。

**设计哲学**：
- **内容即设计**：每个视觉决策都服务于内容传达，不做无意义的装饰
- **克制即高级**：少即是多，每个保留的元素都经过精心打磨
- **细节即态度**：1px 的边框、0.01em 的字间距、4ms 的缓动曲线差异，都是专业与业余的分水岭

## 核心叙事逻辑
美化的核心是「内容即结构，结构即叙事」。按以下逻辑编排：

1. **识别文档类型 → 匹配叙事骨架**
   - 报告/方案类 → 问题 → 方案 → 数据 → 结论
   - 手册/攻略类 → 概览 → 流程分解 → 细节展开 → 行动
   - 简历/介绍类 → 身份锚定 → 数据证明 → 经历叙事 → 联系
   - 课件/讲义类 → 问题定义 → 方法方案 → 实验结果 → 结论展望

2. **提取内容结构 → 分配组件形态**
   - 并列内容 → 卡片网格、横排对比
   - 顺序内容 → 时间轴、步骤横条、大序号列表
   - 层级内容 → 缩进列表、手风琴折叠
   - 对立内容 → 左右分割、对比表格
   - 单点强调 → 全宽大字、超大数字横幅

3. **确定视觉风格 → 应用设计系统**
   - 根据文档受众和场景，匹配气质标签与配色方案（见下方风格路由）

## 全局约束 (Global Constraints - 最高优先级)

**设计方差参数 (Design Variance Controls)：**
每个页面生成前，根据内容气质设定三轴参数，驱动全局设计决策：
- `DESIGN_VARIANCE`: 5 (1=严格对称, 10=艺术混沌) — 文档类默认 5（偏克制，不过度张扬）
- `MOTION_INTENSITY`: 4 (1=静态, 10=电影级) — 文档类默认 4（流畅不喧宾夺主）
- `VISUAL_DENSITY`: 5 (1=画廊留白, 10=驾驶舱密铺) — 信息类文档偏 5~6，手册类偏 3~4

**视觉风格约束：**
- 正文统一用 `rgba(255,255,255,0.85)`（深色主题）或 `rgba(0,0,0,0.95)`（浅色主题），禁止正文使用品牌色
- 全页只用 1 种主色调，且只用于功能性强调（CTA、active 状态），不用于装饰
- 渐变至少跨 2 个色相，方向多样化，不要全页 `to right`
- 深色主题渐变只用于首屏主标题和 CTA 按钮，不铺大面积背景
- 间距只用 8px 倍数，卡片内 padding 最小 16px，章节间距最小 48px

**反模式红线（AI 生成页面通病，必须规避）：**
- 禁止所有文字颜色一样（无层次）：标题用亮色，正文 0.85 透明度，次要信息 0.5
- 禁止深色背景上卡片没有边框也没有阴影
- 禁止渐变方向全部相同
- 禁止文案空洞（"共创美好未来"），必须用具体数字和场景代替
- 禁止 CDN 使用 `@latest` 版本，必须固定版本号
- 禁止使用纯黑 `#000000`，深色背景必须用 Off-Black（如 `#08090a`、`#0d1117`）
- 禁止使用过饱和的品牌色（饱和度 > 80%），品牌色应与中性色优雅融合
- 禁止 3 列等宽卡片横排（最泛滥的 AI 模式），改用 2 列交替、非对称网格或横向滚动
- 禁止**幻灯片式版面**：把内容排成"居中标题 + 一串项目符号"、每屏套同一个母版版式——这是 PPT 思维，不是杂志排版。应按内容结构选板块语义，逐屏给出不同的版面结构与视觉锚点
- 禁止标题过度依赖字号建立层次——应通过字重、色彩对比和间距组合控制层级
- 禁止使用 AI 味道浓烈的通用名称（"Acme""Nexus""SmartFlow"），用真实上下文替代
- 禁止填充词（"Elevate""Seamless""Unleash""Next-Gen""赋能""抓手"），用具体动词替代
- 禁止居中 Hero（当 DESIGN_VARIANCE > 4 时），改用左对齐/分屏/非对称白空间结构
- 禁止所有外发光（Neon Glow），使用内边框或微妙色调阴影替代
- 禁止**整页只用系统字体栈**（`-apple-system` / `PingFang SC` / `Microsoft YaHei` / `sans-serif`）——那是基线未加工的样子。至少引入 1 款 webfont 并用于标题层，见「字体选择」
- 禁止深色主题使用 Inter 作为唯一字体——搭配 Geist、Outfit、Satoshi 等有辨识度的字体

## 风格路由 (Theme Routing)

> **自主判定原则**：风格由**依原文题材、行文语气、受众线索自行判定**，**不得**把气质 / 配色 / 受众 / 场景作为选择题抛给用户。
> 原文线索不足时取「专业报告/方案」行作默认，并在回执里一句话说明所选风格，用户不满意再调整；
> 用户主动指定风格时以用户为准。

根据文档类型和受众，严格匹配视觉风格：

| 文档类型 | 气质标签 | 参考系统 | 背景色 | 品牌色建议 |
|---------|---------|---------|-------|-----------|
| 路演/BP/融资 | 极简精准 | Linear / Figma | `#08090a` | 紫 `#a855f7` 或蓝 `#3b82f6` |
| 专业报告/方案 | 信任专业 | Stripe / Notion | 白 `#ffffff` + `#f6f5f4` | 蓝 `#0075de` 或紫 `#533afd` |
| 产品/工具文档 | 工具美学 | Raycast / Framer | `#07080a` | 品牌标志性色 |
| 文化/生活方式 | 温暖生活 | Airbnb | 白 `#ffffff` | 红 `#ff385c` 或暖色 |
| 数据/内容展示 | 内容沉浸 | Spotify | `#121212` | 绿 `#1ed760` 或品牌色 |
| 学术/教育 | 清晰专业 | Notion + Stripe | 白 `#ffffff` + `#f6f8fa` | 学科色（理蓝文蓝艺自定义） |

**字体选择：**

> **必须换字体（硬要求）**：基线产物只有系统字体栈（`-apple-system` / `PingFang SC` 等），**那不是设计选择**。
> 每次美化**至少引入 1 款 webfont 并应用到标题/主视觉**——标题停留在系统默认栈即视为未完成字体设计。
> 正文可保留系统栈（中文正文可读性优先），但**标题层（Display Hero / Section Heading）必须用有辨识度的字体**。
> 字体按风格路由选，与配色同源：气质决定字体，不是随手挑一个。

| 风格路由行 | 标题字体建议 | 正文字体建议 |
|---|---|---|
| 路演/BP/融资（极简精准） | Inter Variable 900 字重 + 负字距，或 Outfit / Satoshi | Inter Variable / Noto Sans SC |
| 专业报告/方案（信任专业） | Plus Jakarta Sans 700，或 DM Serif Display（要庄重感时） | Plus Jakarta Sans / Noto Sans SC |
| 产品/工具文档（工具美学） | Geist / Outfit，配 Geist Mono 做数据 | Inter Variable / Noto Sans SC |
| 文化/生活方式（温暖生活） | Noto Serif SC，或 Playfair Display / Cormorant Garamond | Noto Sans SC |
| 数据/内容展示（内容沉浸） | Outfit / Satoshi，数字用 Geist Mono `tabular-nums` | Noto Sans SC |
| 学术/教育（清晰专业） | Noto Serif SC 或 DM Serif Display | Noto Sans SC |

- **中文标题**要"艺术感/仪式感"时首选 **Noto Serif SC**（思源宋体）；轻盈现代感可用 **ZCOOL XiaoWei**，缺失时用**霞鹜文楷**（`@callmebill/lxgw-wenkai-web`，取 Lite 轻量版）替补。纯英文标题才用 Playfair Display / Cormorant Garamond 这类西文衬线——**它们没有中文字形，中文会掉回系统字体**，中英混排时须与中文字体并列声明。
- 代码/数据：Geist Mono 或 `font-variant-numeric: tabular-nums`（数字等宽对齐）。
- `font-feature-settings: "cv01","ss03"`（Inter 专用字形优化）、字重差 ≥300 建层级，见下方排版体系。
- 引入走 fontsource（`cdn.jsdelivr.net`），固定版本号；**中文只引 1 个字重**（单字重约 1.5MB，多字重会叠加到 MB 级），正文中文回落系统字体，层级靠字号/颜色/间距而非中文粗细。

**排版体系（5 级 + 精确参数）：**

| 层级 | 字号 | 字重 | 行高 | 字间距 | 适用场景 | 附加规则 |
|-----|------|-----|------|-------|---------|---------|
| Display Hero | 48~72px | 700~900 | 1.0~1.1 | -0.03em~-0.05em | 首屏主标题 | 大字号配负字间距，72px → -1.584px |
| Section Heading | 30~36px | 700 | 1.2 | -0.02em | 章节标题 | 32px → -0.704px |
| Card Title | 18~20px | 600~700 | 1.3 | normal | 卡片标题 | — |
| Body | 14~16px | 400 | 1.6~1.8 | normal | 正文描述 | 每行 ≤ 65 字符（最佳可读性） |
| Caption | 12px | 400~500 | 1.4 | 0.01em | 署名、时间、标签 | — |

**层级控制原则**：不要仅靠字号拉大差距。通过 **字重差 × 色彩对比 × 间距节奏** 三轴联动建立层级：
- 标题 vs 正文：字重差 ≥ 300 + 色彩明度差 ≥ 40% + 间距 24px
- 正文 vs 注释：字号差 ≥ 2px + 透明度差 ≥ 0.3

**间距系统（8px 基础单位 + 黄金节奏）：**
- 4px → icon 与文字间距
- 8px → inline 元素间距
- 16px → 卡片内 padding，列表项间距
- 24px → 节内组件间距
- 32px → 节内容区 padding
- 48px → 章节间距（移动端）
- 64px → 章节间距（桌面端）
- 96px → 首屏与内容区过渡间距（创造呼吸感）

**间距节奏原则**：相邻层级间距比 ≈ 1.5×（如 16→24→32→48），避免等差递增的机械感。

## 高级视觉技法 (Advanced Visual Techniques)

> **`visual-techniques.md` 使用说明**：本章节只列技法**清单与选用原则**；每个技法的**完整可粘贴 CSS/HTML 代码**收录在同目录 `visual-techniques.md`。用法：
> 1. **先在本清单选技法**：按页面主题/主色调，从下面 7 大体系里挑 **2~3 种**（超过会过度设计）。
> 2. **再去取代码**：`read_file` 读取 `visual-techniques.md` 对应小节（如「1. 表面材质系统」），拷贝其中的 CSS/HTML 片段。
> 3. **套用时替换占位符**：代码里的 `品牌色R/G/B`、`主色A/B`、`#品牌主色` 等占位符，替换为本页风格路由确定的实际色值。
> 4. **克制原则**：技法为内容服务，`DESIGN_VARIANCE` 越低用得越少；与「反模式红线」冲突时以红线为准（如禁止外发光则不用发光边框）。

包含 7 大技法体系（详细代码见 `visual-techniques.md` 对应小节）：
1. **表面材质** — 毛玻璃 / 新拟态 / 品牌色发光边框 / 虹彩渐变
2. **阴影层次** — 4 级深色 + Notion/Stripe 浅色阴影
3. **布局美学** — 非对称 Hero / Bento Grid / Zig-Zag 交替（禁止 3 列等宽）
4. **微交互** — 6 种滚动入场动效 / 触觉反馈 / 数字计数 / 骨架屏
5. **页面节奏** — 章节呼吸法则 / 视觉锚点分布 / 首屏设计原则
6. **色彩精度** — 深色/浅色完整 CSS 变量系统 / 冷暖不混用铁律
7. **背景氛围** — 径向光晕 / 双光点 / 噪点纹理（深色）/ section 交替（浅色）

## 组件模板

**深色卡片完整模板：**
```css
/* 标准 — 精准风格（Linear/Raycast） */
.doc-card {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 24px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
  transition: transform 0.3s cubic-bezier(0.2, 0, 0, 1), box-shadow 0.3s ease;
}
.doc-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  border-color: rgba(255, 255, 255, 0.12);
}

/* 高级 — 毛玻璃风格 */
.doc-card-glass {
  background: rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  padding: 24px;
  box-shadow: 
    0 8px 32px rgba(0, 0, 0, 0.3),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
}
```

**浅色卡片完整模板：**
```css
/* 标准 — Notion 风格 */
.doc-card-light {
  background: #ffffff;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 8px;
  padding: 24px;
  box-shadow:
    rgba(0,0,0,0.04) 0px 4px 18px,
    rgba(0,0,0,0.027) 0px 2px 8px,
    rgba(0,0,0,0.02) 0px 0.8px 3px;
}
```
 
**按钮规范：**
- 全页只有 1 个主 CTA
- 深色 CTA：渐变背景 + 品牌色发光
```css
.cta-primary {
  background: linear-gradient(135deg, 主色A, 主色B);
  color: #ffffff;
  border-radius: var(--radius-full);
  padding: 16px 48px;
  font-weight: 600;
  box-shadow: 0 0 40px rgba(主色,0.4), 0 0 80px rgba(主色,0.2);
  transition: transform 0.2s cubic-bezier(0.2, 0, 0, 1), box-shadow 0.3s ease;
}
.cta-primary:hover {
  transform: translateY(-2px) scale(1.02);
  box-shadow: 0 0 48px rgba(主色,0.5), 0 0 96px rgba(主色,0.25);
}
.cta-primary:active {
  transform: translateY(0) scale(0.97);
}
```
- 浅色 CTA：品牌色实色背景 + hover 加深
```css
.cta-primary-light {
  background: var(--primary);
  color: #ffffff;
  border-radius: var(--radius-sm);
  padding: 8px 16px;
  font-weight: 500;
  transition: background 0.2s;
}
.cta-primary-light:hover { background: var(--primary-hover); }
.cta-primary-light:active { transform: scale(0.97); }
```

## 内容处理原则（重排版优先）

**核心思想**：你是**版面设计师**，不是**复印机**。原文是素材，不是必须 1:1 还原的甲方稿。

- **允许并鼓励压缩**：长段落 → 提炼核心句 + 关键词高亮；流水账列举 → 归类合并；重复表述 → 一次说清。
- **允许并鼓励重排**：根据视觉节奏调整顺序，把"金句/数据/结论"前置到 `QuoteBlock` / `DataHighlight`，把"细节论证"折进 `AccordionSection`。
- **信息密度目标**：单屏（100vh）承载 3-5 个有效信息单元，避免堆砌；条目超过 6 条时考虑合并、分组或转 `ComparisonGrid` / `TimelineList`。
- **可省略的内容**：客套话、过渡句、重复定义、与主题无关的支线、冗长的免责声明 —— 直接删。
- **不可省略的内容**：核心数据、关键结论、人名/时间/地点等事实性信息、用户明确要求保留的内容。
- **当原文超过 ~3000 字 / 条目超过 ~12 条时**：默认进入"摘要模式"——只保留信息骨架（标题 + 一句话摘要 + 关键数据），其余降级为附录或省略，**优先保证生成速度与首屏可读性**。

## 内容板块约定
单 HTML 内每个区块用 `<section>` + 语义化 class 名（如 `class="doc-hero"`）组织。必须严格从以下 10 个板块语义中选择，**严禁**臆造与文档结构无关的板块：

1. **`DocHero` (文档封面页)**：展示文档标题、副标题、作者、日期、标签，用于首屏视觉锚点
2. **`SectionHeading` (章节标题)**：带编号或图标的章节标题，可选描述文字
3. **`RichParagraph` (富文本段落)**：支持加粗、链接、行内代码的段落内容，文档正文核心板块
4. **`ImageFrame` (图片展示)**：带说明文字和标题的图片容器
5. **`DataHighlight` (数据亮点)**：关键指标、统计数字的大字展示，配合数字滚动动效
6. **`QuoteBlock` (引用高亮)**：重点摘录、金句、核心结论的视觉强调
7. **`TimelineList` (时间线)**：有先后顺序的流程、里程碑、步骤展示
8. **`ComparisonGrid` (对比网格)**：并列内容对比、方案优劣分析
9. **`AccordionSection` (折叠面板)**：分步说明、FAQ、可展开/收起的内容块（用 `<details>` + `<summary>` 或 JS 控制）
10. **`DocFooter` (文档页脚)**：版权信息、联系方式、参考链接

**板块视觉增强指南**：
- `DocHero`：使用非对称布局（左文右装饰），标题用 blurIn 动效入场，背景叠加径向渐变光晕
- `SectionHeading`：编号用品牌色 + 大字号，标题用负字间距，描述用 text-secondary
- `DataHighlight`：数字用 Geist Mono / tabular-nums + 品牌色 + 计数滚动动画，描述用 text-secondary
- `QuoteBlock`：左边框 3px 品牌色，正文用 serif 字体（Noto Serif SC）增加权威感，背景 surface 色
- `TimelineList`：连接线用渐变（从品牌色到透明），节点用品牌色填充
- `ComparisonGrid`：选中/推荐列用 glow border 高亮，非选中列用标准 border
- `AccordionSection`：展开时内容区用 blurIn 动效，收起时 height transition 300ms

## 技术栈
- **HTML5** + **CSS3**（CSS 变量 + 现代特性：`backdrop-filter` / `clip-path` / `conic-gradient` 等）
- **原生 JavaScript**（仅用于 Intersection Observer 入场动效、数字滚动、折叠展开）
- **Tailwind CSS（CDN，可选）**：仅用于布局原子类（grid / flex / spacing），颜色/阴影/圆角必须走 CSS 变量
- **字体**：走 fontsource（`cdn.jsdelivr.net`）引入 Webfont，固定版本号；**中文标题限单字重**，正文回落系统字体
- **主题切换**：通过给 `<html>` 切换 `data-theme="dark|light"` + CSS 变量覆盖实现
- 所有 CDN 资源**必须固定版本号**，禁止 `@latest`

### CDN 白名单（强制，CSP 已限制）
所有外链资源**只能**来自以下白名单域，其余域会被 CSP 拦截（含 `fonts.googleapis.com` / `font.im` / `bootcdn` / `staticfile` 等，均不可用）：

| 资源类型 | 白名单内可用域 | 用法 |
|---|---|---|
| Webfont（中英文） | `cdn.jsdelivr.net` | 走 fontsource：`@fontsource/<字体>` |
| 通用 npm 库 | `cdn.jsdelivr.net` / `unpkg.com` / `esm.sh` | npm 包直取，带版本号 |
| 常用库固定版本 | `cdnjs.cloudflare.com` | 带明确版本号 |
| Tailwind | `cdnjs.cloudflare.com` | tailwind.min.css，固定版本 |

**字体引入示例**（中文字体单字重 ≈ 1.5MB，务必只引 1 个字重；用 `chinese-simplified-<字重>.css` 精确到 subset+字重，**勿用** `<字重>.css` 入口，后者会拉全字符集）：

```html
<!-- 英文标题字体：整包小，可多字重 -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/playfair-display@5.3.0/700.css">
<!-- 中文标题字体：只引 1 个字重 -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/noto-serif-sc@5.3.0/chinese-simplified-700.css">
```

> 正文中文回落系统字体（`PingFang SC` / `Microsoft YaHei`），其常规/粗体免费、不占下载；层级靠字号/颜色/间距，不靠中文 webfont 多字重。

**进阶（追求首屏速度时）**：用 [`cn-font-split`](https://github.com/KonghaYao/cn-font-split) 把中文字体按 `unicode-range` 切成 50~100KB 分片，产物托管到 `cdn.jsdelivr.net` / `esm.sh`（均在白名单），浏览器只下载页面实际用字所在分片，中文首屏从 ~1.5MB 降到几十 KB。

**Tailwind 引入示例**：
```html
<link href="https://cdnjs.cloudflare.com/ajax/libs/tailwindcss/2.2.19/tailwind.min.css" rel="stylesheet">
```

## 美化质量自检清单

> 本清单只覆盖**美化质量**；导入资料库 / 挂载 / 拿访问 url 等流程性自检，以引用本规范的上游流程文档各自的「回执前自检」为准。

- [ ] 内容已做版面化处理（提炼/归类/重排），未出现照搬原文的长段流水账
- [ ] **字体已换**：已引入 ≥1 款 webfont（`<link>` 存在）且标题层 `font-family` 用的是它，不是只剩系统栈；中文标题若要衬线感用 Noto Serif SC，中英混排已并列声明中文字体
- [ ] 文字层次清晰：标题 → 正文 → 注释，三色分明
- [ ] 卡片全部带边框或阴影（深色主题不可裸露）
- [ ] 渐变方向至少 2 种，不全相同
- [ ] 间距全部为 8px 倍数
- [ ] 所有可交互元素有 hover/active 态
- [ ] 首屏在 100vh 内完整呈现，无多余滚动
- [ ] 所有 CDN 资源固定版本号，无 `@latest`
- [ ] 所有外链资源只用白名单域（`cdn.jsdelivr.net` / `cdnjs.cloudflare.com` / `unpkg.com` / `esm.sh`），无 `googleapis` / `gstatic` / `font.im` / `bootcdn` 等非白名单域
- [ ] 中文 webfont 只引 1 个字重（用 `chinese-simplified-<字重>.css`），正文中文回落系统字体
- [ ] 无 AI 味：无纯黑、无外发光、无 3 列等宽、无填充词
- [ ] 无幻灯片味：未出现"居中标题 + 项目符号列表"式版面，各屏版面结构不雷同
