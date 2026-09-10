# Mindustry 蓝图解析 · 渲染工具（纯前端静态版）

把 `msch.py` 的功能完整移植到**纯前端静态网页**：输入蓝图（Base64 或 `.msch` 文件）→
浏览器内解析 → canvas 渲染（多层贴图、描边、电力激光、桥连接、原版背景全部保留）→
点击处理器弹代码、悬停提示、图例、导出 PNG。

- 无需构建步骤、无需后端，vanilla JS + ES modules。
- 可直接挂到 **GitHub Pages**，也可用 `python3 -m http.server` 本地打开。
- 所有资源均为**相对路径**，部署在子路径（如 `https://用户名.github.io/仓库名/`）也能正常工作。

> **声明**：本项目由 **AI 生成**（AI 辅助设计与编写），仅供学习与个人使用。

## 目录结构

```
web/
  index.html            页面入口
  css/style.css         深色中文界面样式（含 MindustryIcons @font-face）
  js/data.js            常量与中文映射（TILE/LAYERS/BLOCK_CN/CONTENT_CN/…）
  js/inflate.js         zlib 解压封装（DecompressionStream）
  js/parser.js          容器解析 + TypeIO + contentMap + 处理器逻辑提取
  js/render.js          渲染器（与 msch.py 像素级一致）
  js/icons.js           PUA 内容图标解析 + richText 富文本
  js/icons_data.js      PUA 码点表（由 icons.properties 生成）
  js/prefetch.js        输入哈希 + 预加载管理器（可单测）
  js/cache.js           Cache Storage 持久化缓存（v2 + 规范化键 + SWR/TTL）
  js/sources.js         Mindustry 镜像源（超时 + 自动切换 + last-good）
  js/zip.js             纯 JS zip 读取器（STORED/DEFLATE，可单测）
  js/mod.js             模组 zip 解析（方块/贴图/bundle，可单测）
  js/requirements.js    蓝图总耗材计算（可单测）
  js/requirements_data.js 方块耗材表 BLOCK_REQUIREMENTS + 物品中文名 ITEM_CN
  js/app.js             UI 逻辑
  assets/fonts/icon.ttf UI emoji 字体（MindustryIcons）
  assets/icons/*.png    从官方 assets.jar 导出的 530 个原版 PUA 图标
  sprite_index.json     贴图名 → 相对路径索引（blocks/items/aux/all）
  test/parse_test.mjs   Node 一致性测试 + 渲染器/PUA 单测
  package.json          {"type":"module"}
```

## 一、部署到 GitHub Pages（完整步骤）

1. **新建仓库**：在 GitHub 上新建一个仓库（例如 `msch-viz`），可设为 Public。
2. **上传 `web/` 里的内容**：把 `web/` 目录**里面的全部文件**上传到仓库根目录，
   使仓库根目录下直接有 `index.html`、`css/`、`js/`、`sprite_index.json` 等。
   - 网页上传：仓库页面 → **Add file → Upload files**，把 `index.html`、`css`、`js`、
     `sprite_index.json`、`README.md`、`package.json` 一起拖进去，Commit。
   - 或用命令行（把 `你的用户名/仓库名` 换成实际值）：
     ```bash
     cd web
     git init
     git add .
     git commit -m "Mindustry blueprint viewer"
     git branch -M main
     git remote add origin https://github.com/你的用户名/仓库名.git
     git push -u origin main
     ```
3. **开启 Pages**：仓库 **Settings → Pages**。
   - **Source** 选 **Deploy from a branch**；
   - **Branch** 选 `main`，目录选 **`/ (root)`**，Save。
4. 等待约 1 分钟，访问 `https://你的用户名.github.io/仓库名/` 即可。

> 提示：如果入口页面无法访问，确认仓库根目录存在 `index.html`（本工具不需要任何构建/工作流）。

## 二、可选：自托管贴图实现离线（推荐手机使用）

默认情况下，贴图会先尝试 `assets/sprites/<名称>.png`，找不到再自动从 jsDelivr CDN 拉取：

