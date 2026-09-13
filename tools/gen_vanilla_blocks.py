#!/usr/bin/env python3
# =============================================================================
# gen_vanilla_blocks.py —— 从 Mindustry v159.7 Blocks.java 生成两张表：
#   1) js/vanilla_blocks.js   ：方块名 -> { type, size, range?, 拼接/液体属性 }
#   2) js/vanilla_turrets.js  ：炮塔 DrawTurret 的 basePrefix 与 RegionPart 静态几何
#
# 复跑命令（需要一个可访问的 Blocks.java 副本，例如 v159.7 官方源码）：
#   python3 tools/gen_vanilla_blocks.py /path/to/Blocks.java
#   # 默认输出 js/vanilla_blocks.js 与 js/vanilla_turrets.js
#   # 可用第二参数改 Blocks 输出路径；--turrets-out 改炮塔输出路径。
#
# 类型级默认属性（hasItems/hasLiquids/outputsLiquid/squareSprite/isDuct，以及
# 继承解析后的 TYPE_FLAGS）来自同目录的 vanilla_type_flags.py。rotate / rotateDraw
# 单独取 CLASS_ROTATE / CLASS_ROTATE_DRAW —— 即类「自身」是否声明（不解析继承），
# 用于还原官方 Block.drawDefaultPlanRegion 的 `!rotate || !rotateDraw ? 0 : rot` 语义。
# 如需从源码重新烘焙该数据模块，可传：
#   python3 tools/gen_vanilla_blocks.py Blocks.java --src-root <core/src/mindustry>
#
# 解析策略：
#   * 扫描 `字段 = new 类名("方块名")`，跳过以 '-' 开头的绘制后缀与 Draw* / *Part
#     等非方块构造；在其 `{{ ... }}` 初始化块内提取 size/range 与显式属性覆盖。
#   * 对 GenericCrafter/AttributeCrafter/HeatCrafter（outputsItems 依赖 outputItems）
#     按方块体是否声明 outputItems/outputItem、outputLiquids/outputLiquid 解析。
#   * 炮塔：在方块体内找 `drawer = new DrawTurret("prefix")`，解析其 parts.add /
#     parts.addAll 中的 RegionPart（含简单 for 循环展开：duo / cyclone）；
#     setAmmoParts / ShapePart / HaloPart / heat / glow 一律忽略。
# =============================================================================
import re
import sys
from pathlib import Path

try:
    from vanilla_type_flags import TYPE_FLAGS, CLASS_ROTATE, CLASS_ROTATE_DRAW
except ImportError:  # 作为脚本直接运行（同目录）
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from vanilla_type_flags import TYPE_FLAGS, CLASS_ROTATE, CLASS_ROTATE_DRAW

# 非方块构造（drawer / part 等），解析方块定义时跳过。
DRAWER_CLASS_RE = re.compile(r'^(Draw|.*Draw[A-Z])')
PART_CLASSES = {"RegionPart", "ShapePart", "HaloPart", "PartMove", "PartProgress", "DrawPart", "Effect", "BulletType"}


def is_block_class(cls: str) -> bool:
    if cls in PART_CLASSES:
        return False
    if cls.startswith("Draw") or cls.endswith("Part"):
        return False
    if cls.endswith("BulletType") or cls.endswith("UnitType") or cls.endswith("Ability"):
        return False
    return True


def find_matching(s: str, i: int, open_ch: str = "{", close_ch: str = "}") -> int:
    """返回 s[i] 处 open_ch 对应的 close_ch 下标（i 必须指向 open_ch）。"""
    depth = 0
    j = i
    n = len(s)
    while j < n:
        c = s[j]
        if c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return j
        j += 1
    return n


def find_matching_paren(s: str, i: int) -> int:
    return find_matching(s, i, "(", ")")


def find_block_body(src: str, start: int) -> str:
    """返回 new Type("name") 之后初始化块的正文（外层花括号之间）。"""
    i = start
    while i < len(src) and src[i].isspace():
        i += 1
    if i + 1 < len(src) and src[i] == "{" and src[i + 1] == "{":
        j = find_matching(src, i)
        # 去掉最外层 {{ 与 }}，以及初始化块结尾可能存在的分号/空白
        inner = src[i + 2:j - 1]
        return inner
    # 短声明：到分号结束
    j = src.find(";", i)
    return src[i:j if j >= 0 else len(src)]


FLAG_KEYS = ("hasItems", "hasLiquids", "outputsLiquid", "outputsItems",
             "squareSprite", "rotate", "rotateDraw", "isDuct", "armored", "noSideBlend")


def parse_explicit_flags(body: str) -> dict:
    out = {}
    for m in re.finditer(r'\b(%s)\s*=\s*(true|false)' % "|".join(FLAG_KEYS), body):
        out[m.group(1)] = m.group(2) == "true"
    return out


