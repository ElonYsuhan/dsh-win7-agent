# WBP 演示 HTML 生成契约（skill 内引用）

> 本文件是供 `md_to_html.py --format presentation` 和 agent 直出演示 HTML 时的**最小契约**。

---

## 0. 定位

当 `md-to-html-flow.md` §3 判定走**演示**格式时，`md_to_html.py --format presentation`
生成符合本契约的 WBP native 档 html。产物可被播放器翻页播放（翻页/双屏/激光笔/分步揭示），
后续 `import_html.py` 导入挂载与长页完全一致。

**职责边界（务必先读懂这条）**：本契约只管**外层框架适配演示模式**——根标记、分页结构、16:9 定格、
提词器槽位、`.is-active` 时序。**每一页内部长什么样，本契约不负责**：页内是按
`beautify/beautify-guide.md` 排出的**杂志级排版网页**，不是幻灯片版式。
换言之：**框架是演示的，内容是网页的。**

---

## 1. 必须遵守的骨架结构

> 下面是**建版完成后**的最终形态。`md_to_html.py --format presentation` 只产出空框架（每张 slide 内无可见 DOM，只有原料与逐字稿），页内 DOM 由 agent 逐张建版写入——见 §12。

```html
<!doctype html>
<html lang="zh" data-wbp data-wbp-version="1.1"
      data-aspect="16:9" data-design-w="1280" data-design-h="720">
<head>
  <meta charset="utf-8" />
  <title>{{汇报主题}}</title>
  <script type="application/json" id="wbp-meta">{ ... }</script>
  <style>/* :root 主题变量 + .is-active 页内动画 + reduced-motion 降级 */</style>
</head>
<body>
  <main data-wbp-deck>
    <section data-wbp-slide data-slide-id="s1" data-layout="cover"
             data-zone="overview" data-transition="slide-left">
      <!-- 页内 DOM 由 agent 按该页内容自行决定，结构不受约束 -->
      <aside data-wbp-notes>逐字稿（150-300 字，口语化，加粗核心词）</aside>
    </section>
    <!-- 更多 slide -->
  </main>
</body>
</html>
```

---

## 2. 属性速查

| 位置 | 属性 | 必填 | 值域 |
|---|---|---|---|
| `<html>` | `data-wbp` | 是 | 存在即可 |
| `<html>` | `data-wbp-version` | 是 | `"1.1"` |
| `<html>` | `data-aspect` | 是 | `16:9`（默认）/ `4:3` / `3:4`（竖屏）/ `1:1`（方图） |
| `<html>` | `data-design-w` / `data-design-h` | 建议 | `1280` / `720`（16:9） |
| `<main>` | `data-wbp-deck` | 建议 | deck 容器 |
| `<section>` | `data-wbp-slide` | 是 | 一页一节 |
| `<section>` | `data-slide-id` | 建议 | 稳定唯一 id（`s1`、`s2`…） |
| `<section>` | `data-layout` | 可选 | 内容类型提示（`cover` / `kpi` / `bullets` / `chart` / `cta`），**仅供参考，不是版式模板**——不得据此套 PPT 母版 |
| `<section>` | `data-zone` | 建议 | `overview` / `data` / `logic` / `next`（四区结构） |
| `<section>` | `data-transition` | 可选 | `none` / `slide-left` / `slide-up` / `zoom` |
| 子元素 | `data-wbp-fragment` | 可选 | 页内分步揭示 |
| 子元素 | `data-wbp-no-advance` | 可选 | 单击该元素不翻页（交互区/链接/图表） |
| `<aside>` | `data-wbp-notes` | 建议 | 逐字稿（观众隐藏，演讲者展示）；兼容 `.slide-notes` / `[data-notes]` |
| `<script>` | `data-wbp-source` | 基线产物 | 该页 md 原料，供 agent 建版读取；**建版后必须删除**（见 §12） |

---

## 3. 四区结构（data-zone）

汇报 page 按叙事逻辑分为四区，每页 `data-zone` 标注归属：

