# 排版系统（字体 / 字号 / 字重）

最后更新：2026-11-02

界面排版只有一份真源：`src/renderer/typography.css`。
其它 CSS 一律引用变量，不要再写字面量——这条由 `scripts/typography-smoke.js` 守着。

## 一、字体

| 场景 | 字面 | 字重 | 为什么 |
| --- | --- | --- | --- |
| 中文 | Noto Sans SC（思源黑体） | 400 / 600 | 随包内置，Win7 与 Win11 观感一致 |
| 英文、数字 | Inter | 400 / 500 / 600 | 数字与拉丁比 Segoe UI 更中性，等宽数字对齐更稳 |
| 代码、路径、标识 | JetBrains Mono | 400 | 等宽，`0O` `1l` 区分清楚 |

```css
--font-ui:   "Inter", "Noto Sans SC", "Source Han Sans SC",
             "Microsoft YaHei UI", "Microsoft YaHei", sans-serif;
--font-mono: "JetBrains Mono", Consolas, "Courier New", monospace;
```

- 字体文件在 `src/renderer/fonts/`，共 6 个 woff2、约 2.3MB，随安装包分发（不装系统字体）。
- 中文用的是 `chinese-simplified` 子集。子集外的生僻字按回退链落到微软雅黑，
  不会出现方框——这是有意为之，不要为了「全覆盖」去换 8MB 的整包。
- 许可与版权见 `src/renderer/fonts/LICENSE.md`（三款均为 OFL 1.1）。
- Win7 只有 `Microsoft YaHei`（没有 UI 版），回退链里两条都留着。

## 二、字号阶梯

只有 6 档。新写界面时按语义选档，不要按「看起来差不多」选数字。

| 令牌 | 值 | 用在哪 |
| --- | --- | --- |
| `--font-size-caption` | 12px | 参数说明、辅助信息、徽标、时间戳 |
| `--font-size-small` | 13px | 表格、数据、代码块、列表副标题 |
| `--font-size-base` | 14px | 正文、输入框、菜单、按钮 |
| `--font-size-heading` | 16px | 模块标题、卡片标题、品牌名 |
| `--font-size-title` | 20px | 页面标题、弹窗标题、markdown `h1/h2` |
| `--font-size-display` | 24px | 软件主标题、空状态大标题 |

## 三、字重

`--font-weight-normal(400) / medium(500) / semibold(600)`。

以前散落的 `550 / 650 / 700` 已经收敛。注意 Win7 的微软雅黑只有 Regular/Bold，
没有 Medium——回退到雅黑时 500 会渲染成 400，这是可接受的降级；内置的 Noto/Inter
上 600 是真 Semibold，不再是浏览器合成的假粗。

## 四、数字与代码

- `body { font-variant-numeric: tabular-nums }`：计数、计时、表格列宽不跳动。
- `pre, code, kbd, samp` 统一 `--font-mono` 且关闭连字（`=>` 不能和 `≠` 糊在一起）。
- 代码块固定 13px；行内 `code` 继承所在段落字号，避免一句话里出现两种字号。

## 五、图标不算文字

图标字形（`.icon-button`、`.small-icon`、`.send-button`、`::-webkit` 箭头等）仍用
px 字面量跟着图形尺寸走，全仓 19 处，都带 `icon / -close / arrow / remove / ::before / ::after`
的选择器特征。`typography-smoke` 就是按这个特征判的：任何**文案**掉到 px 字面量都会红。

## 六、验收

| 命令 | 覆盖 |
| --- | --- |
| `node scripts/typography-smoke.js`（已进 `npm run check`） | 6 个字面齐备、woff2 合法、令牌齐全、加载顺序、MIME、无裸字面量、图标例外 |
| `npm run check:typography:browser` | 真窗口：字面真的加载、body 14px/400、令牌生效、正文 12px 地板、按钮不被文字撑破、markdown 标题/表格/代码档位、深浅主题一致、`file://` 下 CSP 放行本地字体 |

截图产物：`release/validation/typography-sample-dark.png`、`typography-sample-light.png`。

## 七、踩过的坑

1. **`typography.css` 必须排在 `style.css` 之前**（`index.html` 第一张样式表）。
   否则 `var(--font-size-*)` 未定义，整页会退回浏览器初始 16px。
2. **凡是自建宿主页的验收脚本，引入 `style.css` 时也必须引入 `typography.css`**
   （`licensing-gate-e2e-smoke.js` 就踩过：缺了它，测出来的是一张 16px 的假界面）。
3. **HTTP 静态服务要给 `.woff2` 正确 MIME**（`font/woff2`）。给错时 Chromium
   拒收字体并静默回落系统字体，肉眼很难发现——所以验收用 `document.fonts.load()`
   强制加载每个字面，而不是看「字有没有显示出来」。
4. `document.fonts.check()` 只认已加载的字面，判断前必须先 `load()` 一遍。
5. 批量改 CSS 时别用「整行匹配」，仓库里有大量单行多声明与 `@media` 嵌套；
   按花括号结构解析，并且要跳过注释（否则注释会被复制到 `}` 后面）。
