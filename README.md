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
  js/cn_data.js         全量官方中文名（由 bundle_zh_CN.properties 生成）
  js/inflate.js         zlib 解压封装（DecompressionStream）
  js/parser.js          容器解析 + TypeIO + contentMap + 处理器逻辑提取
  js/render.js          渲染器（与 msch.py 像素级一致）
  js/icons.js           PUA 内容图标解析 + richText 富文本
  js/icons_data.js      PUA 码点表（由 icons.properties 生成）
  js/prefetch.js        输入哈希 + 预加载管理器（可单测）
  js/cache.js           Cache Storage 持久化缓存（v2 + 规范化键 + SWR/TTL）
  js/sources.js         Mindustry 镜像源（手动选择 + 超时 + 自动切换）
  js/zip.js             纯 JS zip 读取器（STORED/DEFLATE，可单测）
  js/mod.js             模组 zip 解析（方块/贴图/bundle，可单测）
  js/names.js           方块显示名（bundle > JSON name > BLOCK_CN，可单测）
  js/history.js         本地历史记录（容量策略纯函数，可单测）
  js/requirements.js    蓝图总耗材计算（可单测）
  js/requirements_data.js 方块耗材表 BLOCK_REQUIREMENTS + 物品中文名 ITEM_CN
  js/main.<VER>.js      入口 UI 逻辑（发布时重命名为 js/main.<VER>.js，用于路径级缓存穿透）
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
>
> **发布须知**：GitHub Pages/中间代理默认 `cache-control: max-age=600`，用户可能看到旧缓存，
> 且 `?v=` 对部分按路径缓存的代理无效。每次发布请：
> 1. 在 `index.html` 顶部注释中**递增版本号 VER**；
> 2. 把入口脚本**重命名**为 `js/main.<VER>.js`（`git mv`）并更新 `index.html` 引用
>    `js/main.<VER>.js?v=<VER>`；
> 3. 同步 `css/style.css?v=<VER>`；页脚版本由 JS 注入（`#footer-ver`），能显示即证明新脚本已加载。

## 二、可选：自托管贴图实现离线（推荐手机使用）

默认情况下，贴图会先尝试 `assets/sprites/<名称>.png`，找不到再按「镜像源」列表自动切换拉取
（见「镜像源」小节，默认首选 `https://gh-proxy.com/https://raw.githubusercontent.com/Anuken/Mindustry/master/`）。

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

- **全量官方中文名 `js/cn_data.js`**：由官方 `bundle_zh_CN.properties` 生成
  （`CN_BLOCKS` 412 条 / `CN_ITEMS` 22 条 / `CN_LIQUIDS` 11 条）。`js/data.js` 的
  `BLOCK_CN`/`CONTENT_CN` 以之为准（旧手写小表仅用于补缺，不覆盖官方名），因此
  `overflow-gate`→溢流门、`underflow-gate`→反向溢流门、`duct` 等均有正确中文名。
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
- **配置影响贴图（v159.7 源码行为）**：`js/data.js` 用 `CONFIG_UNDERLAY` / `CONFIG_OVERLAY`
  描述配置对贴图的影响，`render.js` 在 sprite 层前后绘制：
  - `sorter` / `inverted-sorter` / `item-source`（underlay）：配置为空 → 画 `cross-full`（原色）；
    有内容 → 整格 `TILE×TILE` 填充内容色（`CONTENT_COLORS`）。
  - `unloader` / `duct-unloader`（overlay）：有内容 → 画 `<block>-center`（`unloader-center` /
    `duct-unloader-center`）并乘内容色；为空不画。
  - `liquid-source`（overlay）：`source-bottom` → 空则 `cross`、有液体则用 `fluid.png`
    铺满整格并以液体色着色 → **重画一次该方块 sprite**（最上层）。
  - `CONTENT_COLORS` 按官方 `Items.java` / `Liquids.java`（v159.7）补全物品与液体颜色；
    `opts.config_icons=false` 时上述配置贴图全部跳过。
- **多层贴图 `LAYERS`（base → …，普通中心叠加、无 tint）**：覆盖钻头类（`-rotator` / `-top`，
  碎石机含 `-rotator-bottom`）、生产/电力/防御/单位工厂/载荷/管道等双层建筑（`[base, base-top]`），
  以及 `thruster`、`wave`/`tsunami`/`sublimate`、`liquid-overflow-gate` 等。
  `sorter` / `inverted-sorter` / `liquid-source` **不含 `source-bottom`**（v159.7 中该层并不存在；
  `liquid-source` 的 `source-bottom` 由配置覆盖层在 sprite 之后绘制），否则不透明灰层会盖住配置色。
