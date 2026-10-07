---
name: pan-zoom-viewer
description: Build or fix an image/canvas viewer with fit-to-container default view, wheel zoom, drag pan, and a reset (home) button — and diagnose the two non-obvious browser pitfalls that break it. Use when asked to add 滚动缩放 / 拖动移动 / 自适应全图预览 / 恢复默认大小 to an image preview, when a zoomable viewer drifts off-center or clips one side, or when a button inside a pan/gesture container appears to do nothing (click swallowed by pointer capture).
agent_created: true
---

# 缩放 / 平移 查看器

## 何时用

- 需求形如「图片支持滚轮缩放、拖动移动位置、默认自适应全部预览、有个主页按钮点击恢复默认大小」。
- 已有的图片预览**默认偏了**：整体右移/下移、一侧被裁。
- 查看器里放了个按钮（主页、下载、全屏）但**点了没反应**，而代码里 `onClick` 明明接对了。

## 核心模型：三个变量搞定

```
manual = false                 // 用户是否已手动操作
fitScale = min(1, W_stage/W_img, H_stage/H_img)   // 自适应倍数
activeScale = manual ? scale : fitScale           // 实际生效的倍数
```

- **`min(1, ...)` 很关键**：小图只缩不放，否则一张 32×32 图标会被拉满容器糊成马赛克。
- `manual === false` 时一切**跟随** `fitScale`：窗口 resize、切换文件、换图都自动回到「看得全」。不需要在每处手动调 —— 这是「默认自适应」的干净实现，别用一堆 `reset()` 调用去凑。
- 下限就是 `fitScale`（比「看得全」更小没有信息增量，只会让用户多点几下滚轮才能回到默认）。
- 上限给个明确倍数（如 `max(fitScale, 8)`），别不设限。

## 坑一：位置由显式 transform 算，绝不借容器的居中

**症状**：默认视图下图片整体偏移，一侧被裁。真实案例：720×400 的图放进 592 宽的预览区，**右移 65px**，左侧切掉。

**根因**：滚动/溢出容器上的 `place-items: center` / `align-items: center` / `justify-content: center`，在**子项比容器大**时会被浏览器静默降级为「起点对齐」（否则内容不可达）。这不是配置错误，是布局算法的兜底行为 —— 只在特定尺寸组合下出现，排查成本极高。

**修法**：图片绝对定位，位置全部由 transform 自己算：

```js
// transform-origin: 0 0 必须配合，否则缩放中心会漂
transformOrigin: '0 0',
transform: `translate(${stageW / 2 + offsetX}px, ${stageH / 2 + offsetY}px) scale(${activeScale}) translate(${-imgW / 2}px, ${-imgH / 2}px)`
```

读法：先把原点挪到容器中心 → 缩放（围绕该点）→ 再把图片自身中心挪到该点。缩放中心永远精确落在图片中心。

配套 CSS：

```css
.viewer { position: relative; width: 100%; height: 100%; overflow: hidden; cursor: grab; touch-action: none; }
.viewer.panning { cursor: grabbing; }
.viewer img { position: absolute; top: 0; left: 0; max-width: none; max-height: none; user-select: none; -webkit-user-drag: none; }
```

`max-width/max-height: none` 是必须的 —— 否则宿主的 `img { max-width: 100% }` 会和 transform 打架。

尺寸未量到前置 `opacity: 0`，量到后加 `.measured` 淡入，避免首帧闪一下错位。

## 坑二：`setPointerCapture` 会改派 `click`，吞掉内部按钮

**症状**：查看器里的按钮「点了没反应」。真实案例：主页按钮真实点击 `125% → 125%` 纹丝不动；但 `element.click()` 直接派发却正常 `218% → 82%`。

**这个对比就是判据**：`el.click()` 有效、真实鼠标无效 ⇒ 事件根本没送到按钮上（而不是回调逻辑错）。

**根因**：按钮的 `pointerdown` 冒泡到查看器 → `startPan` 在**查看器**上 `setPointerCapture` → 指针捕获生效后，后续 `click` 被改派到**捕获元素**（查看器）而不是按钮，按钮的 `@click` 永远收不到。

**修法**（一行守卫）：

```js
function startPan(event) {
  // ...前置校验
  if (event.target?.closest('.viewer-toolbar')) return   // 工具栏上的按下是点按钮，不是拖图
  panStart = { x: event.clientX, y: event.clientY, ... }
  panning = true
  target.setPointerCapture?.(event.pointerId)
}
```

**通例**：凡是「容器接管指针手势（拖拽/画笔/框选）+ 内部有可点元素」的结构，都要加这道守卫。工具栏给个稳定的类名（`.viewer-toolbar`）便于 `closest`。

