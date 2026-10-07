# Page Database SDK Contract

> 本文件定义 Agent 写 HTML 时可使用的 `window.__SMART_PAGE__.database` 运行时协议。
> 跨模块建表、查 schema、导入 CSV、服务端侧更新记录等能力详见 `../database/entry.md`。

## 1. 注入与调用

平台 iframe-sandbox 会在用户脚本执行前注入 SDK。HTML 中直接读取：

```javascript
var db = window.__SMART_PAGE__.database;
```

所有方法返回 `Promise`（**例外**：`db.onUpdated` 是同步订阅，返回值不是 `Promise`，见 §8）。`databaseId` 必须以字符串字面量硬编码到 HTML，值来自 `../database/create_database.py` 的 stdout。

## 2. 可用方法

| 方法 | 用途 | 参数 |
| --- | --- | --- |
| `db.query(params)` | 查询记录列表（**单次只回一页**，分页由页面自己实现） | `{ databaseId, filter?, sorts?, fields?, startCursor?, pageSize? }` |
| `db.addRecord(params)` | 添加一条记录 | `{ databaseId, properties }` |
| `db.getRecord(params)` | 获取单条记录 | `{ databaseId, recordId, fields? }` |
| `db.updateRecord(params)` | 更新一条记录（增量，仅更新传入的字段） | `{ databaseId, recordId, properties? }` |
| `db.deleteRecord(params)` | 删除一条记录 | `{ databaseId, recordId }` |
| `db.getSchema(params)` | 获取数据库 Schema | `{ databaseId }` |
| `db.uploadImage(params)` | 上传图片，换取 CDN URL | `{ data, contentType?, fileName? }`（**无 `databaseId`**） |
| `db.onUpdated(handler)` | 订阅 database 数据变更通知，如何响应由页面业务代码自行决定（见 §8） | `handler({ databaseIds })`（**无 `databaseId`**，且**不返回 Promise**） |

写入类方法返回：`db.updateRecord` → `{ id }`（**增量更新**：只覆盖 `properties` 中传入的字段，未传字段保持不变）；`db.deleteRecord` → `{}`（无返回体）。`updateRecord` 的 `properties` 结构同 `db.addRecord`（见 §3 PropertyValue）。

## 3. PropertyValue

`db.addRecord` 的 `properties` 是 `map<string, PropertyValue>`，key 必须与 database schema 字段名完全一致。

每个 `PropertyValue` 是 oneof 结构：`{ "<类型字段>": <值> }`。

| 类型字段 | 值类型 | 示例 |
| --- | --- | --- |
| `text` | string | `{ text: "张三" }` |
| `number` | number | `{ number: 25 }` |
| `select` | string | `{ select: "opt_1" }` 或 `{ select: "进行中" }` |
| `multi_select` | string[] | `{ multi_select: ["opt_a", "opt_b"] }` 或 `{ multi_select: ["篮球", "钢琴"] }` |
| `date` | string | `{ date: "2026-06-24" }` |
| `checkbox` | boolean | `{ checkbox: true }` |
| `url` | object | `{ url: { text: "官网", link: "https://example.com" } }` |
| `email` | string | `{ email: "a@example.com" }` |
| `phone_number` | string | `{ phone_number: "13800138000" }` |
| `image` | object | `{ image: { images: [{ title: "封面", imageUrl: "https://example.com/a.png", width: 800, height: 600 }] } }` |

`image` 的 `imageUrl` 必须是可公网访问的 URL；用户在页面上传的本地文件**必须先** `db.uploadImage` 换取 `url`，拿到 `url` 后再写入记录（执行顺序见 §7），**不要**把 `data:image/...;base64,` 或 `blob:` 地址直接写进 `imageUrl`。

`select` / `multi_select` 可传选项文本或选项 id；Agent 写 HTML 时优先从 `OPTIONS_MAP` 取 `.id`。

```javascript
properties["部门"] = { select: OPTIONS_MAP["部门"][selectedKey].id };
properties["技能"] = {
  multi_select: Array.prototype.map.call(selectedEls, function(el) {
    return OPTIONS_MAP["技能"][el.value].id;
  })
};
```

## 4. Query Params

`filter` 是递归树，节点三选一：

| 节点 | JSON 结构 |
| --- | --- |
| 单字段条件 | `{ property: { property: "字段名", text/number/select/date/checkbox: {...} } }` |
| AND | `{ and: [filter1, filter2] }` |
| OR | `{ or: [filter1, filter2] }` |