- **工作态贴图不绘制**：`kiln` / `silicon-smelter` / `silicon-crucible` / `surge-smelter`（DrawFlame）、
  `plastanium-compressor`（DrawFade）、`slag-incinerator`（DrawCrucibleFlame）、
  `combustion/steam/differential/rtg-generator`（DrawWarmupRegion）、`thorium-reactor`（冷却液量门控）、
  `mender` / `mend-projector` / `overdrive-projector` / `overdrive-dome`（heat 脉动）等
  在工作/加热/脉动时才显示，静止渲染不画（已从 `LAYERS` 移除）；
  常驻层（钻头 rotator/top、spore-press、cultivator、illuminator、单位工厂/载荷/管道 top、battery 等）保留。
  `vent-condenser` 层序为 bottom→rotator→mid→base。

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
- **桥 / 质驱按 JSON `type` 判定**（不硬编码名字）：
  - 桥：`type` 以 `Bridge` 结尾（`ItemBridge`/`LiquidBridge`/`BufferedItemBridge`/`DirectionalBridge` 等），
    采集 `<block>-bridge` / `<block>-arrow` 贴图并画连接线与箭头；配对范围取模组 `range`
    （否则 vanilla 值，再否则 4）；桥带宽度**统一与原版一致**（不按模组 `bridgeWidth` 放大）。
  - 质量驱动器：`type === "MassDriver"`（或以之结尾），按 vanilla 规则套用描边；`outlineIcon===false`
    不描边，颜色取 `outlineColor`（支持 `#rrggbb`/`rrggbb`）否则 `#404049`，半径取 `outlineRadius` 否则 4。
  - 电力节点：`type` 以 `PowerNode` 结尾（`PowerNode`/`LongPowerNode` 等）→ 渲染电线（光束）。单节点参数：
    `scale = laserScale ?? 0.25`；`width = round(POWER_LASER_WIDTH * scale / 0.25)`（如 `laserScale 0.4` → 10px）；
    端帽按 `scale`；颜色 `lerp(laserColor1 ?? 白, laserColor2 ?? d9f7b2, 0.1)`（十六进制带/不带 `#` 均可）。
  - 电力目标：vanilla POWER_BLOCKS ∪ 模组 `hasPower===true`/`consumes.power` 方块 ∪ 模组质驱 ∪ 模组电力节点，
    均可被电力节点连线（模组节点之间也能互连）。
- **方块显示名优先级**：模组语言文件 `block.<内部名>.name`（带 `<mod>-` 前缀时也尝试
  `block.<base>.name`）→ 模组 JSON 的 `name` 字段 → 内置 `BLOCK_CN` → 内部名。
  图例、热区提示、处理器按钮等均使用该显示名（`js/names.js` 的 `blockDisplayName`）。
- **不针对任何具体模组**：桥/质驱/电力节点全部按 JSON `type` 字段（`*Bridge` /
  `MassDriver` / `*PowerNode`）+ 运行时注册判定，代码中不含任何模组名（测试所用真实模组仅作
  fixture）；通用性由合成模组测试固定（任意名字 + 类型即可正确分类/注册/渲染）。
- **渲染集成**：贴图查找顺序为 内存 → 模组 `sprites-override` → 本地 `assets/sprites` →
  镜像源（超时/自动切换）→ 模组 `sprites` → 占位；模组方块缺失贴图但 JSON 有 `size`
  时按该尺寸占位；模组方块多层启发式（`<base>-base` 在前、`<base>-top` 在后）仅在
  vanilla `LAYERS` 未定义该块时生效。
- **耗材集成**：总耗材表 = vanilla `BLOCK_REQUIREMENTS` + 所有模组方块（内部名与 base 都注册）；
  物品名优先取模组 bundle `item.<内部名>.name`，物品图标优先模组贴图，候选顺序为
  `item-<ref>` → `<ref>` → `<ref>1` → `item-<ref>1`（后两个为**序号帧**贴图兜底，
  如 `裂位能1.png`、`二级协议1.png`）；模组方块贴图候选同样在最后追加 `<name>1`。