```
https://cdn.jsdelivr.net/gh/Anuken/Mindustry@master/ + 相对路径
```

要完全离线（首次加载更快、无网络也能用），把贴图缓存目录一并上传：

1. 在仓库根目录新建 `assets/sprites/`。
2. 把 `msch.py` 运行后生成的 `sprites/*.png`（或从 Mindustry 仓库下载的贴图，
   **文件名必须是方块/贴图名 + `.png`**，例如 `mass-driver.png`、`laser.png`、
   `schematic-background.png`）全部放入 `assets/sprites/`。
3. 重新 push。页面会自动优先使用本地贴图。

> `schematic-background.png`（原版蓝图卡片背景）也放在 `assets/sprites/` 下。

## 三、更新贴图源的方法

- **指向别的 CDN / 镜像**：编辑 `js/sources.js` 的 `SOURCES`（按优先级排列），
  或删除不需要的源；运行时会自动切换并记住最近可用源。
- **改单个贴图路径**：编辑 `sprite_index.json`（或 `js/data.js` 的 `AUX_PATHS`）。
  索引结构为：
  ```json
  {
    "sprites_base": "core/assets-raw/",
    "blocks": { "mass-driver": "sprites/blocks/distribution/mass-driver.png" },
    "items":  { "item-copper": "sprites/items/item-copper.png" },
    "aux":    { "laser": "sprites/effects/laser.png" },
    "all":    { "gamma": "sprites/units/gamma.png" }
  }
  ```
  - `blocks`/`items`/`aux`：渲染与贴图加载使用（保持不变）。
  - `all`：`sprites/**/*.png` 的「文件名(去扩展名) → 相对路径」全量索引，
    供 PUA 内容图标解析使用；重名取第一个。
  `schematic-background` 比较特殊，位于 `core/assets/`（非 assets-raw），
  已在 `AUX_PATHS` 中用 `[base, path]` 形式配置。
- **重新生成 `sprite_index.json`**：可从 Mindustry 仓库的贴图目录（`tree.json`）重新扫描后覆盖本文件。

## 四、图标字符处理（PUA）

游戏的消息 / 标签文本里会出现私用区字符（U+E000–U+F8FF），分两类：

1. **内容图标**：物品 / 液体 / 方块 / 单位等，由 `icons/icons.properties`
   （格式 `十进制码点=名称|图集区域名`）定义，游戏启动时把区域注册为字体字形。
   前端不依赖静态字体，而是查贴图后用 `<img class="msch-icon">` 呈现：
   - 数据来源：`icons.properties` → `js/icons_data.js`（`ICON_BY_CODE`，626 条）。
   - 解析：`js/icons.js` 的 `resolveIcon(code)`；区域名去掉结尾 `-ui` 得 base，
     依次尝试 `base` 及其去前缀（`block-`/`unit-`/`item-`/`status-`/`team-`）形式，
     在 `sprite_index.json` 的 `all`/`blocks`/`items` 中查路径。
   - 例：`63528` → `water` / `liquid-water` → `sprites/items/liquid-water.png`。
2. **UI emoji**（fontgen 那批，如左右箭头）：在静态字体
   `assets/fonts/icon.ttf`（U+E800–U+F308，137 个字形）里，由 CSS
   `@font-face { font-family:"MindustryIcons" }` 渲染，并挂在正文/代码等
   font-family 回退链末尾。

展示游戏原文的 HTML 上下文（信息板弹窗、信息板 tooltip、处理器代码弹窗、
蓝图标签 `tags.labels`）统一经 `richText()` 渲染；`<img>` 加载失败会回退。
原生 `title` 等纯文本上下文用 `plainTextWithIcons()`：内容图标 → `[官方中文名]`，
UI emoji → 去掉。

> 素材均来自 Mindustry 仓库 / 发布包：`core/assets/icons/icons.properties`
> 与 `core/assets/fonts/icon.ttf`（此处置于 `assets/fonts/`）。