条件字段与操作符：

| 字段类型 | 条件字段 | 操作符 |
| --- | --- | --- |
| text / url / email / phone_number | `text` | `equals`, `contains` |
| number | `number` | `equals`, `greater_than`, `less_than` |
| select / multi_select | `select` | `equals`, `does_not_equal` |
| date | `date` | `equals`, `before`, `after` |
| checkbox | `checkbox` | `equals`, `does_not_equal` |

`sorts` 结构：

```javascript
[{ property: "字段名", direction: "ascending" }]
```

`direction` 可为 `"ascending"` 或 `"descending"`。

> **字段引用约束**：`sorts[].property`、`filter` 叶子的 `property`、以及 `fields[]` 里的字段名，**必须逐一来自 `db.getSchema()` 返回的真实字段名**；schema 中没有的字段不能引用。

`pageSize`：默认 `50`，**最大 `200`**（超出按 200 截断）。**单次 `query` 永远只返回一页**，后端不会一次给全量——**分页逻辑必须由页面自己实现**：要么按 §6 的 `loadAll` 循环拉全量后再渲染，要么做「加载更多 / 分页器」交互，把 `nextCursor` 存起来点一次拉一页。**禁止**假设一次 `query` 就拿到所有记录（数据超过一页时会静默少数据，统计/汇总直接算错）。

## 5. GetSchema 返回值

`db.getSchema({ databaseId })` 返回 `{ id, title, properties }`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 数据库 ID |
| `title` | string | 数据库标题 |
| `properties` | array | 字段定义列表 |

`properties` 中每项结构：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 字段 ID |
| `name` | string | 字段名称 |
| `type` | string | 字段类型（`text`、`number`、`select`、`multi_select`、`date`、`checkbox`、`url`、`email`、`phone_number`、`image`） |
| `config` | object? | 字段配置，`select`/`multi_select` 类型包含 `options: [{ text, id }]` |

示例：

```javascript
var schema = await db.getSchema({ databaseId: "db_xxx" });
// schema.properties → [{ id: "f1", name: "姓名", type: "text" }, { id: "f2", name: "状态", type: "select", config: { options: [{ text: "进行中", id: "opt_1" }] } }]
```

## 6. FieldValue

`db.query` 返回 `{ results, nextCursor, hasMore }`，记录数组一律从 `result.results` 取（翻页配套 `result.nextCursor` / `result.hasMore`）；`db.getRecord` 返回 `{ result }`。记录对象是扁平对象：`{ "字段名": 值 }`（含系统主键 `_id`）。

**翻页（拉全量）必须这样写** —— `query` 单次只回一页（`pageSize` 默认 50、最大 200），续页游标入参名固定为 `startCursor`（**不是 `cursor`**，后端只认 `startCursor`，写错会被静默丢弃 → 游标恒空 → 死循环）：

```javascript
function loadAll(startCursor, acc, guard) {
  acc = acc || []; guard = guard || 0;
  if (guard > 100) return Promise.resolve(acc);            // 防呆①：硬上限熔断
  return db.query({ databaseId: DATABASE_ID, pageSize: 200, startCursor: startCursor })  // 拉全量用上限 200，减少往返
    .then(function (r) {
      acc = acc.concat(r.results || []);
      var next = r.nextCursor;
      // 防呆②：游标必须前进(next !== startCursor)；防呆③：本页非空才续翻
      if (r.hasMore && next && next !== startCursor && (r.results || []).length) {
        return loadAll(next, acc, guard + 1);
      }
      return acc;
    });
}
loadAll().then(function (all) { /* 渲染 all */ });         // 首页 startCursor 传 undefined
```

若做「加载更多 / 分页器」而非一次拉全量：把上一次的 `nextCursor` 存在闭包/变量里，点击时带 `startCursor` 拉下一页，`hasMore === false` 时隐藏按钮。两种做法都必须处理 `hasMore`，不能只查一次就当全量。

`db.query` 返回示例：

```json
{
  "results": [
    {
      "_id": "2rVLfQTl3uHurZq7dfrbdG",
      "姓名": "小李",
      "所属单位": "腾讯",
      "手机号": "123456",
      "邮箱": "123456789@qq.com",
      "参与人数": 2,
      "参与场次": "全天参与"
    }
  ],
  "nextCursor": "2rVLfQTl3uHurZq7dfrbdG",
  "hasMore": true
}
```