def parse_blocks(src: str) -> dict:
    out = {}
    pat = re.compile(r'new\s+([A-Z][A-Za-z0-9_]*)\s*\(\s*"([^"]*)"\s*\)')
    for m in pat.finditer(src):
        cls, name = m.group(1), m.group(2)
        if not name or name.startswith("-"):
            continue
        if not is_block_class(cls):
            continue
        body = find_block_body(src, m.end())
        size = 1
        sm = re.search(r'\bsize\s*=\s*(\d+)', body)
        if sm:
            size = int(sm.group(1))
        entry = {"type": cls, "size": size}
        rm = re.search(r'\brange\s*=\s*([0-9.]+)f?', body)
        if rm:
            try:
                r = float(rm.group(1))
                entry["range"] = int(r) if r == int(r) else r
            except ValueError:
                pass
        # ---- 电力（Schematic.powerProduction() / powerConsumption()） ----
        # powerProduction：PowerGenerator 家族每刻发电量（缺省 0）。存「显示值」：
        # ThermalGenerator.getDisplayedPowerProduction() 会除以 displayEfficiencyScale
        # （如 turbine-condenser = (3/9) / (1/9) = 3），与官方面板一致。
        prod = 0.0
        pm = re.search(r'\bpowerProduction\s*=\s*([^;]+);', body)
        if pm:
            v = eval_number(pm.group(1), {})
            if v is not None:
                prod = v
        if cls == "ThermalGenerator":
            dm = re.search(r'\bdisplayEfficiencyScale\s*=\s*([^;]+);', body)
            scale = eval_number(dm.group(1), {}) if dm else 1.0
            if scale:
                prod = prod / scale
        if prod:
            entry["powerProduction"] = prod
        # powerUsage：consumePower(X) / consPower = new ConsumePower(X, ...) 的 usage
        # （每刻耗电）。consumePowerBuffered 的 usage=0，不计。
        use = 0.0
        um = re.search(r'\bconsumePower\s*\(\s*([^,);]+)', body)
        if um:
            v = eval_number(um.group(1), {})
            if v is not None:
                use = v
        else:
            cm = re.search(r'\bconsPower\s*=\s*new\s+ConsumePower\s*\(\s*([^,);]+)', body)
            if cm:
                v = eval_number(cm.group(1), {})
                if v is not None:
                    use = v
        if use:
            entry["powerUsage"] = use
        # ---- 物品消耗/产出/弹药/燃料 ----
        items = parse_block_items(body, cls)
        if items["consumeItems"]:
            entry["consumeItems"] = items["consumeItems"]
        if items["outputItems"]:
            entry["outputItems"] = items["outputItems"]
        if items["ammoItems"]:
            entry["ammoItems"] = items["ammoItems"]
        if items["fuelCategories"]:
            entry["fuelCategories"] = items["fuelCategories"]
            entry["fuelItems"] = {c: FUEL_ITEMS[c] for c in items["fuelCategories"]}
        has_item_io = bool(items["consumeItems"] or items["outputItems"])
        if items["craftTime"] and items["craftTime"] > 0 and has_item_io:
            entry["craftTime"] = items["craftTime"]
        if items["itemDuration"] and items["itemDuration"] > 0 and (items["consumeItems"] or items["fuelCategories"]):
            entry["itemDuration"] = items["itemDuration"]
        if items["constructTime"] and items["constructTime"] > 0 and has_item_io:
            entry["constructTime"] = items["constructTime"]
        # ---- 属性解析 ----
        tf = TYPE_FLAGS.get(cls, {})
        ex = parse_explicit_flags(body)

        has_items = ex.get("hasItems", tf.get("hi", False))
        if tf.get("oi") == "dep" and re.search(r'\boutputItems?\b', body):
            has_items = True
        has_liquids = ex.get("hasLiquids", tf.get("hl", False))
        if not has_liquids and re.search(
            r'\b(outputLiquids?|consumeLiquids?|ConsumeLiquids?|ConsumeLiquid|liquidCapacity|liquidConsumed)\b', body
        ):
            has_liquids = True

        outputs_liquid = ex.get("outputsLiquid", tf.get("ol", False))
        if not outputs_liquid and re.search(r'\boutputLiquids?\b', body):
            outputs_liquid = True

        if "outputsItems" in ex:
            outputs_items = ex["outputsItems"]
        elif tf.get("oi") is True:
            outputs_items = True
        elif tf.get("oi") is False:
            outputs_items = False
        else:  # 无覆盖或 dep：等于 hasItems
            outputs_items = has_items

        flags = {}
        if has_items:
            flags["hasItems"] = True
        if has_liquids:
            flags["hasLiquids"] = True
        if outputs_liquid:
            flags["outputsLiquid"] = True
        if outputs_items != has_items:
            flags["outputsItems"] = outputs_items
        square = ex.get("squareSprite", tf.get("sq", True))
        if square is False:
            flags["squareSprite"] = False
        # rotate / rotateDraw：按类「自身」声明（CLASS_ROTATE，官方 Block.rotate 默认
        # false），再叠加方块体显式覆盖。不解析继承：Reconstructor 一类自身未声明
        # rotate，其本体走自绘路径，记为 false（见 vanilla_type_flags.py 注释）。
        rotate = ex.get("rotate", CLASS_ROTATE.get(cls, False))
        if rotate:
            flags["rotate"] = True
        rotate_draw = ex.get("rotateDraw", CLASS_ROTATE_DRAW.get(cls, True))
        if rotate_draw is False:
            flags["rotateDraw"] = False
        is_duct = ex.get("isDuct", tf.get("duct", False))
        if is_duct:
            flags["isDuct"] = True
        if ex.get("armored"):
            flags["armored"] = True
        if flags:
            entry["flags"] = flags
        out.setdefault(name, entry)
    return out