| zone | 语义 | 典型内容 |
|---|---|---|
| `overview` | 概览结论 | cover 页 TL;DR、核心数字 |
| `data` | 关键数据 | KPI 卡、图表、增长曲线 |
| `logic` | 论证逻辑 | 原因分析、对比表、技术方案 |
| `next` | 下一步/风险 | 行动项、风险列表、CTA |

---

## 4. 页数与内容约束

- **不超框优先（核心）**：每张 slide 渲染为 16:9 定格（1280×720），内容**不得超出**。
  `md_to_html.py --format presentation` 按盒高预估**自动分页**——长 section 拆成多张续页，原料按条目跨页分配。因此**页数以"装得下"为准，可超过 8**；≤8 只是精简建议，不再强制合并。
  > 分页是**基于原料的预估**。agent 建版后若某页确实超高，可降密度/缩字号，或把该页原料再拆一页（拆页时复制外壳属性、给新 `data-slide-id`）。
- **最少内容**：md < 200 字 → 提示用户补充，不硬生成空架子（`md_to_html.py --format presentation` 已**强校验**：不足 200 字直接返回 `{"error":...}` 提示补充）
- **首页 `data-layout="cover"` + `data-zone="overview"`**，抛核心结论 / TL;DR
- **末页建议 `data-layout="cta"` + `data-zone="next"`**，给下一步或风险

---

## 5. 逐字稿规则

每页 `<aside data-wbp-notes>` 放口语化逐字稿，**目标 150-300 字**：

- 从 md 该 section 原文提炼核心论点 + 转场衔接
- **加粗**关键数字/术语作提示信号
- 不复读正文，而是口语化补充"怎么讲"

> **长度约定**：`md_to_html.py` 只产出**草稿逐字稿**（从该节正文提炼，长度随 md 内容而定，可能不足 150 字）；
> 150-300 字是 **agent 富化目标**——agent 应在脚本产物基础上把过短的逐字稿补足到该区间，脚本不强行凑字数。

**逐字稿富化**：逐字稿放 `<aside data-wbp-notes>`，agent 在脚本草稿基础上补足到 150-300 字/页。

### 5.1 可见性契约（唯一容器 + 恒隐藏）

逐字稿**只给演讲者看，永不出现在 slide 画面里**。可见性由播放器决定，html 侧只负责"装好并藏好"：

| 渲染态 | 逐字稿表现 |
|---|---|
| 浏览态（iframe 直接渲染，slide 竖直堆叠） | **不可见**，由基线 CSS `[data-wbp-notes] { display: none; }` 保证 |
| 演示态（播放器挂载） | 播放器从 `data-wbp-notes` **读文本渲染到自己的提词器面板**（演讲者端可见），观众投屏画面里没有 |

因此三条硬约束（富化阶段最易违反）：

1. **唯一容器**：逐字稿/演讲提示/口播稿**只能**放在 `<aside data-wbp-notes>` 内。
2. **禁止另建可见提示块**：不得把旁白写进正文 `<p>`、`<blockquote>`，也不得自建「演讲提示 / 演讲口播 / 备注」等**任何可见**的卡片、脚注、侧栏来承载它。
3. **恒隐藏 CSS 不可丢**：改写/重写 `<style>` 换肤时必须保留 `[data-wbp-notes] { display: none; }`，且不得用 `display:block`/`visibility` 等覆盖它。

---

## 6. 页内动画（.is-active CSS）

> **渲染上下文（关键，决定动画怎么写）**：本 html 在资料库页有**两种渲染态**——
> - **浏览态（默认）**：iframe **直接渲染 html**，所有 `<section data-wbp-slide>` **竖直堆叠成静态长页**，
>   **没有翻页、不会加 `.is-active`**（`.is-active` 只在演示态由 `MindxPresentation` 播放器添加）。
> - **演示态**：点「演示」按钮才挂载播放器，逐页翻页、为当前页加 `.is-active`、走过场动画。
>
> 因此 **绝不能用 `opacity:0` 预隐藏元素**——浏览态没有 `.is-active`，预隐藏会导致**整页白屏**
> （也会破坏 database 快照的无 SDK 兜底）。正确做法：**元素默认可见**，`.is-active` 只用来**重播入场动画**
> （翻到该页时再放一遍），离开/未激活时元素照常显示。