- **限制**：JSON / 混合模组可完整支持建筑与耗材；**纯 dex 模组**（无 JSON 方块定义）
  只能按文件名使用其贴图，无法获取建筑尺寸与耗材。
- 模组变化后会清空内存贴图缓存并自动重渲染当前蓝图；未识别方块会在状态栏提示可能缺少的模组。

## 七、输入即解析与持久化缓存

### 蓝图格式支持（对照 v159.7 Schematics.read）
- **v1**：`msch` + version + zlib；tile config 走 `TypeIO.readObject`（当前主格式）。
- **v0 旧格式**：tile config 为**裸 int + 按方块类型映射**（`mapConfig`）——
  Sorter/Unloader/ItemSource → 物品 id 名（Items.java 声明序）；LiquidSource → 液体 id 名；
  MassDriver/ItemBridge → 打包 Point2 相对位置；LightBlock(illuminator) → 原样 int；其它 → null。
  每块恒 4 字节 config + 1 字节 rotation。
- **版本校验**：`version > 1` 抛错「蓝图来自更新版本的游戏（vN），当前最高支持 v1」。
- **旧方块名回退**：按官方 `SaveFileReader.fallback`（51 项）映射后用于贴图/显示
  （如 `turbine-generator→steam-generator`、`mass-conveyor→payload-conveyor`、`block-forge→constructor`）。
- **LegacyBlock 跳过**：`legacy-mech-pad` / `legacy-unit-factory(-air/-ground)` / `legacy-command-center`
  解析后剔除，不渲染。
- **contentMap**：优先 `JSON.parse`（官方 `{"0":{"copper":1}}`），失败回退旧正则
  （`{0:{surge-alloy:12}}`）。

### 输入即解析 + 预加载
- 在文本框 `input`、文件选择 `change`、拖拽 `drop` 三处加了 **350ms 防抖自动解析**：
  停止输入后立即在后台解析并预加载贴图，状态栏显示「已解析：N 个方块，预加载贴图 done/total…」。
- 预加载由 `js/prefetch.js` 的 `createPrefetchManager` 管理：按输入哈希复用已解析结果，
  并带竞态保护（输入变化时丢弃旧任务结果）。点击「解析并渲染」时若哈希命中，
  直接复用并 `await` 未完成的加载，通常近乎瞬时完成。
- 贴图并发批量加载为 **16**。
- 打开页面时输入框为空（**不再自动缓存/回填蓝图本体**；旧键 `msch-last-input` 会在启动时清理）。
  输入、选择文件、拖拽、点击历史条目均会触发预加载。

### 文件加载行为
- 选择 / 拖入 `.txt` / `.msch` 后，输入框会**填入文件内容本身**（而非文件名占位文本）：
  - 文本型（解码后全为 Base64/空白且以 `bXNja` 开头）→ 直接填入原文（trim）；
  - 二进制 `.msch` → 用 `bytesToBase64()` 转成 Base64 文本填入。
- 状态栏显示「已读取文件：<文件名>（N 字节）」；随后自动解析渲染。
- 输入区下方会出现**来源标签** `#input-source`：文件加载时显示 `文件：<名>（N 字节）`；
  手动编辑/粘贴 textarea、点击历史条目或清空输入时自动隐藏。
- 由于输入框此时就是可再次解析的字符串，**「解析并渲染」可重复点击**，且文件加载同样会写入
  历史记录（不再出现「选文件后无历史」的问题）。

### 本地历史记录
- 解析+渲染成功后写入 `localStorage.msch-history`（JSON 数组，新→旧），条目：
  `{ hash, name, w, h, tiles, time, input }`（`hash` 为输入哈希，`input` 为原始文本）。
- 同 `hash` 去重并置顶（刷新时间）；点击历史项 = 填入输入框并重新解析渲染。
- 容量策略（`js/history.js` 纯函数）：单条 `input > 1MB` 不记录；总条数 ≤ **16**；
  总字节（按 `input.length`）≤ **2MB**，超限从最旧淘汰；写入失败（配额）→ 淘汰一半重试一次，
  仍失败静默放弃。