## 手势细节

**滚轮缩放要在光标处**，否则放大时想看的细节会跑出视野：

```js
event.preventDefault()                       // 预览区内滚轮只用来缩放，不冒泡滚页面
const pointerX = event.clientX - rect.left - rect.width / 2
const next = clamp(prev * (event.deltaY < 0 ? 1.15 : 1 / 1.15), fitScale, maxScale)
const ratio = next / prev
const offset = clampOffset(pointerX - ratio * (pointerX - baseX), pointerY - ratio * (pointerY - baseY), next)
```

**平移边界**：只有图片比容器大才允许移动，且不允许把任何一条边拖进容器内部：

```js
limitX = Math.max(0, (imgW * scale - stageW) / 2)
offset.x = Math.min(limitX, Math.max(-limitX, x))
```

`Math.max(0, ...)` 保证图小于容器时位移恒为 0（点一下不会把自适应视图带偏）。

**只在真正拖动后才进手动模式**，避免一次误触/单击就把「自适应」顶掉：

```js
if (offset.x === 0 && offset.y === 0 && !manual) return
manual = true
```

**容器尺寸变化**用 `ResizeObserver` 收敛：未手动 → 重新跟随 `fitScale`；已手动 → 把越界的平移拉回来。`onBeforeUnmount` 里 `disconnect()`。

## 浏览器验证探针（必做）

布局与手势 happy-dom / jsdom 测不出来，必须浏览器实测数字。用 `playwright-cli`：

```js
() => {
  const v = document.querySelector('.viewer'), im = v.querySelector('img')
  const vr = v.getBoundingClientRect(), ir = im.getBoundingClientRect()
  return JSON.stringify({
    zoom: document.querySelector('.viewer-toolbar small').textContent,
    dx: Math.round((ir.left + ir.width / 2) - (vr.left + vr.width / 2)),   // 期望 0
    dy: Math.round((ir.top + ir.height / 2) - (vr.top + vr.height / 2)),   // 期望 0
    limitX: Math.round((ir.width - vr.width) / 2),
    limitY: Math.round((ir.height - vr.height) / 2),
  })
}
```

逐项要拿到的数字：

1. **默认视图** `dx=0, dy=0`，`zoom` 等于 `fitScale` 的百分数。
2. **滚轮** `zoom` 变化、图片宽度按比例变化。
3. **光标锚定**：记录光标点相对图片左上角的归一化坐标 `(px, py)`，连滚两档，**该坐标必须不变**（实测稳定在 `0.3528/0.1907`）。
4. **拖动** `dx/dy` 与鼠标位移精确一致。
5. **越界**：大幅拖 → 钳在 `±limitX / ±limitY`，反向对称。
6. **缩放下限**：狂滚向下停在 `fitScale`，且 `dx=dy=0`。
7. **主页复位**：真实鼠标点击（`pointerdown` + `pointerup`，不是 `el.click()`）→ 回到 `fitScale` 且居中。
8. **切文件复位**：放大+拖移后换一张图，新图应自适应居中。
9. 控制台 0 error / 0 warning。

> `mouse.wheel` / `mouse.move` 在多次独立的 CLI 调用之间**鼠标位置不保持**。把 `move` 和 `wheel` 放进**同一次** `run-code` 里，否则滚轮打不到元素上（实测 zoom 纹丝不动）。

## 单元测试能挡什么

happy-dom 里 `getBoundingClientRect()` 全为 0、`naturalWidth` 也为 0，**真实几何测不了**。但两件事值得写成门禁：

- **接线**：把 `naturalWidth/naturalHeight` 用 `Object.defineProperty` 定义好，`dispatchEvent(new Event('load'))` 触发量尺寸；然后 `trigger('wheel', { deltaY: -120 })` 断言百分比变了、点按钮断言回到基准值。
- **坑二的守卫**（关键）：`await wrapper.get('.viewer-toolbar button').trigger('pointerdown', {...})` 后断言容器**没有** `panning` 类；再反向断言直接在图容器上按下**必须有** `panning` 类（防止守卫写宽）。撤掉守卫这条会红 —— 已验证有效。

## 交付前清单

- [ ] 默认视图 `dx=dy=0`，小图不被放大
- [ ] 滚轮在光标处缩放，下限=自适应值
- [ ] 拖动位移精确，边界钳在 `±limit`
- [ ] 主页按钮**真实点击**生效（不是 `el.click()`）
- [ ] 工具栏 `pointerdown` 不触发 panning
- [ ] 容器 resize 后自动收敛
- [ ] `ResizeObserver` 在卸载时断开
- [ ] 控制台零报错