**缓动曲线**：标准入场用 `cubic-bezier(.4,0,.2,1)`；强调/弹出用带回弹的 `cubic-bezier(.22,1.3,.36,1)`。

**性能铁律（决定演示流畅度，务必遵守）**：入场动画只动 `transform` / `opacity`（GPU 合成器可加速）。
`filter: blur()` / `backdrop-filter` 每帧都要重新采样栅格化，是最贵的操作——**批量元素（段落、列表项、卡片、表格）的入场绝不能带 blur**，
一页十余个元素同时模糊动画必然掉帧。blur 类效果只允许用在**该页单个主视觉元素**上，且**不叠加无限循环动画**。

```css
:root {
  --ease: cubic-bezier(.4,0,.2,1);
  --ease-bounce: cubic-bezier(.22,1.3,.36,1);
}
/* 入场关键帧：升起(纯 transform+opacity，合成器加速) / 模糊聚焦(仅限单个主视觉) / 缩放弹出 */
@keyframes wbpRise   { from { opacity:0; transform:translateY(40px) scale(.985); }
                       to   { opacity:1; transform:none; } }
@keyframes wbpBlurIn { from { opacity:0; filter:blur(16px); } to { opacity:1; filter:none; } }
@keyframes wbpZoom   { 0% { opacity:0; transform:scale(.86); } 60% { transform:scale(1.03); }
                       100% { opacity:1; transform:scale(1); } }

/* 不要写 [data-wbp-slide] .xxx { opacity:0 } 之类的预隐藏——浏览态会白屏 */
/* 元素默认可见；仅 .is-active 时重播入场（动画 from 态自带 opacity:0，结束回到可见） */
/* 下面选择器用的类名是占位示例——换成你建版时实际用的类名。 */
/* 该页主视觉：可用 blur 聚焦（单个元素） */
[data-wbp-slide].is-active .是你的主视觉类 { animation: wbpBlurIn .8s var(--ease) both; }
/* 次级元素：纯 transform+opacity 升起 */
[data-wbp-slide].is-active .是你的次级类 { animation: wbpRise .55s var(--ease) .12s both; }
/* 同级批量元素：stagger 递进（每级 +0.08s） */
[data-wbp-slide].is-active .是你的条目类 { animation: wbpRise .5s var(--ease) both; }
[data-wbp-slide].is-active .是你的条目类:nth-child(1) { animation-delay:.12s; }
[data-wbp-slide].is-active .是你的条目类:nth-child(2) { animation-delay:.20s; }
[data-wbp-slide].is-active .是你的条目类:nth-child(3) { animation-delay:.28s; }
[data-wbp-slide].is-active .是你的条目类:nth-child(n+4) { animation-delay:.36s; }
/* 强调块（引语/图框等）：缩放弹出 */
[data-wbp-slide].is-active .是你的强调块类 { animation: wbpZoom .55s var(--ease-bounce) .1s both; }

@media (prefers-reduced-motion: reduce) {
  [data-wbp-slide] * { animation: none !important; }
}
```

> 单页同时启用的入场类型建议 ≤2 种（如「主视觉聚焦 + 同级元素 stagger」），混太多会乱。
> 持续型装饰动画（微光扫过、渐变流光）成本高且**无法合成器加速**（`background-position` 逐帧重绘），
> 若使用须满足：① 每页至多 1 处；② 播完即停（不写 `infinite`）；③ 不叠在已有 blur 的元素上。

---

## 7. 换肤接口（`:root` 变量清单）

> **美化职责归属**：本契约**不承载任何视觉设计规范**（排版 / 间距 / 配色 / 材质 / 阴影 / 背景 / 布局等）——那是 `beautify/beautify-guide.md` 的职责。本节只约定一件事：`md_to_html.py --format presentation` 产物在 `:root` 暴露哪些变量名，供建版阶段覆写。
>
> **基线值是占位灰，不是设计选择**：脚本把这些变量统一填为**无彩灰**（零色相零饱和），刻意不好看。
> **必须按 beautify 风格路由覆写**——保留占位灰交付 = 未美化。