# -----------------------------------------------------------------------------
# 炮塔 DrawTurret / RegionPart
# -----------------------------------------------------------------------------
def split_top_level_plus(expr: str):
    parts, buf, depth, in_str = [], [], 0, False
    for ch in expr:
        if ch == '"':
            in_str = not in_str
        if not in_str:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            elif ch == "+" and depth == 0:
                parts.append("".join(buf))
                buf = []
                continue
        buf.append(ch)
    parts.append("".join(buf))
    return parts


def eval_suffix(expr: str, env: dict):
    """求值 RegionPart 的字符串构造表达式（支持字符串字面量、+、简单三元）。"""
    def atom(a: str):
        a = a.strip()
        while a.startswith("(") and a.endswith(")"):
            # 去掉外层括号（仅当括号成对包裹）
            depth = 0
            ok = True
            for k, ch in enumerate(a):
                if ch == "(":
                    depth += 1
                elif ch == ")":
                    depth -= 1
                    if depth == 0 and k != len(a) - 1:
                        ok = False
                        break
            if not ok:
                break
            a = a[1:-1].strip()
        tm = re.fullmatch(r'(\w+)\s*==\s*(-?\d+)\s*\?\s*"([^"]*)"\s*:\s*"([^"]*)"', a)
        if tm:
            return tm.group(3) if env.get(tm.group(1)) == int(tm.group(2)) else tm.group(4)
        sm = re.fullmatch(r'"([^"]*)"', a)
        if sm:
            return sm.group(1)
        if re.fullmatch(r'-?\d+', a):
            return a
        if a in env:
            return str(env[a])
        return None

    total = ""
    for p in split_top_level_plus(expr):
        v = atom(p)
        if v is None:
            return None
        total += v
    return total


def eval_number(expr: str, env: dict):
    """求值 Mindustry 数值表达式（如 22 / 4f, -1f / 4f, 2f * 4f / 3f, fi * 4f）。"""
    e = expr.strip()
    e = re.sub(r'(\d)f\b', r'\1', e)
    for k, v in env.items():
        e = re.sub(r'\b%s\b' % re.escape(k), str(v), e)
    try:
        return float(eval(e, {"__builtins__": {}}, {}))
    except Exception:
        return None


# -----------------------------------------------------------------------------
# 物品消耗/产出（consumeItem(s)/outputItem(s)/ammo()/燃料类别）
#
# 官方事实（v159.7）：
#   * GenericCrafter：`consumeItems(with(Items.lead,1, Items.sand,1))`、
#     `outputItem = new ItemStack(Items.metaglass,1)` 均按「每 craftTime 一次」；
#     速率 = amount * 60 / craftTime（每秒）。craftTime 类默认 80（GenericCrafter.java:40）。
#   * ConsumeGenerator：每 itemDuration ticks 消耗 1 个；ConsumeItemFlammable 等
#     用 filter 判定物品类别（见 world/consumers/ConsumeItem*.java）。
#   * ItemTurret：`ammo(Items.copper, bullet, Items.graphite, bullet, …)` 弹药列表。
# -----------------------------------------------------------------------------
ITEM_PROPS = {
    # 来自 1597_Items.java 的 items 属性（只列非零 flammability/explosiveness/radioactivity）
    "coal": {"flammability": 1.0, "explosiveness": 0.2},
    "thorium": {"explosiveness": 0.2, "radioactivity": 1.0},
    "plastanium": {"flammability": 0.1, "explosiveness": 0.2},
    "phase-fabric": {"radioactivity": 0.6},
    "spore-pod": {"flammability": 1.15},
    "blast-compound": {"flammability": 0.4, "explosiveness": 1.2},
    "pyratite": {"flammability": 1.4, "explosiveness": 0.4},
    "fissile-matter": {"radioactivity": 1.5},
    "dormant-cyst": {"flammability": 0.1},
}
ITEM_ORDER = [
    "scrap", "copper", "lead", "graphite", "coal", "titanium", "thorium", "silicon",
    "plastanium", "phase-fabric", "surge-alloy", "spore-pod", "sand", "blast-compound",
    "pyratite", "metaglass", "beryllium", "tungsten", "oxide", "carbide",
    "fissile-matter", "dormant-cyst",
]
# 类别 → (属性名, 阈值)；阈值 = ConsumeItemFlammable/Explosive/Radioactive 默认 0.2
FUEL_ATTR = {
    "flammable": ("flammability", 0.2),
    "explosive": ("explosiveness", 0.2),
    "radioactive": ("radioactivity", 0.2),
}


