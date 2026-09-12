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
# 类型级默认属性（hasItems/hasLiquids/outputsLiquid/squareSprite/rotate/isDuct）
# 来自同目录的 vanilla_type_flags.py（继承解析后的官方类默认值）。如需从源码
# 重新烘焙该数据模块，可传：
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
    from vanilla_type_flags import TYPE_FLAGS
except ImportError:  # 作为脚本直接运行（同目录）
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from vanilla_type_flags import TYPE_FLAGS

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
             "squareSprite", "rotate", "isDuct", "armored", "noSideBlend")


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
        rotate = ex.get("rotate", tf.get("rot", False))
        if rotate:
            flags["rotate"] = True
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
//   flags?: { hasItems/hasLiquids/outputsLiquid/outputsItems/squareSprite/rotate/
//             isDuct/armored } }。flags 仅记录与类默认不同的值（squareSprite 仅记 false，
//   其余仅记 true）。类型是 render_rules.js 类型规则表的键；flags 是
//   js/blending.js 邻居拼接判定的事实来源。
// =============================================================================
'''


def js_value(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, str):
        return '"%s"' % v
    return str(v)


def emit_blocks(blocks: dict, path: Path):
    lines = [HEAD_BLOCKS.rstrip("\n"), "export const VANILLA_BLOCKS = {"]
    for name in sorted(blocks):
        e = blocks[name]
        parts = ['type: "%s"' % e["type"], "size: %d" % e["size"]]
        if "range" in e:
            parts.append("range: %s" % e["range"])
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