**必须覆写的变量**：

| 变量 | 用途 |
|---|---|
| `--accent` / `--accent2` / `--accent3` | 品牌三色（强调、渐变、标记、CTA）；基线为同一个灰值 |
| `--accent-rgb` / `--accent2-rgb` / `--accent3-rgb` | 上述三色的 `R,G,B` 形式，用于半透明叠加的 `rgba()` |
| `--bg` / `--panel` | 页面底色 / slide 面板色 |
| `--text` / `--muted` | 正文文字色 / 次要文字色 |

**不要改（属时序契约，非配色）**：`--ease` / `--ease-bounce`（入场动画缓动，见 §6）。

> 配色的具体选择、渐变构成、材质半透明度、表面色等**全部由 beautify 决定**（基线不预设 `--grad`/`--surface` 之类的复合视觉变量，需要就自己定义）。覆写时须遵守 §7.10.3 的外壳与时序约束。
>
> 下一节 §7.10 是**建版总纲**（与换肤并列，不是其附属）：逐张怎么把原料排成版面、16:9 如何适配、哪些是红线。

## 7.10 逐张建版（操作指引 + 安全红线）

> **本节定位**：`--format presentation` 产物是**空框架**——每张 slide 只有外壳、不可见的内容原料和逐字稿槽，**页内没有任何可见 DOM**（见 §12）。agent 的工作是逐张把原料排成版面。
> **版面语言不在本契约**：每一页的排版设计**一律按 `beautify/beautify-guide.md` 执行**（板块语义、5 级排版、间距节奏、视觉技法、反 AI 味红线）。本节只回答两件事：一张的边界在哪（§7.10.1）、装进 16:9 时要注意什么（§7.10.2 / §7.10.3）。

### 7.10.1 「逐张」是什么：一张 slide 的框架与你要填的部分

**「一张」= 一个 `<section data-wbp-slide>`**（渲染为 1280×720 定格）。基线产出的每张只有三部分：

```
<section data-wbp-slide data-layout="…" data-zone="…" data-transition="…">   ← 外壳：属性与外部尺寸不可动
  <script type="text/markdown" data-wbp-source>…该页 md 原料…</script>       ← 原料：读它，用完删除
  <aside data-wbp-notes>…逐字稿…</aside>                                     ← 逐字稿槽：隐藏，不可动
</section>
```

**逐张建版 = 读原料 → 在外壳内写出页面 DOM → 删掉该页 `<script data-wbp-source>`**。
原料是 markdown 片段。它带 `data-wbp-source` 标记，基线 CSS 已让它不渲染；
**建版后必须逐页删除**——残留即视为该页未建版（见 §12 硬门）。

### 7.10.2 每一页按杂志网页排版，而非 PPT 版式

**心智模型**：把每张 slide 当作**一屏独立的杂志级网页**（首屏刚好 1280×720），而**不是**一张幻灯片。
版面决策全部走 `beautify/beautify-guide.md`：按内容结构选其**板块语义**（`DocHero` / `RichParagraph` / `DataHighlight` / `QuoteBlock` / `TimelineList` / `ComparisonGrid` / `ImageFrame` …），套其 5 级排版、8px 间距节奏、视觉技法与板块视觉增强指南；其「反模式红线」与「内容处理原则（重排版优先）」同样全部适用——包括**允许压缩、提炼、重排原料**，不做复印机。

**16:9 定格带来的三点适配**（这是本契约唯一要补充的，其余全听 beautify）：

| beautify 里的写法 | 在单页 slide 内怎么落地 |
|---|---|
| 「首屏在 100vh 内完整呈现」 | 这里的"首屏" = 该 slide 的 1280×720 盒；每页都是一个首屏 |
| 章节间距 64~96px、多 section 纵向铺陈 | 一页只承载**一个**内容单元，纵向节奏压缩到盒内；跨页的连续背景/滚动叙事不可用（§7.10.3 红区5） |
| 正文 14~16px、单屏 3~5 个信息单元 | 投屏观看距离远，正文可上浮到 18~22px；单页信息单元建议 2~4 个，密度低于长页 |