def _compute_fuel_items():
    out = {}
    for cat, (attr, thr) in FUEL_ATTR.items():
        items = []
        for it in ITEM_ORDER:
            if ITEM_PROPS.get(it, {}).get(attr, 0.0) >= thr:
                items.append(it)
        out[cat] = items
    return out


FUEL_ITEMS = _compute_fuel_items()

# 周期字段的类默认值（Blocks.java 未声明时回退；来源见各官方类）
CYCLE_DEFAULTS = {
    "craftTime": {"GenericCrafter": 80.0, "AttributeCrafter": 80.0, "HeatCrafter": 80.0},
    "itemDuration": {"ConsumeGenerator": 120.0, "HeaterGenerator": 120.0,
                     "ImpactReactor": 60.0, "NuclearReactor": 120.0},
    "constructTime": {"Reconstructor": 120.0},
}


def strip_comments(s: str) -> str:
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    s = re.sub(r"//[^\n]*", "", s)
    return s


def split_top_commas(s: str):
    """按顶层逗号切分（忽略字符串与 ()/[]/{} 内部）。"""
    parts, buf, depth, in_str, esc = [], [], 0, False, False
    for ch in s:
        if in_str:
            buf.append(ch)
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
            buf.append(ch)
            continue
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(buf))
            buf = []
            continue
        buf.append(ch)
    parts.append("".join(buf))
    return parts


def camel_to_kebab(n: str) -> str:
    return re.sub(r"([a-z0-9])([A-Z])", r"\1-\2", n).lower()


def parse_item_pairs(args: str):
    """解析 with(a,n,b,m) / ItemStack(...) / ItemStack[]{...} / 裸 Items.x 列表 → [[item,amount]]。"""
    s = args.strip()
    m = re.fullmatch(r"with\s*\((.*)\)", s, re.S)
    if m:
        s = m.group(1)
    m = re.fullmatch(r"new\s+ItemStack\s*\[\]\s*\{(.*)\}", s, re.S)
    if m:
        s = m.group(1)
    parts = split_top_commas(s)
    out, i = [], 0
    while i < len(parts):
        p = parts[i].strip()
        am = re.fullmatch(r"Items\.([A-Za-z0-9_]+)", p)
        if am:
            item, amount = camel_to_kebab(am.group(1)), 1
            if i + 1 < len(parts) and re.fullmatch(r"-?\d+", parts[i + 1].strip()):
                amount = int(parts[i + 1].strip())
                i += 1
            out.append([item, amount])
        else:
            sm = re.fullmatch(r"new\s+ItemStack\s*\(\s*Items\.([A-Za-z0-9_]+)\s*,\s*(\d+)\s*\)", p)
            if sm:
                out.append([camel_to_kebab(sm.group(1)), int(sm.group(2))])
        i += 1
    return out


def find_matching_paren_in(s: str, i: int) -> int:
    depth = 0
    while i < len(s):
        if s[i] == "(":
            depth += 1
        elif s[i] == ")":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return len(s)


def parse_block_items(body: str, cls: str):
    """提取方块的物品消耗/产出/弹药/燃料类别与周期字段（含类默认回退）。"""
    b = strip_comments(body)
    res = {"consumeItems": [], "outputItems": [], "ammoItems": [], "fuelCategories": []}
    for m in re.finditer(r"\bconsumeItems?\s*\(", b):
        e = find_matching_paren_in(b, m.end() - 1)
        res["consumeItems"].extend(parse_item_pairs(b[m.end():e]))
    for m in re.finditer(r"\boutputItems?\s*=\s*(.+?);", b, re.S):
        res["outputItems"].extend(parse_item_pairs(m.group(1)))
    for m in re.finditer(r"\bammo\s*\(", b):
        e = find_matching_paren_in(b, m.end() - 1)
        for part in split_top_commas(b[m.end():e]):
            im = re.fullmatch(r"\s*Items\.([A-Za-z0-9_]+)\s*", part)
            if im:
                res["ammoItems"].append(camel_to_kebab(im.group(1)))
    for m in re.finditer(r"new\s+ConsumeItem(Flammable|Explosive|Radioactive)\s*\(", b):
        cat = {"Flammable": "flammable", "Explosive": "explosive", "Radioactive": "radioactive"}[m.group(1)]
        if cat not in res["fuelCategories"]:
            res["fuelCategories"].append(cat)
    for key in ("craftTime", "itemDuration", "constructTime"):
        m = re.search(r"\b%s\s*=\s*([^;]+);" % key, b)
        v = eval_number(m.group(1), {}) if m else None
        if v is None:
            v = CYCLE_DEFAULTS.get(key, {}).get(cls)
        res[key] = v
    return res


