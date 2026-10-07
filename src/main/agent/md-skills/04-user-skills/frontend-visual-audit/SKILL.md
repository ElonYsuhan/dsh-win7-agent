---
name: frontend-visual-audit
description: Audit and fix "these spots look bad / the text styling is off / would flat icons fit better" feedback on a web UI. Use when a user circles regions in a screenshot or complains about typography, icon consistency, chip/badge styling, or border radii being inconsistent. Covers the measurement probes that replace guessing, the naive-ui font-stack trap, and the text-glyph-as-icon root cause.
agent_created: true
---

# 前端视觉整备（按截图定点）

## 何时用

用户发来一张截图、圈了几处，说「这几个地方不好看」「文字样式不好看」「是不是用图标更好」。目标：**别靠眼看**，先拿到实际生效的数值，再决定改什么。

## 第一步：把截图放大到能看清字形

截图常被缩放，肉眼判断会错。用 Pillow 按区域裁剪 + 4–12x 放大（LANCZOS）：

```python
from PIL import Image
im = Image.open('/tmp/shot.png')
for name, (l, t, r, b) in {'header': (0,0,480,62), 'steps': (560,0,1060,62)}.items():
    c = im.crop((l,t,r,b)); w,h = c.size
    c.resize((w*4, h*4), Image.LANCZOS).save(f'/tmp/crop-{name}.png')
```

放大倍率按区域宽度调：窄元素（数字圆标、图标）用 10–12x，整条顶栏用 4x。
**先用浏览器 `eval` 拿到元素的 `getBoundingClientRect()` 再裁**，坐标靠猜会连续裁空。

## 第二步：量化，不要眼看

一次 `eval` 把要判定的东西全捞出来：

```js
() => {
  const g = el => el ? getComputedStyle(el) : null
  const btn = document.querySelector('.topbar .n-button')
  const tag = document.querySelector('.stage-summary .n-tag')
  return JSON.stringify({
    // 字体：注意 body 上写的和组件实际用的常常不是一回事
    bodyFont: g(document.body)?.fontFamily,
    btnFont: g(btn)?.fontFamily,
    // 圆角/字重：同屏出现几套值就是问题
    btnRadius: g(btn)?.borderRadius, btnWeight: g(btn)?.fontWeight, btnSize: g(btn)?.fontSize,
    tagBg: g(tag)?.backgroundColor, tagBorder: g(tag)?.borderColor, tagRadius: g(tag)?.borderRadius,
  })
}
```

判读要点：

- **圆角/字号/字重出现 2 套以上**就是「毛糙」的直接来源。
- **tag 背景近白 + 边框近黑 + 圆角 ≤2px** = 看着像坏掉的输入框。这是 `type="default"` 的默认描边态，改成实心（`round` + `:bordered="false"`）即可。
- 全站 `font-weight: 550 / 650` 会让中文通体半粗，降到 `500 / 600` 明显干净。

## 第三步：两个高频根因

### 根因 A：字体栈被 UI 库静默覆盖（naive-ui 必踩）

写了 `body { font-family: Inter, "PingFang SC", ... }`，但组件实际是 `v-sans, system-ui, ...`。

naive-ui 的 `NConfigProvider` 会把 `common.fontFamily` 注入到**每个组件**上，CSS 里给 `body` 设的字体对它们**完全无效**。`v-sans` 是它内部的 token 名而不是真字体名，于是落到 `system-ui` —— 项目想用的字体一次都没生效过。

修法：在 `theme-overrides` 里显式声明。

```ts
const FONT_FAMILY = 'Inter, "PingFang SC", "Microsoft YaHei", -apple-system, "Helvetica Neue", Arial, sans-serif'
const overrides = { common: { fontFamily: FONT_FAMILY, borderRadius: '8px', borderRadiusSmall: '6px' } }
```

naive 默认 `borderRadius: 3px` / `borderRadiusSmall: 2px`，与自定义控件（7–10px）差得太远，一并覆盖。

验证字体是否真装上：`document.fonts.check('16px Inter')`。注意「装了」≠「用上了」。

### 根因 B：所谓「图标」其实是文字字符

盘点这类字符，它们就是「文字样式不好看」的元凶：

```
← → ↑ ↓ ＋ ✦ ▧ ◇ □ ⌂ ⌘ ☾ ☀ ✓ ✕ × ▾ ✓ ! M↓ ···
```

为什么难看：

- 字形随字体走，字体一换就变形；
- 粗细由字重决定，和真正的图标对不上；
- 有固有内边距（`＋` U+FF0B 是全角）与基线偏移，垂直居中对不齐；
- 某些平台会被 emoji 字体接管。

**一律换成线性图标**。本项目用 `@vicons/ionicons5`：

```ts
import HomeIcon from '@vicons/ionicons5/es/HomeOutline'   // 必须深路径
```

**深路径是硬要求**：根入口 `@vicons/ionicons5` 会连带 transform 1334 个图标模块，开发态每次冷启动都要为它们做一遍转换。

配套调整：图标容器不要再用 `place-items: center` + `font-size`（那是给文字预留的），改 `inline-flex` 居中；颜色统一「静默 muted / 激活与悬停才给强调色」。

## 第四步：分清「缺陷」与「刻意设计」

别把所有不一致都当 bug 改掉，会破坏设计意图。判断依据：**这个值是否在项目里有统一的一套 token？**

- 字号阶梯（如 `--font-micro/xs/sm/md` = 13/14/15/16px）是刻意设计 → 不要动。
- 圆角在同一屏有 3px 和 8px 两套且来源不同（库默认 vs 手写）→ 是缺陷。
- **属于用户数据的内容不要改**：例如产品配置里持久化的 `icon: '◇'`、随产品文档落盘的 Ribbon 图标 —— 改它等于改用户的内容与存储数据。改动前先确认这个值是「框架 chrome」还是「用户数据」。

