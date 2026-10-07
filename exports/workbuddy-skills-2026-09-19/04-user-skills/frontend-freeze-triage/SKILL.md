---
name: frontend-freeze-triage
description: Locate and prove the cause of "clicking X freezes the browser" style front-end hangs. Use when a page/tab becomes unresponsive after an interaction (clicking a file, opening a preview, switching tabs), when a UI action takes seconds instead of milliseconds, or whenever you need a measured number (blockedMs) rather than a guess about why a web UI janks. Covers the measuring harness and the most common root-cause class (stale async content rendered against a newly changed UI state).
agent_created: true
---

# 前端卡死定位

## 何时用

用户说「一点就卡住 / 卡死 / 转圈没反应 / 页面冻住」，或某个交互明显比预期慢。目标不是猜，而是**先拿到一个可对比的数字**，改完再拿同一个数字对比。

## 前置：拿到 playwright-cli

浏览器自动化优先用 `playwright-cli`（Chromium 缓存通常已在 `~/Library/Caches/ms-playwright`，不必重新下载）。它常不在 PATH 上，先找：

```bash
command -v playwright-cli || ls ~/.nvm/versions/node/*/bin/playwright-cli
# 找到后固定住，后面每条命令都用绝对路径
PCLI=~/.nvm/versions/node/<ver>/bin/playwright-cli
```

若项目用 pnpm，它常和 playwright-cli 在同一个 nvm bin 目录里：

```bash
export PATH="$(dirname "$PCLI"):$PATH"
```

## 第一步：量化阻塞，别靠感觉

思路：装 `longtask` 观察器 → 记 `performance.now()` → 触发交互 → 用**双 requestAnimationFrame** 等布局+绘制落地 → 报差值。单靠 `setTimeout(0)` 测不到布局开销，双 rAF 才能覆盖到卡死的真正大头。

把探针写成文件再传进去，避免 shell 引号地狱（JS 里只用单引号，文件里别出现 `$` 和反引号）：

```bash
$PCLI eval "$(cat /tmp/probe.js)"
```

探针模板（改 `TARGET_TEXT` 和选择器即可）：

```js
() => new Promise(resolve => {
  window.__long = [];
  new PerformanceObserver(function (list) {
    list.getEntries().forEach(function (entry) { window.__long.push(Math.round(entry.duration)); });
  }).observe({ entryTypes: ['longtask'] });
  const target = Array.from(document.querySelectorAll('.file-select')).find(function (el) { return el.textContent.indexOf('TARGET_TEXT') >= 0; });
  const started = performance.now();
  target.click();
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      const node = document.querySelector('.preview-stage pre');
      resolve(JSON.stringify({
        blockedMs: Math.round(performance.now() - started),
        longTasks: window.__long,
        renderedChars: node ? node.textContent.length : -1,
      }));
    });
  });
})
```

判读：
- `blockedMs` 几百毫秒以内 = 不卡；**几秒以上 = 用户说的卡死**。
- `longTasks` 里那条最大的就是元凶的时长。
- `renderedChars` 常常直接暴露真相：渲染出来的字符数和被点的文件对不上，就是渲染了**别的数据**。

**务必做对照实验**排除体量假设。同一个探针，先单独点一个「大」对象、再单独点「小」对象；如果两者都不卡，那卡死一定来自**状态组合**而不是数据大小。这一步能把排查范围砍掉一大半。

## 第二步：高频根因——异步内容与 UI 状态不同步

最常见的形态（真实案例：11MB 图片 30 秒卡死）：

```
onSelect(item):
  selected = item        // ① UI 状态立刻变（高亮、类型分支跟着变）
  data = await fetch(item)   // ② 字节要等一会才到
  content = data         // ③
```

在 ①③ 之间的窗口里，渲染层的 computed 看到的是**新 item 的类型** + **旧 item 的内容**。如果渲染按类型分支（图片→`<img>`、文本→`<pre>`、PDF→`<iframe>`），就会拿旧字节按新类型解码：