def parse_region_part(src: str, start: int, env: dict, out_parts: list):
    """解析 src[start:] 处的 new RegionPart(...)，追加到 out_parts。"""
    paren = src.find("(", start)
    if paren < 0:
        return start
    pend = find_matching_paren(src, paren)
    arg = src[paren + 1:pend]
    suffix = eval_suffix(arg, env) if arg.strip() else ""
    if suffix is None:
        return pend
    # 可选初始化块 {{ ... }}
    body = ""
    i = pend + 1
    while i < len(src) and src[i].isspace():
        i += 1
    if i + 1 < len(src) and src[i] == "{" and src[i + 1] == "{":
        bend = find_matching(src, i)
        body = src[i + 2:bend - 1]
        i = bend + 1

    part = {"suffix": suffix, "x": 0.0, "y": 0.0, "mirror": False, "under": False}
    sm = re.search(r'\bname\s*=\s*"([^"]*)"', body)
    if sm:
        part["suffix"] = None  # 使用 name 覆盖
        part["name"] = sm.group(1)
    xm = re.search(r'\bx\s*=\s*([^;]+?);', body)
    if xm:
        v = eval_number(xm.group(1), env)
        if v is not None:
            part["x"] = v
    ym = re.search(r'\by\s*=\s*([^;]+?);', body)
    if ym:
        v = eval_number(ym.group(1), env)
        if v is not None:
            part["y"] = v
    if re.search(r'\bmirror\s*=\s*true', body):
        part["mirror"] = True
    if re.search(r'\bunder\s*=\s*true', body):
        part["under"] = True
    draw_region = not re.search(r'\bdrawRegion\s*=\s*false', body)
    if draw_region:
        out_parts.append(part)
    return i


def find_loops(body: str):
    """返回 body 中的简单 for 循环：(start, end, var, [values])。"""
    loops = []
    for m in re.finditer(r'for\s*\(', body):
        p = find_matching_paren(body, m.end() - 1)
        header = body[m.end():p]
        hm = re.fullmatch(
            r'\s*int\s+(\w+)\s*=\s*(-?\d+)\s*;\s*\1\s*([<>])\s*(-?\d+)\s*;\s*\1\s*(\+\+|--)',
            header.strip(),
        )
        if not hm:
            continue
        var, a, op, b, inc = hm.group(1), int(hm.group(2)), hm.group(3), int(hm.group(4)), hm.group(5)
        vals = []
        v = a
        while (v < b) if op == "<" else (v > b):
            vals.append(v)
            v += 1 if inc == "++" else -1
        # 主体
        j = p + 1
        while j < len(body) and body[j].isspace():
            j += 1
        if j < len(body) and body[j] == "{":
            e = find_matching(body, j)
            body_txt = body[j + 1:e]
            end = e + 1
        else:
            e = body.find(";", j)
            body_txt = body[j:e]
            end = e + 1
        loops.append((j + 1, end, var, vals, body_txt))
    return loops


def parse_drawturret_parts(init_body: str):
    parts = []
    loops = sorted(find_loops(init_body), key=lambda x: x[0])
    pos = 0
    for (bs, be, var, vals, body_txt) in loops:
        if bs > pos:
            _scan_parts(init_body[pos:bs], parts, {})
        for val in vals:
            env = {var: val}
            for am in re.finditer(r'int\s+(\w+)\s*=\s*%s\s*;' % re.escape(var), body_txt):
                env[am.group(1)] = val
            _scan_parts(body_txt, parts, env)
        pos = be
    if pos < len(init_body):
        _scan_parts(init_body[pos:], parts, {})
    return parts


def _scan_parts(text: str, out_parts: list, env: dict):
    """扫描 parts.add(...) / parts.addAll(...) 中的所有 new RegionPart（含 children 展平）。"""
    for m in re.finditer(r'\bparts\.add(?:All)?\s*\(', text):
        p = find_matching_paren(text, m.end() - 1)
        args = text[m.end():p]
        for rm in re.finditer(r'new\s+RegionPart\b', args):
            parse_region_part(args, rm.start(), env, out_parts)


def parse_turrets(src: str) -> dict:
    out = {}
    pat = re.compile(r'new\s+([A-Z][A-Za-z0-9_]*)\s*\(\s*"([^"]*)"\s*\)')
    for m in pat.finditer(src):
        cls, name = m.group(1), m.group(2)
        if not name or not is_block_class(cls):
            continue
        body = find_block_body(src, m.end())
        dm = re.search(r'drawer\s*=\s*new\s+DrawTurret\s*\(', body)
        if not dm:
            continue
        paren = body.find("(", dm.end() - 1)
        pend = find_matching_paren(body, paren)
        arg = body[paren + 1:pend].strip()
        base_prefix = ""
        bm = re.fullmatch(r'"([^"]*)"', arg)
        if bm:
            base_prefix = bm.group(1)
        # 初始化块
        i = pend + 1
        while i < len(body) and body[i].isspace():
            i += 1
        parts = []
        if i + 1 < len(body) and body[i] == "{" and body[i + 1] == "{":
            bend = find_matching(body, i)
            init_body = body[i + 2:bend - 1]
            parts = parse_drawturret_parts(init_body)
        if base_prefix or parts:
            out[name] = {"basePrefix": base_prefix, "parts": parts}
    return out


