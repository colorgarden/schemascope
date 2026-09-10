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
  js/app.js             UI 逻辑
  assets/fonts/icon.ttf UI emoji 字体（MindustryIcons）
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

- **指向别的 CDN / 镜像**：编辑 `js/data.js` 中的 `CDN_PREFIX`，改成你的镜像地址
  （格式需为 `前缀 + core/assets-raw/ + sprites/...png` 可拼接）。
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

## 五、本地预览

```bash
cd web
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000/
```

直接双击 `index.html`（`file://`）也能打开界面，但浏览器会因同源策略拦截
本地文件读取；请务必用上面的 `http.server` 方式预览。

## 六、运行测试

```bash
cd web
node --check js/data.js js/inflate.js js/parser.js js/render.js js/icons.js js/icons_data.js js/app.js
node test/parse_test.mjs
```

`test/parse_test.mjs` 会读取 `/storage/emulated/0/蓝图.txt` 与 `蓝图.json`
（可在文件顶部修改路径），逐字段比对解析结果，并运行渲染器关键算法单测
（footprint/中心坐标、多层叠加、描边膨胀、flat-top 光束采样、桥配对）
与 PUA 图标单测（`resolveIcon` 锚点、`richText`/`plainTextWithIcons`）。
需要 Node 18+（内置 `DecompressionStream`）。

## 七、浏览器要求

依赖原生 `DecompressionStream('deflate')` 解压蓝图，需较新版本的
Chrome / Edge / Safari / Firefox。若浏览器过旧，页面会给出明确中文提示。

## 八、许可证

**MIT License**（详见根目录 [LICENSE](LICENSE) 文件）。

本项目由 **AI 生成**，可自由使用、修改与分发，请保留版权声明。