| 字段类型 | 返回值 |
| --- | --- |
| text / select / email / phone_number | string |
| number | number |
| date | string，ISO 8601（如 `"2026-06-24T10:00:00Z"`） |
| checkbox | boolean |
| multi_select | string[] |
| url | `{ text, link }` |
| image | `[{ imageUrl, title, width, height }]` |
| 空值 | `null` |

渲染 image 时先判空：

```javascript
var imgs = row["图片"];
var src = imgs && imgs[0] ? imgs[0].imageUrl : "";
```

## 7. UploadImage

`db.uploadImage(params)` 把图片字节上传到 CDN，返回可写入 `image` 字段的 URL。它是唯一**不需要 `databaseId`** 的方法。

> **执行顺序（强制）**：先 `db.uploadImage` 拿到 `url`，再用它做后续操作（写 `image` 字段、渲染预览等）。
> - `url` 未到手或为空 → 中断报错，不许发 `addRecord` / `updateRecord`。
> - `imageUrl` 只能是 `uploadImage` 返回的 `url`；`data:base64` / `blob:` 落库即死链。
> - 多图：各传一次，`Promise.all` 收齐后一次性写 `images` 数组。

入参：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `data` | string | 是 | 图片原始字节的 base64，**不含** `data:image/png;base64,` 前缀 |
| `contentType` | string | 否 | MIME 类型，如 `image/png` |
| `fileName` | string | 否 | 原始文件名（含扩展名） |

返回：`{ url }`，`url` 为 CDN 可访问地址。

约束（前端必须自己校验，越界会被后端拒绝）：单张 ≤ 10MB；MIME 限 `image/png`、`image/jpeg`、`image/gif`、`image/webp`、`image/bmp`、`image/svg+xml`、`image/heic`、`image/heif`、`image/tiff`。

标准写法 —— `<input type="file">` → base64 → `uploadImage` → 写入 `image` 字段：

```javascript
function fileToBase64(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () {
      // readAsDataURL 结果形如 "data:image/png;base64,xxxx"，只取逗号后的部分
      resolve(String(reader.result).split(",")[1] || "");
    };
    reader.onerror = function () { reject(new Error("读取文件失败")); };
    reader.readAsDataURL(file);
  });
}

// 步骤 ①：文件 → base64 → uploadImage，产出可落库的 image item
function uploadOne(file) {
  if (file.size > 10 * 1024 * 1024) return Promise.reject(new Error("图片不能超过 10MB"));
  return fileToBase64(file)
    .then(function (base64) {
      return db.uploadImage({ data: base64, contentType: file.type, fileName: file.name });
    })
    .then(function (r) {
      if (!r || !r.url) throw new Error("上传失败：未返回 url");   // url 为空必须中断，不许继续写库
      return { title: file.name, imageUrl: r.url };
    });
}

// 步骤 ②：拿到全部 url 之后，才做写库等后续操作
function submitWithImages(files, otherProps) {
  return Promise.all(Array.prototype.map.call(files, uploadOne))
    .then(function (images) {
      var properties = otherProps || {};
      if (images.length) properties["图片"] = { image: { images: images } };
      return db.addRecord({ databaseId: DATABASE_ID, properties: properties });
    })
    .catch(function (err) {
      console.error("[database] 图片上传/提交失败:", err);
      throw err;   // 交给 UI 提示，不静默写空图记录
    });
}
```

`width` / `height` 可选；需要时用 `Image` 对象在本地量出 `naturalWidth` / `naturalHeight`，在步骤 ① 里一起放进 image item。

给已有记录补图同理：`uploadImage` → `db.updateRecord({ databaseId, recordId, properties: { "图片": { image: { images: [...] } } } })`。注意 `image` 字段是整体覆盖，追加图时要先把该记录原有的 `[{ imageUrl, title, width, height }]` 读出来 concat 后再提交。

### 7.1 图片提交前缓存（防登录重定向丢失，强制）

未登录点提交时平台会跳登录再整页重载，内存里的 `File` 全丢。图片本体不可序列化（base64 撑爆 localStorage），**用 IndexedDB 存 `Blob`**、`localStorage` 存标记。支持多图、只留最新一次选择。链路：**选图（先清旧批再存）→ 整页回来恢复预览 → 提交走 §7 `uploadImage(Blob)` → `addRecord` 成功后清库**。以下为强制约束，Agent 自行实现（ES5）：