# -----------------------------------------------------------------------------
# 输出
# -----------------------------------------------------------------------------
HEAD_BLOCKS = '''// =============================================================================
// vanilla_blocks.js —— 由 tools/gen_vanilla_blocks.py 从 Mindustry v159.7
//   Blocks.java 自动生成，请勿手改；复跑：
//   python3 tools/gen_vanilla_blocks.py <Blocks.java>
//
// 字段：方块内部名 -> { type: 官方 Java 类名, size: 占地, range?: 连接范围,
//   powerProduction?: 每刻发电（PowerGenerator.getDisplayedPowerProduction()，
//     缺省 0；storage 值=原始值，ThermalGenerator 已按 displayEfficiencyScale 折算）,
//   powerUsage?: 每刻耗电（consumePower 的 consPower.usage，缺省 0）,
//   consumeItems?: [[物品, 数量], …]（consumeItem(s)，数量为「每周期」量）,
//   outputItems?: [[物品, 数量], …]（outputItem(s)，每周期量）,
//   ammoItems?: [物品, …]（ItemTurret.ammo(...) 的弹药列表，按出现顺序）,
//   fuelCategories?: ["flammable"|"explosive"|"radioactive", …]（ConsumeItem* 类别）,
//   fuelItems?: {类别: [可烧物品, …]}（按 ConsumeItem* filter 阈值 + Items 属性静态算出）,
//   craftTime?: 制造周期（ticks，缺省该类默认；速率 = 数量*60/craftTime）,
//   itemDuration?: 发电机每烧一个物品的 ticks（速率 = 数量*60/itemDuration）,
//   constructTime?: 单位工厂建造周期（ticks；Reconstructor 的物品输入速率用）,
//   flags?: { hasItems/hasLiquids/outputsLiquid/outputsItems/squareSprite/rotate/
//             rotateDraw/isDuct/armored } }。flags 仅记录与类默认不同的值
//   （squareSprite/rotateDraw 仅记 false，其余仅记 true）。类型是 render_rules.js
//   类型规则表的键；flags 是 js/blending.js 邻居拼接判定的事实来源。
//   rotate / rotateDraw 按类「自身」声明（CLASS_ROTATE/CLASS_ROTATE_DRAW，不解析
//   继承），对应官方 Block.drawDefaultPlanRegion 的旋转条件；通用渲染路径据此
//   决定是否把蓝图 rot 施加到方块贴图上（见 render_rules.isRotatableBlock）。
// =============================================================================
'''


def js_value(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, str):
        return '"%s"' % v
    return str(v)


def emit_pairs(pairs):
    return "[%s]" % ", ".join('["%s", %s]' % (it, js_value(n)) for it, n in pairs)


def emit_list(items):
    return "[%s]" % ", ".join('"%s"' % x for x in items)


def emit_fuel_items(d):
    return "{ %s }" % ", ".join("%s: %s" % (k, emit_list(v)) for k, v in d.items())


def emit_blocks(blocks: dict, path: Path):
    lines = [HEAD_BLOCKS.rstrip("\n"), "export const VANILLA_BLOCKS = {"]
    for name in sorted(blocks):
        e = blocks[name]
        parts = ['type: "%s"' % e["type"], "size: %d" % e["size"]]
        if "range" in e:
            parts.append("range: %s" % e["range"])
        if "powerProduction" in e:
            parts.append("powerProduction: %s" % js_value(e["powerProduction"]))
        if "powerUsage" in e:
            parts.append("powerUsage: %s" % js_value(e["powerUsage"]))
        if "consumeItems" in e:
            parts.append("consumeItems: %s" % emit_pairs(e["consumeItems"]))
        if "outputItems" in e:
            parts.append("outputItems: %s" % emit_pairs(e["outputItems"]))
        if "ammoItems" in e:
            parts.append("ammoItems: %s" % emit_list(e["ammoItems"]))
        if "fuelCategories" in e:
            parts.append("fuelCategories: %s" % emit_list(e["fuelCategories"]))
        if "fuelItems" in e:
            parts.append("fuelItems: %s" % emit_fuel_items(e["fuelItems"]))
        if "craftTime" in e:
            parts.append("craftTime: %s" % js_value(e["craftTime"]))
        if "itemDuration" in e:
            parts.append("itemDuration: %s" % js_value(e["itemDuration"]))
        if "constructTime" in e:
            parts.append("constructTime: %s" % js_value(e["constructTime"]))
        if e.get("flags"):
            fl = ", ".join("%s: %s" % (k, js_value(v)) for k, v in e["flags"].items())
            parts.append("flags: { %s }" % fl)
        lines.append('  "%s": { %s },' % (name, ", ".join(parts)))
    lines.append("};")
    lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")
    print("生成 %s：%d 个方块" % (path, len(blocks)))