## 五、图标与耗材数据

- **原版图标 `assets/icons/<码点>.png`**：从官方 `assets.jar` 导出 530 个 PUA 内容图标，
  补齐构建期合成的 `-ui` 区域（如 smite / renale / metal-tiles-13 等仓库中无源文件的图标）。
  `js/icons_data.js` 的 `ICON_LOCAL_CODES` 记录这些码点；`richText` 对命中码点优先使用
  本地 `assets/icons/<码点>.png`（离线可用），并把原贴图 CDN 地址写入 `data-fb` 作为
  `onerror` 兜底；未命中的码点仍走 `resolveIcon` 的 raw-sprite 解析（`assets/sprites` 或 CDN）。
- **耗材 `js/requirements_data.js`**：`BLOCK_REQUIREMENTS`（231 个方块）来自 Mindustry
  `Blocks.java` 的 `requirements(...)`，与游戏 `Schematic.requirements()` 一致
  （把每个方块的 requirements 直接累加，无倍率）；`ITEM_CN` 为官方中文名。
  渲染完成后，`js/requirements.js` 的 `computeRequirements()` / `requirementsList()`
  累加并在页面显示「耗材」面板（物品图标 + 中文名 + ×数量，按数量降序）。

## 六、模组支持

支持载入 Mindustry 模组 zip（`.zip` / `.jar` 同格式）来渲染模组建筑并统计模组耗材。

- **载入方式**：输入区下方「模组」小节，多选或拖拽 `.zip/.jar`；显示名称/内部名 + 方块数 + 贴图数；可单个移除或清除全部。
- **持久化**：zip 存入 Cache Storage（缓存名 `msch-mods-v1`，key `/__mods__/<文件名>`），
  下次打开自动重新加载；移除/清除时同步删除。
- **解析**（`js/mod.js` + `js/zip.js`，纯 JS、无第三方库）：
  - `mod.json` 的 `name` 为内部模组名，方块内部名 = `<name>-<文件名去.json>`。
  - 宽松 JSON：支持 `//`、`/* */` 注释、尾随逗号、缺失逗号（部分模组 JSON 不规范）。
  - `requirements` 同时支持 `"item/amount"` 与 `{item,amount}`。
  - `bundles/bundle_zh_CN.properties` / `bundle.properties` 提供方块与物品中文名。
- **贴图懒解压（大模组关键优化）**：解析时只登记 zip 中央目录条目（`sprites/**` 与
  `sprites-override/**` 的 basename → 条目），**不解压字节**；首次真正用到某张贴图时才
  解压该条目并缓存为 Blob（会话内）。`mod.sprites.size` 为**条目数**，
  `mod.spritesOverride.size` 为 override 条目数；UI 显示「贴图 N（按需加载）」。
  `sprites-override` 仍覆盖 `sprites`。
- **渲染集成**：贴图查找顺序为 内存 → 模组 `sprites-override` → 本地 `assets/sprites` →
  镜像源（超时/自动切换）→ 模组 `sprites` → 占位；模组方块缺失贴图但 JSON 有 `size`
  时按该尺寸占位；模组方块多层启发式（`<base>-base` 在前、`<base>-top` 在后）仅在
  vanilla `LAYERS` 未定义该块时生效。
- **耗材集成**：总耗材表 = vanilla `BLOCK_REQUIREMENTS` + 所有模组方块（内部名与 base 都注册）；
  物品名优先取模组 bundle `item.<内部名>.name`，物品图标优先模组贴图（`item-<ref>` / `<ref>`）。
- **限制**：JSON / 混合模组可完整支持建筑与耗材；**纯 dex 模组**（无 JSON 方块定义）
  只能按文件名使用其贴图，无法获取建筑尺寸与耗材。
- 模组变化后会清空内存贴图缓存并自动重渲染当前蓝图；未识别方块会在状态栏提示可能缺少的模组。

## 七、输入即解析与持久化缓存

