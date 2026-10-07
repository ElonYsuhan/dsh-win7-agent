# 高级视觉技法 (Advanced Visual Techniques)

> 以下技法按需选用，每个页面最多启用 2~3 种，否则会过度设计。
> 本文件是 `beautify-guide.md` §视觉技法的代码库，生成 html 时按需读取取用具体 CSS/HTML 片段。

## 目录
1. [表面材质系统](#1-表面材质系统)
2. [阴影层次系统](#2-阴影层次系统)
3. [布局美学](#3-布局美学)
4. [微交互升级](#4-微交互升级)
5. [页面节奏与呼吸](#5-页面节奏与呼吸)
6. [色彩精度](#6-色彩精度)
7. [背景氛围](#7-背景氛围)

---

## 1. 表面材质系统 (Surface Materiality)

**毛玻璃面板 (Glassmorphism)** — 适合深色主题的数据卡片、侧边栏
```css
/* 真正的毛玻璃 = 模糊 + 半透明填充 + 内边框高光 + 外阴影 */
background: rgba(255, 255, 255, 0.05);
backdrop-filter: blur(16px);
-webkit-backdrop-filter: blur(16px);
border: 1px solid rgba(255, 255, 255, 0.1);
box-shadow: 
  0 8px 32px rgba(0, 0, 0, 0.3),   /* 空间深度 */
  inset 0 1px 0 rgba(255, 255, 255, 0.1); /* 边缘折射高光 */
border-radius: 12px;
```
> ⚠️ 关键：必须加 `inset 0 1px 0` 白色内阴影模拟物理边缘折射，否则只是模糊而不是玻璃。

**新拟态 (Neumorphism)** — 适合浅色主题的工具面板、设置区域
```css
/* 凸起 — 元素与背景同色，靠双阴影制造立体 */
background: #e0e5ec; /* 背景色必须非纯白非纯黑 */
box-shadow: 
  8px 8px 16px rgba(0, 0, 0, 0.15),   /* 右下暗影 */
  -8px -8px 16px rgba(255, 255, 255, 0.7); /* 左上亮影 */

/* 凹陷 — 输入框、选中态 */
box-shadow: 
  inset 4px 4px 8px rgba(0, 0, 0, 0.12),
  inset -4px -4px 8px rgba(255, 255, 255, 0.6);
```

**品牌色发光边框 (Glow Border)** — 适合深色主题的关键数据卡片、选中态
```css
/* 内发光 ×2 + 外环境光 */
border: 1px solid rgba(品牌色R, 品牌色G, 品牌色B, 0.3);
box-shadow: 
  inset 0 0 6px rgba(品牌色R, 品牌色G, 品牌色B, 0.15),  /* 内发光层1 */
  inset 0 0 12px rgba(品牌色R, 品牌色G, 品牌色B, 0.08), /* 内发光层2 */
  0 0 24px rgba(品牌色R, 品牌色G, 品牌色B, 0.12);       /* 外环境光 */
```

**虹彩渐变 (Iridescent Gradient)** — 仅用于首屏 Hero 背景装饰，禁止大面积使用
```css
background: conic-gradient(
  from 0deg,
  rgba(255, 50, 100, 0.15),
  rgba(255, 150, 50, 0.15),
  rgba(200, 255, 50, 0.15),
  rgba(50, 255, 150, 0.15),
  rgba(50, 150, 255, 0.15),
  rgba(150, 50, 255, 0.15),
  rgba(255, 50, 100, 0.15)
);
filter: blur(80px); /* 大模糊 = 有机光晕，而非生硬色块 */
```

---

## 2. 阴影层次系统 (Shadow Hierarchy)

深色主题阴影（不要用纯黑 `rgba(0,0,0,1)`，用偏品牌色的暗色）：
```css
/* Level 1 — 轻悬浮（标签、小卡片） */
box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);

/* Level 2 — 标准卡片 */
box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);

/* Level 3 — 弹出层/模态 */
box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);

/* Level 4 — 全屏遮罩上的浮层 */
box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
```

浅色主题阴影（Stripe 风格，蓝调品牌阴影）：
```css
/* Notion 风格 — 4 层超轻阴影（最精致） */
box-shadow:
  rgba(0,0,0,0.04) 0px 4px 18px,
  rgba(0,0,0,0.027) 0px 2px 8px,
  rgba(0,0,0,0.02) 0px 0.8px 3px,
  rgba(0,0,0,0.01) 0px 0.175px 1px;

/* Stripe 风格 — 蓝调品牌阴影 */
box-shadow:
  rgba(50, 50, 93, 0.25) 0px 30px 45px -30px,
  rgba(0, 0, 0, 0.1) 0px 18px 36px -18px;
```

---

## 3. 布局美学 (Layout Aesthetics)

**非对称 Hero**（替代居中大标题）：
```html
<!-- 左文右图 / 左文右数据 — 更有杂志排版感（grid-cols-5：左 60% 右 40%） -->
<div class="grid grid-cols-1 lg:grid-cols-5 gap-8 items-center">
  <div class="lg:col-span-3"><!-- 左侧 60% 文字区 --></div>
  <div class="lg:col-span-2"><!-- 右侧 40% 视觉区 --></div>
</div>
```

**Bento Grid**（Apple Control Center 风格的信息区）：
```html
<!-- 非等宽网格 — 大小卡片混排，信息密度有节奏 -->
<div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
  <div class="col-span-2 row-span-2"><!-- 大卡片 --></div>
  <div><!-- 小卡片 --></div>
  <div><!-- 小卡片 --></div>
  <div class="col-span-2"><!-- 宽卡片 --></div>
</div>
```

**2 列交替 (Zig-Zag)**（替代 3 列等宽）：
```html
<!-- 奇数行：左图右文 / 偶数行：左文右图（用 dir="rtl" 翻转） -->
<div class="grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
  <div><!-- 视觉 --></div>
  <div><!-- 文字 --></div>
</div>
<div class="grid grid-cols-1 md:grid-cols-2 gap-8 items-center" dir="rtl">
  <div><!-- 视觉 --></div>
  <div><!-- 文字 --></div>
</div>
```

**最大内容宽度约束**：所有内容不得超过 `max-w-6xl`（1152px）居中，避免超宽屏内容拉伸。

---

## 4. 微交互升级 (Micro-Interaction Upgrade)

**滚动入场动效（4 种标准 + 2 种高级）：**
```js
// 标准入场 — Intersection Observer 驱动
const animations = {
  fadeUp:     'opacity: 0; transform: translateY(24px)',   // 淡入上升
  stagger:    'opacity: 0; transform: translateY(16px)',   // 交错淡入（子元素递增 delay）
  slideLeft:  'opacity: 0; transform: translateX(-32px)',  // 从左滑入
  scaleIn:    'opacity: 0; transform: scale(0.92)',        // 缩放弹入
  // 高级
  clipReveal: 'clip-path: inset(0 100% 0 0)',              // 裁剪揭示（适合图片）
  blurIn:     'opacity: 0; filter: blur(8px)',             // 模糊聚焦（适合标题）
};
// 最终状态统一：opacity: 1; transform: none; filter: none;
// transition: all 0.6s cubic-bezier(0.16, 1, 0.3, 1); // easeOutExpo
```

**交错延迟公式**：`delay = index * 80ms`（不要超过 400ms 总延迟）

**触觉反馈**（所有可点击元素）：
```css
.interactive {
  transition: transform 0.15s cubic-bezier(0.2, 0, 0, 1), box-shadow 0.2s ease;
}
.interactive:hover {
  transform: translateY(-2px);     /* 轻微浮起 */
  box-shadow: 0 8px 24px rgba(0,0,0,0.2); /* 阴影加深 */
}
.interactive:active {
  transform: translateY(0) scale(0.97); /* 按压回弹 */
  transition-duration: 0.08s;            /* 快速响应 */
}
```

**数字滚动计数动画**（数据亮点区块专属）：
```js
// 使用 requestAnimationFrame 实现平滑计数
// easing: easeOutExpo — 先快后慢，数字从 0 跳到目标值
// duration: 2000ms, delay: 元素进入视口后 200ms 启动
```

**骨架屏闪烁 (Skeleton Shimmer)**：数据加载态用闪烁占位，不用 spinner
```css
.skeleton {
  background: linear-gradient(90deg, 
    rgba(255,255,255,0.04) 25%, 
    rgba(255,255,255,0.08) 50%, 
    rgba(255,255,255,0.04) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
}
@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

---

## 5. 页面节奏与呼吸 (Visual Rhythm & Breathing)

**章节呼吸法则**：不是每个章节都一样长——长章节后接短章节，密信息后接留白过渡。

```
理想节奏模式：
Hero（全屏冲击） → 短数据条（3个数字） → 长内容章（3~4屏）
→ 短引用/金句（1屏留白） → 中等内容章（2屏） → 短CTA收尾
```

**视觉锚点分布**：每 2~3 个文字密集章节后，插入一个视觉锚点：
- 全宽引用块（QuoteBlock，大字 + 品牌色左边框）
- 数据亮点横幅（DataHighlight，大数字 + 描述）
- 图片（ImageFrame，打破纯文字节奏）

**首屏设计原则**：
- 首屏不可出现滚动条——所有核心信息在 100vh 内完整呈现
- 标题不要居中——左对齐或左对齐+右视觉的分屏结构更有杂志感
- 副标题/描述紧跟标题，间距 16px，形成紧凑的信息单元
- 首屏 CTA 按钮在标题下方 32px，不要放页面底部

---

## 6. 色彩精度 (Color Precision)

**深色主题完整 CSS 变量系统**：
```css
:root {
  /* 基础色板 */
  --primary: #品牌主色;            /* 唯一强调色，饱和度 < 80% */
  --primary-hover: 品牌色加深10%;   /* CTA hover */
  --primary-glow: rgba(品牌色, 0.15); /* 发光效果专用 */

  /* 中性色阶（冷调 or 暖调，全页统一，不混用） */
  --bg: #08090a;                    /* Off-Black，不是纯黑 */
  --bg-elevated: #0d0f14;           /* 弹出层/模态背景 */
  --surface: rgba(255,255,255,0.03); /* 卡片背景 */
  --surface-hover: rgba(255,255,255,0.06); /* 卡片 hover */
  --border: rgba(255,255,255,0.08); /* 标准边框 */
  --border-strong: rgba(255,255,255,0.15); /* 强调边框 */

  /* 文字色阶（3 级，必须同时使用才有层次） */
  --text: rgba(255,255,255,0.85);     /* 正文 */
  --text-secondary: rgba(255,255,255,0.55); /* 次要说明 */
  --text-tertiary: rgba(255,255,255,0.35);  /* 时间戳、占位符 */

  /* 功能色 */
  --success: #34d399;
  --warning: #fbbf24;
  --error: #f87171;

  /* 圆角 */
  --radius-sm: 6px;   /* 小元素：标签、badge */
  --radius: 8px;      /* 标准：卡片、输入框 */
  --radius-lg: 12px;  /* 大卡片、面板 */
  --radius-xl: 16px;  /* Hero 卡片、模态 */
  --radius-full: 9999px; /* 按钮 pill */
}
```

**浅色主题完整 CSS 变量系统**：
```css
:root {
  --primary: #品牌主色;
  --primary-hover: 品牌色加深8%;
  --bg: #ffffff;
  --bg-elevated: #f6f5f4;           /* Notion 暖白交替 */
  --surface: #ffffff;
  --surface-hover: #f9fafb;
  --border: rgba(0,0,0,0.08);
  --border-strong: rgba(0,0,0,0.15);
  --text: rgba(0,0,0,0.95);
  --text-secondary: rgba(0,0,0,0.55);
  --text-tertiary: rgba(0,0,0,0.35);
  --success: #059669;
  --warning: #d97706;
  --error: #dc2626;
  --radius-sm: 4px;
  --radius: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-full: 9999px;
}
```

**色彩一致性铁律**：全页必须在冷调或暖调中二选一，绝不同一页面内混用冷暖灰。

---

## 7. 背景氛围 (Background Atmosphere)

深色主题不要用纯色背景——叠加微妙的氛围层：
```css
/* 方案 A：径向渐变光晕 */
background: 
  radial-gradient(ellipse 80% 50% at 50% -20%, rgba(品牌色,0.12), transparent),
  #08090a;

/* 方案 B：双光点 */
background:
  radial-gradient(ellipse 60% 40% at 20% 0%, rgba(品牌色,0.08), transparent),
  radial-gradient(ellipse 50% 50% at 80% 100%, rgba(品牌色,0.05), transparent),
  #08090a;

/* 方案 C：噪点纹理叠加（最高级） */
background:
  url("data:image/svg+xml,<svg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.03'/></svg>"),
  radial-gradient(ellipse 80% 50% at 50% -20%, rgba(品牌色,0.12), transparent),
  #08090a;
```

浅色主题背景用 section 交替：
```css
/* Notion 风格：白 → 暖灰 → 白 交替 */
.section:nth-child(odd) { background: #ffffff; }
.section:nth-child(even) { background: #f6f5f4; }
```