HEAD_TURRETS = '''// =============================================================================
// vanilla_turrets.js —— 由 tools/gen_vanilla_blocks.py 从 Mindustry v159.7
//   Blocks.java 自动生成，请勿手改；复跑：
//   python3 tools/gen_vanilla_blocks.py <Blocks.java>
//
// 仅收录显式声明 `drawer = new DrawTurret(...)` 的炮塔（basePrefix 非空或有部件）。
// 字段：方块内部名 -> { basePrefix: string, parts: [
//   { suffix: string|null, name?: string, x: number, y: number,
//     mirror: boolean, under: boolean } ] }
//   - suffix 为 RegionPart 的后缀；贴图名 = 方块名 + suffix（官方 RegionPart 命名）。
//   - x/y 为 Mindustry 世界单位（×4 = 贴图像素），y 轴向上；渲染时屏幕 y 取反。
//   - mirror=true 时官方使用 <名>-r / <名>-l 两张镜像贴图。
//   - 仅静态几何：heat/glow/ShapePart/HaloPart/setAmmoParts/进度动画均已忽略。
// =============================================================================
'''


def emit_turrets(turrets: dict, path: Path):
    lines = [HEAD_TURRETS.rstrip("\n"), "export const VANILLA_TURRETS = {"]
    for name in sorted(turrets):
        t = turrets[name]
        lines.append('  "%s": { basePrefix: "%s", parts: [' % (name, t["basePrefix"]))
        for p in t["parts"]:
            bits = []
            if p.get("suffix") is None:
                bits.append("suffix: null")
                bits.append('name: "%s"' % p.get("name", ""))
            else:
                bits.append('suffix: "%s"' % p["suffix"])
            bits.append("x: %s" % js_value(p["x"]))
            bits.append("y: %s" % js_value(p["y"]))
            bits.append("mirror: %s" % js_value(p["mirror"]))
            bits.append("under: %s" % js_value(p["under"]))
            lines.append("    { %s }," % ", ".join(bits))
        lines.append("  ] },")
    lines.append("};")
    lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")
    print("生成 %s：%d 个炮塔" % (path, len(turrets)))


CLASS_ROTATE_HEAD = '''

# -----------------------------------------------------------------------------
# CLASS_ROTATE / CLASS_ROTATE_DRAW —— 类「自身」是否声明 rotate / rotateDraw
#
# 与上面的 TYPE_FLAGS 不同：这里**不解析继承**，只记录该类构造器/字段初始化里
# 显式写下的 `rotate = true/false`（见官方 Block.java：rotate 默认 false）。
# 这是 js/vanilla_blocks.js 的 rotate 标志来源（按 v159.7 类文件逐一核对）：
#   * rotate=false 的方块（Router/Unloader/OverflowGate/Junction/Sorter…）通用静态
#     绘制恒取 0°，不随蓝图 rot 旋转。
#   * 继承自父类的 rotate（如 Reconstructor 的 UnitBlock.rotate=true）不在本表；
#     这类类本身未声明 rotate，故按 false 处理（其本体走各自的自绘路径）。
# CLASS_ROTATE_DRAW 默认 true；显式 false 的类（HeatConductor/HeatProducer/
# HeaterGenerator/UnitAssembler/UnitAssemblerModule/RegenProjector）在官方
# Block.drawDefaultPlanRegion 里也取 0°（`!rotate || !rotateDraw ? 0 : rotation*90`）。
# -----------------------------------------------------------------------------
'''


def collect_class_rotate(src_root: Path):
    """按类体解析每个类「自身」声明的 rotate / rotateDraw（不解析继承）。"""
    rot, rdraw = {}, {}
    for f in src_root.rglob("*.java"):
        raw = f.read_text(encoding="utf-8", errors="ignore")
        s = re.sub(r"/\*.*?\*/", "", raw, flags=re.S)
        s = re.sub(r"//[^\n]*", "", s)
        s = re.sub(r'"(\\.|[^"\\])*"', '""', s)
        for m in re.finditer(r"\b(?:class|interface|enum)\s+(\w+)", s):
            nm = m.group(1)
            bi = s.find("{", m.end())
            if bi < 0:
                continue
            body = s[bi + 1:find_matching(s, bi)]
            if nm not in rot:
                rm = re.search(r"\brotate\s*=\s*(true|false)", body)
                if rm:
                    rot[nm] = rm.group(1) == "true"
            if nm not in rdraw:
                dm = re.search(r"\brotateDraw\s*=\s*(true|false)", body)
                if dm:
                    rdraw[nm] = dm.group(1) == "true"
    return rot, rdraw