## 第五步：验证（必做）

1. 门禁：`vue-tsc` / `eslint` / `vitest` 全跑，确认无回归。
2. **改文案或改成图标会打断按文本断言的测试**。做法是**保留测试意图、换断言目标**，不是删测试：
   `expect(wrapper.text()).toContain('更多')` → `expect(wrapper.find('button[aria-label="更多"]').exists()).toBe(true)`
3. **深浅两态都要看**。只验浅色是最常见的漏检。
4. 改主题开关会写进草稿并落盘 → 验完切回原值并确认文件里的值已还原。
5. 出前后对比图给用户看：按区域裁剪同框上下拼接，比口头描述有效得多。

## 第六步：当抱怨是「好乱 / 叠在一起 / 挤」时（布局类，不是排版类）

前五步解决的是字体、图标、圆角这类「毛糙」。如果用户说的是**乱、遮挡、挤**，根因通常在布局，先量化再说。

### 6.1 重叠面积要算出来，别眼看

```js
() => {
  const R = s => { const e=document.querySelector(s); if(!e) return null; const b=e.getBoundingClientRect(); return {l:b.left,t:b.top,r:b.right,b:b.bottom,w:b.width,h:b.height} }
  const ov = (a,b) => (a&&b) ? Math.max(0,Math.min(a.r,b.r)-Math.max(a.l,b.l)) * Math.max(0,Math.min(a.b,b.b)-Math.max(a.t,b.t)) : 0
  return JSON.stringify({ toolbar:R('.toolbar'), dock:R('.dock'), viewCard:R('.view-card'),
    dockVsToolbar: ov(R('.dock'),R('.toolbar')), dockVsViewCard: ov(R('.dock'),R('.view-card')),
    toolRows: new Set([...document.querySelectorAll('.toolbar button')].map(b=>Math.round(b.getBoundingClientRect().top/8)*8)).size })
}
```

`overlap > 0` 就是真缺陷。两个面板各自 `position: absolute` 锚**同一个角**= 必叠。

### 6.2 三个高频根因

- **两块面板锚同一角 + 百分比 max-height**：`top:56px; max-height:56%` 与 `bottom:14px; max-height:58%` 在窗口变矮时**必然相交**（实测 1280×720 下重叠 92px）。
  修法：合成**一个 flex column 覆盖层**，让面板流式排布，而不是各自绝对定位堆叠。
- **`left: 50%` 的绝对定位元素宽度被砍半**：绝对定位的收缩宽度 = 包含块宽度 − left，所以「居中工具栏」在窄屏只拿到一半宽度 → 7 个按钮被逐个压成**竖排文字**。
  修法：`left:12px; right:12px; display:flex; justify-content:center` + 内部 `flex-wrap: wrap` + `button { white-space: nowrap }`。
- **`overflow-y: auto` 会连带把 `overflow-x` 计算成 `auto`**：内容 min-content 超出容器就横滚 / 裁切（外面看不见原因，只看到文字被切掉）。
  修法：容器 `grid-template-columns: minmax(0,1fr)` + 子项 `min-width: 0`。

### 6.3 覆盖层必须放行指针事件

铺满舞台的覆盖层要 `pointer-events: none` + `> * { pointer-events: auto }`，否则地球/画布的交互全被挡住。验证：

```js
() => { const s=document.querySelector('.stage').getBoundingClientRect(); return document.elementFromPoint(s.left+s.width*0.7, s.top+s.height*0.35)?.tagName }  // 期望 CANVAS
```

### 6.4 深色页面里的「白块」：色常画在内层元素上

别只看组件根。把面板里所有**不透明且偏亮**的背景元素全列出来：

```js
() => [...document.querySelectorAll('.panel *')].filter(e => {
  const c = getComputedStyle(e).backgroundColor; const m = c.match(/\d+(\.\d+)?/g); if (!m) return false
  if (c.startsWith('rgba') && +m[3] < 0.5) return false
  return (+m[0]*.299 + +m[1]*.587 + +m[2]*.114) > 170
}).map(e => [e.className.toString().slice(0,44), getComputedStyle(e).backgroundColor])
```

实测命中 `.n-base-selection-label` = `rgb(255,255,255)`，而外层 `.n-base-selection` 是 `rgba(0,0,0,0)` —— **只覆盖外层无效**。判定标准：这个列表归零。同源的还有 `.n-base-loading`、`.n-base-clear`。

### 6.5 验证要回到触发问题的窗口尺寸

拉宽窗口会掩盖窄屏的换行与遮挡。至少验两个：用户的窗口尺寸 + 一个更窄的（如 1024×660）。

## 坑

- 截图的 4x 放大对比图**必须叠加同倍率**，否则视觉差异来自缩放而非改动。
- Bash 的 `grep` 在部分环境会**静默失配**（返回空而不报错），会让人误判「没找到」。用内置 Grep 工具。
- PIL 默认字体渲染不出中文，需要指定 `/System/Library/Fonts/Hiragino Sans GB.ttc` 这类 CJK 字体。
- `devicePixelRatio` 会让 `getBoundingClientRect()` 与截图像素对不上，裁图坐标要用 CSS px × 截图缩放比换算，或干脆先 `resize` 到固定视口再截。
- 用「按钮 top 值去重」判断工具栏行数会**误判**：亚像素差异会让同一行出现 123 与 124 两个值。要么按 8px 取整，要么直接看容器高度。