**每页自检两条**：
1. **不是 PPT**：该页若抽掉外壳单独看，应像一屏精心排版的网页首屏，而不是"标题 + 项目符号列表"。
2. **页页不同**：相邻页的板块语义与版面结构不得雷同。

### 7.10.3 安全红线

> **约束只有两类**：**外壳**（尺寸 + data 属性，播放器靠它翻页缩放）和**时序**（`.is-active` / 不预隐藏 / 不写 JS，决定浏览态不白屏、演示态不卡顿）。
> **slide 内部的一切排版**——`display`、布局方式、内边距、层叠、栅格——**都不受约束，可完全重写。**
>
> **一句话口诀**：**锁外壳与时序，页内随便排。**

**✅ 绿区（可自由发挥）**

| 维度 | 可做 |
|---|---|
| 配色/主题 | 覆写 `:root` 的 `--accent`/`--accent2`/`--accent3`/`--bg`/`--panel`/`--text`/`--muted`（见 §7 换肤接口，这是换肤唯一正道） |
| 字体 | 引入白名单域 webfont（fontsource via `cdn.jsdelivr.net`，中文限单字重）、改 `font-family`/字重/字间距/`clamp()` 字号 |
| **页内布局机制** | **自由重写 slide 内部的 `display`（`grid`/`flex`/`block`）、`grid-template`、`flex-direction`、对齐方式、层叠（`position:absolute` + `z-index`）**——只要该页最终渲染仍在 1280×720 内 |
| **页内内边距 / 出血** | **自由改 slide 的 `padding`**（含改成 `0` 做**满幅出血**：通栏底图、左侧色块通栏、图片出血到边缘） |
| 单页盒内网格 | Bento Grid、卡片网格、分栏、非对称布局——**在单页盒内均允许**（只要不溢出，见黄区高度约束） |
| 卡片材质 | 发光边框、多层阴影、内高光、半透明填充 |
| 局部渐变/点缀 | 序号/项目符号品牌渐变、标题侧渐变条、引用块左边框（静态渐变，不做无限流光） |
| 入场动画 | 在**现有 `.is-active` 钩子内**（见 §6）追加/调整 keyframe，保持"默认可见、`.is-active` 只重播"铁律；**只动 `transform`/`opacity`** |
| 数据/图表 | 表格描边、数字用等宽字体、mermaid 主题变量（随 `:root` 走） |

**⚠️ 黄区（限制条件下可做，需目测不溢出）**

| 维度 | 条件 |
|---|---|
| 高密度页内布局 | 任意页内布局都必须**目测该页渲染高度 ≤720px**；超了就降密度、缩字号或拆页 |
| 盒内背景光晕 | 光晕须**限制在 slide 盒内**（`overflow:hidden` + 盒内径向渐变），不得溢出到 slide 之外的页面底色 |
| 毛玻璃 `backdrop-filter` | 每页**至多 2 处**，且该元素**不得同时挂入场动画**（模糊 + 动画同帧 = 逐帧重采样，必掉帧）。要卡片质感优先用半透明填充 + 边框高光 + 阴影替代 |

**⛔ 红区（绝对禁止，破坏播放器契约）**

1. 不删/不改 `<html data-wbp ...>` 根标记及 `data-aspect`/`data-design-w`/`data-design-h`（见 §1）。
2. **不改 slide 的外部渲染尺寸**：每个 `[data-wbp-slide]` 最终必须是 **1280×720 的独立定格**，内容不溢出。
   （只锁"外部尺寸"这一点。slide **内部**的 `display`/`padding`/布局机制不在此限，见绿区。）
3. 不预隐藏元素：禁止静态 `opacity:0` / `clip-path:inset(0 100%…)` 等"藏起来只靠动画显形"的写法——浏览态无 `.is-active` 会**整页白屏**（见 §6）。
4. 不删/不动 `data-layout`/`data-zone`/`data-transition`/`<aside data-wbp-notes>`/`#wbp-meta`；不得丢掉 `[data-wbp-notes] { display: none; }`，也不得把逐字稿挪出 `<aside>` 或另建可见的「演讲提示」块（见 §5.1）。
5. **不做跨页 / 依赖滚动的布局**：多屏 Zig-Zag 交替、`100vh` 全屏 Hero、跨 slide 连续背景、依赖页面滚动位置的效果（视差、`position:sticky`、滚动驱动动画）——每页必须能独立成立。
   （单页盒内的 Bento / 网格 / 出血**不属于**此项，允许。）