def bake_type_flags(blocks_src: str, src_root: Path):
    """（可选）从官方类源码重新烘焙 vanilla_type_flags.py。"""
    classes = {}
    for f in src_root.rglob("*.java"):
        raw = f.read_text(encoding="utf-8", errors="ignore")
        s = re.sub(r"/\*.*?\*/", "", raw, flags=re.S)
        s = re.sub(r"//[^\n]*", "", s)
        s = re.sub(r'"(\\.|[^"\\])*"', '""', s)
        for m in re.finditer(r"\bclass\s+(\w+)(?:\s+extends\s+([\w.]+))?", s):
            nm, ext = m.group(1), (m.group(2) or "").split(".")[-1]
            if nm in classes:
                continue
            flags = {}
            for fm in re.finditer(
                r"\b(hasItems|hasLiquids|outputsLiquid|squareSprite|rotate|isDuct|noSideBlend)\s*=\s*(true|false)", s
            ):
                flags[fm.group(1)] = fm.group(2) == "true"
            oi = re.search(r"public\s+boolean\s+outputsItems\(\)\s*\{", s)
            oi_ret = "inherit"
            if oi:
                seg = s[oi.end():oi.end() + 160]
                rm = re.search(r"return\s+([^;]+);", seg)
                oi_ret = rm.group(1).strip() if rm else "?"
            classes[nm] = {"ext": ext, "flags": flags, "oi": oi_ret}

    def resolve(n, seen=None):
        if seen is None:
            seen = set()
        if n in seen or n not in classes:
            return {}, "inherit"
        seen.add(n)
        base, boi = resolve(classes[n]["ext"], seen)
        base = dict(base)
        base.update(classes[n]["flags"])
        oi = classes[n]["oi"] if classes[n]["oi"] != "inherit" else boi
        return base, oi

    lines = [
        "#!/usr/bin/env python3",
        "# 自动生成：Mindustry v159.7 方块类型的类级默认属性（继承解析后）。请勿手改。",
        "# 由 tools/gen_vanilla_blocks.py --src-root <core/src/mindustry> 生成。",
        "TYPE_FLAGS = {",
    ]
    for t in sorted(classes):
        fl, oi = resolve(t)
        d = {}
        if fl.get("hasItems"):
            d["hi"] = True
        if fl.get("hasLiquids"):
            d["hl"] = True
        if fl.get("outputsLiquid"):
            d["ol"] = True
        if fl.get("squareSprite") is False:
            d["sq"] = False
        if fl.get("rotate"):
            d["rot"] = True
        if fl.get("isDuct"):
            d["duct"] = True
        if fl.get("noSideBlend"):
            d["nsb"] = True
        if oi == "true":
            d["oi"] = True
        elif oi == "false":
            d["oi"] = False
        elif "outputItems" in oi:
            d["oi"] = "dep"
        if d:
            lines.append("    %r: {%s}," % (t, ", ".join("%r: %r" % (k, v) for k, v in sorted(d.items()))))
    lines.append("}")
    lines.append(CLASS_ROTATE_HEAD.strip("\n"))
    cr, crd = collect_class_rotate(src_root)
    lines.append("")
    lines.append("CLASS_ROTATE = {")
    for t in sorted(cr):
        lines.append("    %r: %r," % (t, cr[t]))
    lines.append("}")
    lines.append("")
    lines.append("CLASS_ROTATE_DRAW = {")
    for t in sorted(crd):
        lines.append("    %r: %r," % (t, crd[t]))
    lines.append("}")
    lines.append("")
    out = Path(__file__).resolve().parent / "vanilla_type_flags.py"
    out.write_text("\n".join(lines), encoding="utf-8")
    print("重新生成 %s" % out)


def main():
    if len(sys.argv) < 2:
        print("用法: gen_vanilla_blocks.py <Blocks.java> [vanilla_blocks.js] "
              "[--turrets-out vanilla_turrets.js] [--src-root core/src/mindustry]", file=sys.stderr)
        return 2
    src_path = Path(sys.argv[1])
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 and not sys.argv[2].startswith("--") \
        else Path(__file__).resolve().parent.parent / "js" / "vanilla_blocks.js"
    turrets_out = Path(__file__).resolve().parent.parent / "js" / "vanilla_turrets.js"
    src_root = None
    args = sys.argv[2:]
    for k, a in enumerate(args):
        if a == "--turrets-out" and k + 1 < len(args):
            turrets_out = Path(args[k + 1])
        if a == "--src-root" and k + 1 < len(args):
            src_root = Path(args[k + 1])

    src = src_path.read_text(encoding="utf-8")
    if src_root:
        bake_type_flags(src, src_root)
    blocks = parse_blocks(src)
    turrets = parse_turrets(src)
    emit_blocks(blocks, out_path)
    emit_turrets(turrets, turrets_out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