- UI：「输入蓝图」正下方的「历史记录」小节（PC 左栏同序：输入 → 历史 → 模组 → 渲染选项），列表项显示
  `名称 · 宽×高 · 方块数 · 相对时间`，右侧 `×` 删除，标题旁「清空」；
  小节始终显示，空列表时为弱化提示「暂无历史记录，解析蓝图后自动保存到本地」。

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
- 状态栏会显示「（缓存命中 X 张）」。
- 页脚「清除缓存」：删除**全部** `msch-*` Cache Storage 持久缓存（贴图、模组 zip、含历史版本）
  与时间戳记录，随后**带 `?fresh=` 参数强制刷新页面**（`location.replace`，不污染历史栈），
  以绕过浏览器/代理的 HTTP 缓存取回最新 HTML 与版本化脚本。
  **不会**清除历史记录、透明度、镜像源偏好（这些有各自入口：历史「清空」、滑杆、贴图源下拉）。

### 镜像源（手动选择 + 自动切换 + 超时）

「渲染选项」区可选择**贴图源**（默认「自动（推荐）」，选择持久化在 `localStorage.msch-source-choice`），
也可点「检测镜像」并行探测全部源：结果显示为可点击徽章（`名称 320ms ✓` / `名称 超时 ✗`），
点击即选用该源并自动重新加载贴图重渲染；下拉旁小字显示当前源。

已实测源顺序（可靠的国内镜像最前）：

| key | 显示名 | 前缀 |
|---|---|---|
| `gh-proxy` | gh-proxy.com（国内镜像） | `https://gh-proxy.com/https://raw.githubusercontent.com/Anuken/Mindustry/master/` |
| `ghproxy-net` | ghproxy.net（国内镜像） | `https://ghproxy.net/https://raw.githubusercontent.com/Anuken/Mindustry/master/` |
| `gcore` | jsDelivr Gcore | `https://gcore.jsdelivr.net/gh/Anuken/Mindustry@master/` |
| `testingcf` | jsDelivr TestingCF | `https://testingcf.jsdelivr.net/gh/Anuken/Mindustry@master/` |
| `cdn` | jsDelivr 官方（cdn） | `https://cdn.jsdelivr.net/gh/Anuken/Mindustry@master/` |
| `fastly` | jsDelivr Fastly | `https://fastly.jsdelivr.net/gh/Anuken/Mindustry@master/` |
| `raw` | GitHub Raw（直连） | `https://raw.githubusercontent.com/Anuken/Mindustry/master/` |

- **为何 gh-proxy / gcore 优先**：gh-proxy / ghproxy 直接代理 raw，实测 200、0.6–2s、CORS `*`；
  jsDelivr Gcore 即使是冷文件也 200。jsDelivr 的 `cdn`/`fastly` 对**冷文件**会
  `301 → raw.githubusercontent`（易被墙卡住），故排在其后；`raw` 直连虽 200 但常 12s+ 抖动，作最后兜底。
- **顺序逻辑**：`getSourceOrder()` —— 手动选择时 = `[所选源, ...其余按默认顺序]`；
  自动时 = `[上次可用源(若有), ...默认顺序去重]`。每次请求 `AbortController` **8 秒**超时，
  失败/超时自动切下一个源；成功的源写入 `localStorage.msch-source`。
- 无 last-good 且未手动选择时先用小文件（`core/assets-raw/sprites/effects/error.png`，3 秒超时）
  **探测**一次，避免前 16 个并发全部各等 8 秒。
- 发生切换时状态栏提示「下载超时，已切换镜像：<host>」。
- 耗材面板中未命中模组的原版物品图标也使用当前可用源。
- 缓存键为规范化相对路径（`/__sprites__/…`），切换源后命中缓存的部分无需重下。

### 渲染选项（实时生效 + 持久化）
- 放大倍数、背景（原版蓝图背景 / 透明）、显示网格：变更后立即重渲染。
- **电线透明度**（默认 100%）与**桥透明度**（默认 50%）两条滑杆：`input` 250ms 防抖
  实时重渲染；只影响绘制，不影响贴图缓存/镜像选择；「导出 PNG」使用当前滑杆值。
  选择持久化在 `localStorage.msch-laser-alpha` / `msch-bridge-opacity`（0–100 整数），
  初始化时回填并在首次渲染应用。渲染层对应 `renderSchematic` 的 `opts.laserAlpha`
  与 `opts.bridgeOpacity`（缺省沿用原常量，行为不变）。

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
node --check js/data.js js/cn_data.js js/inflate.js js/parser.js js/render.js js/icons.js js/icons_data.js js/prefetch.js js/cache.js js/sources.js js/zip.js js/mod.js js/requirements.js js/requirements_data.js js/names.js js/history.js js/main.20260910h.js
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