6. 不写掉帧动画：批量元素（段落 / 列表项 / 卡片 / 表格等同级多元素）入场**不得带 `filter: blur()`**；不得给任何元素写 `infinite` 循环动画；不得在挂了 `backdrop-filter` 的元素上再加入场动画（见 §6 性能铁律）。

**建版后自检**

> 美化质量本身按 `beautify/beautify-guide.md`「美化质量自检清单」逐条过；下面只列**翻页档特有**的检查项。

- [ ] **每页都已建版**：全部 `data-wbp-slide` 内已有可见 DOM，**且已无 `data-wbp-source` 残留**（grep `data-wbp-source` 应为 0 命中）。
- [ ] **不是 PPT**：任取一页单独看，是"一屏杂志级排版网页"而非"标题 + 项目符号列表"。
- [ ] **页页不同**：相邻页的板块语义与版面结构不雷同。
- [ ] **配色已覆写**：`:root` 的 `--accent`/`--bg`/`--panel` 等已按 beautify 风格路由改为实际配色，**无占位灰残留**（产物中不应再出现基线灰值 `#8f8f8f` / `#121212` / `#1c1c1c`）。
- [ ] 无静态预隐藏元素（无 `opacity:0` / `clip-path` 藏元素），浏览态每页可见。
- [ ] 每页渲染仍是 1280×720 独立定格，内容未溢出；无跨页 / 依赖滚动的布局。
- [ ] **动画不掉帧**：批量元素入场只有 `transform`/`opacity`（grep 确认入场 keyframe 无 `blur`）；无 `infinite` 动画；`backdrop-filter` ≤2 处/页且未与入场动画同元素。
- [ ] **逐字稿未外泄**：每页逐字稿仍在 `<aside data-wbp-notes>` 内，`[data-wbp-notes] { display: none; }` 仍在，页面上看不到任何「演讲提示 / 口播稿」文字（见 §5.1）。
- [ ] `data-wbp` 根标记、`data-layout`/`data-zone`、`<aside data-wbp-notes>` 均保留完好。
- [ ] **内容忠于原料**：页面文字来自原料（允许按 beautify 内容处理原则压缩/重排），未新增原料没有的结论/数据（见 §8）。

---

## 8. 防捏造 / 来源溯源

- 无出处数据 → 文案「待补充」+ 属性 `data-wbp-todo`，**不要编**：
```html
<div class="kpi-num" data-wbp-todo>待补充</div>
```
- 关键数字/结论来源登记在 meta JSON 岛 `slides[].sources`

---

## 9. database 绑定标注

仅当演示档作为**动态数据页**（走 `data-page-flow.md`，数据来自 database）时适用：按 `data-page-flow.md` §1.5.5 对文本直接来自或间接派生自 database 的元素加 database 绑定标注。演示档典型命中元素：slide 标题、正文段落 / bullets、KPI 数字（间接派生）、图片 `<img>`。

> 纯静态演示档（md→html 分支，`import_html.py` 直接导入、不接 database）无需此标注。

---

## 10. Do / Don't 速查

**Do**
- 一页一个 `<section data-wbp-slide>`，给稳定 `data-slide-id`
- 逐张读原料建版，每页按 `beautify/beautify-guide.md` 做成**一屏杂志级排版网页**（见 §7.10、§12）
- 首屏先抛结论（`data-zone="overview"`）
- 页内动画用 `.is-active` CSS，分步用 `data-wbp-fragment`
- 逐字稿放 `<aside data-wbp-notes>` 且保持隐藏（150-300 字/页，见 §5.1）
- `prefers-reduced-motion` 降级必做
- 每页渲染为 1280×720 独立定格，不超框
- 建版后删除全部 `data-wbp-source` 原料（见 §12）
- 无出处数据标 `data-wbp-todo`，显示「待补充」
- 动态数据页中来源于（含统计派生）database 的元素按 `data-page-flow.md` §1.5.5 加绑定标注（静态演示档免）

