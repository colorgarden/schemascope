#!/usr/bin/env python3
# =============================================================================
# gen_vanilla_blocks.py —— 从 Mindustry v159.7 Blocks.java 生成类型表
#
# 用途：为 js/render_rules.js 的「类型驱动规则表」提供 vanilla 方块的基础事实：
#   方块内部名(base) -> { type, size, range }
# 其中 type 即官方 Java 类名（Conveyor/Drill/...），size 默认 1，range 仅在有声明时记录。
#
# 复跑命令（需要一个可访问的 Blocks.java 副本，例如 v159.7 官方源码）：
#   python3 tools/gen_vanilla_blocks.py /path/to/Blocks.java
#   # 默认输出：js/vanilla_blocks.js（可用第二个参数改输出路径）
#
# 解析策略：扫描 `字段 = new 类名("方块名")`，跳过以 '-' 开头的绘制后缀
# （DrawRegion("-top") 等），随后在其 {{ ... }} 初始化块（或到 ';' 的短声明）内
# 提取 `size = N` 与 `range = N`。
# =============================================================================
import re
import sys
from pathlib import Path

def find_block_body(src, start):
    """返回 new Type("name") 之后初始化块的正文（不含外层花括号）。"""
    i = start
    while i < len(src) and src[i].isspace():
        i += 1
    if i + 1 < len(src) and src[i] == '{' and src[i + 1] == '{':
        depth = 0
        j = i
        while j < len(src):
            c = src[j]
            if c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    return src[i + 2:j - 1]
            j += 1
        return src[i:]
    # 短声明：到分号结束
    j = src.find(';', i)
    return src[i:j if j >= 0 else len(src)]

def parse(src):
    out = {}
    pat = re.compile(r'new\s+([A-Z][A-Za-z0-9_]*)\s*\(\s*"([^"]*)"\s*\)')
    for m in pat.finditer(src):
        cls, name = m.group(1), m.group(2)
        if not name or name.startswith('-'):
            continue  # 绘制后缀（DrawRegion("-top") 等），不是方块
        body = find_block_body(src, m.end())
        size = 1
        sm = re.search(r'\bsize\s*=\s*(\d+)', body)
        if sm:
            size = int(sm.group(1))
        entry = {'type': cls, 'size': size}
        rm = re.search(r'\brange\s*=\s*([0-9.]+)f?', body)
        if rm:
            try:
                r = float(rm.group(1))
                entry['range'] = int(r) if r == int(r) else r
            except ValueError:
                pass
        # 同名取首个定义（Blocks.java 内不会重复）
        out.setdefault(name, entry)
    return out

def main():
    if len(sys.argv) < 2:
        print('用法: gen_vanilla_blocks.py <Blocks.java> [输出路径]', file=sys.stderr)
        return 2
    src_path = Path(sys.argv[1])
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parent.parent / 'js' / 'vanilla_blocks.js'
    src = src_path.read_text(encoding='utf-8')
    blocks = parse(src)
    lines = []
    lines.append('// =============================================================================')
    lines.append('// vanilla_blocks.js —— 由 tools/gen_vanilla_blocks.py 从 Mindustry v159.7')
    lines.append('//   Blocks.java 自动生成，请勿手改；复跑：')
    lines.append('//   python3 tools/gen_vanilla_blocks.py <Blocks.java>')
    lines.append('//')
    lines.append('// 字段：方块内部名 -> { type: 官方 Java 类名, size: 占地, range?: 连接范围 }')
    lines.append('// 未标注 size 的方块默认 1；类型是 render_rules.js 类型规则表的键。')
    lines.append('// =============================================================================')
    lines.append('export const VANILLA_BLOCKS = {')
    for name in sorted(blocks):
        e = blocks[name]
        parts = ["type: \"%s\"" % e['type'], "size: %d" % e['size']]
        if 'range' in e:
            parts.append('range: %s' % e['range'])
        lines.append('  "%s": { %s },' % (name, ', '.join(parts)))
    lines.append('};')
    lines.append('')
    out_path.write_text('\n'.join(lines), encoding='utf-8')
    print('生成 %s：%d 个方块' % (out_path, len(blocks)))
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