- 大图 base64 → 被当 Markdown 文本解码 → 千万级字符塞进 `<pre>`；
- `white-space: pre-wrap` 让每一行都要重排 → 主线程几十秒。

排查清单：
1. 选中态与数据是否在同一个赋值里落地？若否，就有窗口。
2. 渲染分支的判定读的是「用户点了哪个」还是「内容属于哪个」？必须是后者。
3. 有没有为内容记录归属（例如 `loadedPath === selected.path`）？
4. 连续快速点击时，先返回的旧响应会不会盖掉后选的内容？需要请求令牌（`loadSequence`）。

修法：
- 加 `previewReady = loadedPath === selected.path` 之类的总闸，所有类型分支挂在它下面；不匹配就渲染占位（"正在读取…"），绝不渲染旧字节。
- 切换时先清空内容，再 `await`。
- 用递增令牌丢弃迟到响应；顺带给读取补 `catch`（否则失败是未捕获的 rejection，界面只会白着）。
- 对超大文本加渲染上限（例如只渲染前 20 万字符 + 明确提示），**只截断渲染、不截断存储**，避免修完还留一个可被合法数据触发的卡死。

## 第三步：同类坑——「居中」把顶部顶出滚动区

如果用户抱怨的不是卡死而是「打开文档怎么从中段开始」，先量这个，别改数据：

```js
() => {
  const stage = document.querySelector('.scroll-container');
  const item = document.querySelector('.scroll-container pre');
  const sr = stage.getBoundingClientRect();
  const ir = item.getBoundingClientRect();
  return JSON.stringify({
    scrollTop: stage.scrollTop,          // 期望 0
    itemTopVsStage: Math.round(ir.top - sr.top),  // 期望 >= 0；为负说明顶部滚不到
    scrollHeight: stage.scrollHeight,
  });
}
```

`itemTopVsStage` 为负（真实案例 **-49088**）就是它：滚动容器上的 `place-items: center` / `align-items: center` 会把高于容器的子项向**上下两侧**溢出，顶部落在滚动原点之外，用户永远滚不回去。

修法：只给「可能高于容器」的内容取消垂直居中（`align-self: start`），居中保留给图片、iframe 这类需要适配尺寸的内容。修完 `scrollTop: 0` 时 `itemTopVsStage` 应为 0 或 1。

**这类布局缺陷 happy-dom / jsdom 测不出来**（没有真实布局引擎），必须靠浏览器实测数字，别硬塞单元测试。

## 第四步：把门禁写死

修完必须加一条能挡住旧行为的测试。造一个「慢响应」的 mock，在字节未落地时断言：

- 旧类型的节点已经消失；
- 新类型的节点还没出现；
- 占位提示在。

然后**临时把修复回滚成旧行为，确认这条测试会失败**——不失败就说明它挡不住，白写。

## 坑

- `playwright-cli screenshot`（以及 `snapshot`）把产物写到 `.playwright-cli/page-<ISO时间戳>.{png,yml}`，**不会**输出到 stdout；`cmd > file.png` 只会得到一个几百字节的文本文件。要文件就 `cp` / `ls -t .playwright-cli/*.png | head -1`。
- `snapshot` 的元素 ref 只对**最近一次**快照有效；`reload` / HMR / 重新渲染后全部作废。批量交互时用 `eval` 按文本查找并 `click()` 更稳，别硬编码 ref。
- `snapshot` 的 ref 在页面处于 loading 覆盖层时可能整批消失。
- shell 里 `grep` 匹配中文或含特殊字符的模式经常**静默失配**（返回空而不是报错），会让人误判「元素不存在」。用 `sed -n '/…/p'`、或专门的 Grep 工具，别信 grep 的空结果。
- 别只测一个数据量级就下结论：小文件不卡 ≠ 没有 bug，大文件不卡 ≠ 不是体积问题，**必须做交叉对照**。
- 复现前先 `resize` 到目标视口；响应式断点会改变哪条 CSS 生效，进而改变是否卡死。