**Don't**
- 写翻页 / 分步 / 自动播放的 JS（容器职责）
- 把演讲者旁白写进正文，或另建可见的「演讲提示」块（见 §5.1）
- **把页面做成传统 PPT**：标题 + 项目符号列表、居中大标题配三列等宽卡、母版式统一版式
- 让相邻页版面雷同
- 把 `data-layout` 的值当版式模板照做（它只是内容类型提示）
- 留下 `data-wbp-source` 原料未删（= 该页未建版）
- 超出 1280×720 定格，或做跨页 / 依赖滚动的布局
- 捏造没有出处的数字
- 破坏 §7.10.3 的外壳与时序约束（改外部尺寸 / 预隐藏元素 / 掉帧动画）

---

## 11. meta JSON 岛（可选）

```json
{
  "title": "Q2 增长复盘",
  "audience": "boss",
  "scene": "report",
  "slideCount": 4,
  "slides": [
    { "id": "s1", "layout": "cover", "zone": "overview", "title": "核心结论", "sources": ["source.md#L1"], "todos": [] },
    { "id": "s2", "layout": "kpi", "zone": "data", "title": "核心指标", "sources": [], "todos": [] }
  ]
}
```

---

## 12. 基线产物形态与建版契约

> **为什么基线不出页内内容**：只要脚本给出了页内 DOM 与排版 CSS，建版就退化成"在既有版式上换个颜色"，每页必然雷同、且必然带 PPT 味。因此脚本**只出框架**，版面设计完整交给 agent 按 `beautify/beautify-guide.md` 执行。
>
> **定位一句话**：本契约只保证 html **外层框架适配演示模式**（可翻页、16:9、有提词器）；**每一页的内容形态是杂志级排版网页**，不是幻灯片。

**基线产物（`md_to_html.py --format presentation`）只包含**：

1. 根标记 `<html data-wbp …>`、`<main data-wbp-deck>`、`#wbp-meta`；
2. 每张 `<section data-wbp-slide>` 外壳（含 `data-slide-id`/`data-layout`/`data-zone`/`data-transition`）；
3. 每张内的 `<script type="text/markdown" data-wbp-source>`：该页 md 原料（**不渲染**）；
4. 每张内的 `<aside data-wbp-notes>`：草稿逐字稿（隐藏）；
5. 框架级 CSS：`:root` 变量（值为**无彩占位灰**）、slide 盒的 1280×720 定格、`[data-wbp-notes]`/`[data-wbp-source]` 隐藏、`.is-active` 动画关键帧与 `reduced-motion` 降级。
   **不含**任何页内元素排版样式，也**不含**任何配色 / 材质 / 圆角 / 间距体系等设计决策。

**agent 建版流程（逐张）**：

1. 按 `beautify/beautify-guide.md` 风格路由定本篇气质与配色，**覆写 `:root`**（占位灰必须换掉）。
2. 取该 slide 的 `<script data-wbp-source>` 文本（markdown 片段）。
3. 按 guide 为该页选板块语义、定排版与视觉，在该 slide 内写出可见 DOM（§7.10.2 的 16:9 适配同时生效）。
4. 需要的样式写进 `<style>`（可自定义类名），遵守 §7.10.3。
5. 补足该页 `<aside data-wbp-notes>` 逐字稿到 150-300 字（见 §5）。
6. **删除该页 `<script data-wbp-source>`**。
7. 全部页处理完 → 过 beautify 的「美化质量自检清单」+ §7.10「建版后自检」。

**硬门（可机器验证）**：
- `data-wbp-source` 命中数必须为 **0**，且每个 `data-wbp-slide` 内必须有可见 DOM；
- `:root` 中**不得残留基线占位灰**（`#8f8f8f` / `#121212` / `#1c1c1c`）。

残留原料、存在空 slide、或配色仍是占位灰 → **该产物未完成建版，不得导入**。