### 输入即解析 + 预加载
- 在文本框 `input`、文件选择 `change`、拖拽 `drop` 三处加了 **350ms 防抖自动解析**：
  停止输入后立即在后台解析并预加载贴图，状态栏显示「已解析：N 个方块，预加载贴图 done/total…」。
- 预加载由 `js/prefetch.js` 的 `createPrefetchManager` 管理：按输入哈希复用已解析结果，
  并带竞态保护（输入变化时丢弃旧任务结果）。点击「解析并渲染」时若哈希命中，
  直接复用并 `await` 未完成的加载，通常近乎瞬时完成。
- 贴图并发批量加载为 **16**。
- 上次输入保存在 `localStorage.msch-last-input`（超过 300KB 不保存），
  下次打开自动回填并触发预加载（**不自动渲染**）。

### 持久化缓存（Cache Storage API）
- `js/cache.js` 用 `caches.open("msch-cache-v2")` 缓存贴图与 `sprite_index.json`：
  - **命中** → 立即用缓存 Response（blob→`createImageBitmap`），页面刷新后无需重新联网；
  - **stale-while-revalidate**：缓存条目超过 **TTL 7 天**时，先返回缓存、后台 fetch 刷新；
  - **未命中** → 走超时/镜像链路 fetch → **成功才** `cache.put`；失败/超时绝不写缓存。
- **缓存键规范化**：Mindustry 素材统一记为 `location.origin + "/__sprites__/" + relPath`
  （与镜像源无关），换镜像后缓存依然命中，避免重复下载。
- 时间戳记录在 `localStorage.msch-cache-meta`。
- 不可用时（非 https、无 `caches` API、隐私模式、`localStorage` 被禁）自动回退到普通
  `fetch` + 会话内内存缓存，不报错。
- 状态栏会显示「（缓存命中 X 张）」；页脚「清除缓存」会删除所有 `msch-cache-*`
  （含旧版本）与时间戳。

### 镜像源自动切换与超时（`js/sources.js`）
- 源优先级：jsDelivr(cdn/fastly/gcore/testingcf) → githack → raw.githubusercontent。
- 每次请求用 `AbortController` 设 **8 秒**超时；超时/失败自动切下一个源；成功的源
  写入 `localStorage.msch-source`，后续请求优先使用。
- 无 last-good 记录时先用小文件（`core/assets-raw/sprites/effects/error.png`，3 秒超时）
  **探测**一次，避免前 16 个并发全部各等 8 秒。
- 发生切换时状态栏提示「下载超时，已切换镜像：<host>」。
- 耗材面板中未命中模组的原版物品图标也使用当前可用源。

## 八、本地预览

```bash
cd web
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000/
```

直接双击 `index.html`（`file://`）也能打开界面，但浏览器会因同源策略拦截
本地文件读取；请务必用上面的 `http.server` 方式预览。

## 九、运行测试

```bash
cd web
node --check js/data.js js/inflate.js js/parser.js js/render.js js/icons.js js/icons_data.js js/prefetch.js js/cache.js js/sources.js js/zip.js js/mod.js js/requirements.js js/requirements_data.js js/app.js
node test/parse_test.mjs
```

`test/parse_test.mjs` 会读取 `/storage/emulated/0/蓝图.txt` 与 `蓝图.json`
（可在文件顶部修改路径），逐字段比对解析结果，并运行渲染器关键算法单测
（footprint/中心坐标、多层叠加、描边膨胀、flat-top 光束采样、桥配对）
与 PUA 图标单测（`resolveIcon` 锚点、`richText`/`plainTextWithIcons`）。
需要 Node 18+（内置 `DecompressionStream`）。

## 十、浏览器要求

依赖原生 `DecompressionStream('deflate')` 解压蓝图，需较新版本的
Chrome / Edge / Safari / Firefox。若浏览器过旧，页面会给出明确中文提示。

## 十一、许可证

**MIT License**（详见根目录 [LICENSE](LICENSE) 文件）。

本项目由 **AI 生成**，可自由使用、修改与分发，请保留版权声明。