- **存储**：IndexedDB 库 `sp_form_img`/store `f`，key = `location.pathname + "::图片#" + i`；localStorage `"sp_img_flag_"+location.pathname` 存 `{n, ts}`（张数+时间戳）。
- **同源隔离**：同源共用一个 store，**禁用 `store.clear()`**；key 带 `location.pathname` 前缀，清理只按 `n` 删本页 `图片#0..#(n-1)`。
- **open 健壮**（否则共享 origin 会 `Uncaught NotFoundError`）：不写死版本；`onsuccess` 判 `contains("f")`，缺失则 `close()` 用 `version+1` 重开在 `onupgradeneeded` 补建；`transaction` try/catch 转 reject，补 `onblocked`。
- **三动作**：① `change` 空→清除，否则先清旧批再逐张 `put(图片#i)`、写标记；② 恢复（`renderSelectOptions()` 后调）无标记/超 48h→清除，否则按 `n` `get` 重建预览存闭包；③ 提交用恢复的 Blob（否则取 `input.files`）走 §7 `submitWithImages`，成功清除、失败保留。
- **解耦降级**：所有 IndexedDB 调用 `.catch` 兜住，失败静默降级，**不得影响 `uploadImage`/`addRecord`**；无 `window.indexedDB` 跳过缓存。
- **清除时机**：提交成功 / 移除图片 / 超 48h，统一按 `n` 删本页 key + 删标记 + 清空闭包（单图即 `n===1`）。`lint_database_sdk_usage.py` DSDK008 硬校验 IndexedDB 缓存代码存在（`open`/`transaction`/`objectStore`/`put`/`delete` 齐全）。

## 8. OnUpdated（数据变更订阅，推荐接入）

`db.onUpdated(handler)` 订阅**当前页面已关联的 database** 的数据变更：任何来源的改动（他人在表格改、其他端提交、脚本批量写、当前页自己 `addRecord`）落库后回调 `handler`。

平台只负责**通知「变更发生了」**，收到后怎么处理由页面业务代码定（重新 `query` 重渲染 / 只刷某区块 / 更新统计数字 / 提示「数据已更新」/ 忽略均可）。

> **推荐、非强制，按场景判断**：多人协作、看板统计、长时间停留、他人持续写入的展示页 → 推荐接入，页面可随时展示最新数据；一次性展示快照、纯表单页按需接入即可。

与其它方法的差异：调用时**无需 `databaseId`**（订阅范围由平台定）；**同步注册即生效**（无 `Promise`）；回调入参 `{ databaseIds }` 是本次变更的 databaseId 数组，**只带变更范围**（记录内容由页面自行查询）。

```javascript
// 平台最小形态：回调里重新 query 只是最常见的一种处理方式
db.onUpdated(({ databaseIds }) => {
  for (const databaseId of databaseIds) {
    window.__SMART_PAGE__.database.query({ databaseId });
  }
});

// 数据展示页推荐写法（ES5，配合 §6 loadAll）
if (db && typeof db.onUpdated === "function") {           // 无此能力 → 静默降级
  db.onUpdated(function (payload) {
    var ids = (payload && payload.databaseIds) || [];
    if (ids.indexOf(DATABASE_ID) === -1) return;          // 只处理本页关心的表
    loadAll().then(renderData).catch(function (err) { console.error("[database] 刷新失败:", err); });
  });
}
```

约束（选择接入后适用；回调内业务处理方式自定）：

- **注册一次**：整页在初始化阶段注册一个 handler 即可，registration 放在 `query` 回调或渲染函数之外。
- **需要新数据自己查**：回调带的是变更范围，页面按 `databaseIds` 自行 `query` / `getRecord` 取最新数据。
- **去抖**：连续写入会多次回调；处理逻辑若发请求/重渲染，做 300ms debounce 或「处理中」标志位挡并发。
- **按区块局部更新**：多表页按 `databaseIds` 只更新对应区块，保住用户已填内容与滚动位置（优于整页 `location.reload()`）。
- **能力探测 + 复用分页**：`typeof db.onUpdated === "function"` 后再调；重新取数仍走 §6 的 `hasMore`/`nextCursor`。

## 9. SDK 调用识别

`parse_html.py` 识别已有 SDK 调用时使用的方法集合：

```text
addRecord|deleteRecord|getRecord|getSchema|query|updateRecord
```

命中后输出 `existing_databases`，后续上传时通过 `import_html.py --databases` 关联这些 database。`uploadImage` / `onUpdated` 不带 `databaseId`，不参与该识别。
