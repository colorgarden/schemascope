// =============================================================================
// zip.js —— 纯 JS zip 读取器（支持 STORED 与 DEFLATE）
//
// 解析中央目录（EOCD → CD），按需读取条目：
//   openZip(input) → { entries, names, read(name), readText(name), readBlob(name) }
//
// 解压用原生 DecompressionStream('deflate-raw')（浏览器 / Node 18+ 均内置）。
// 该模块不依赖 DOM，可在 Node 下单测。
// =============================================================================

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const _utf8 = new TextDecoder("utf-8", { fatal: false });
function decodeUtf8(bytes) {
  return _utf8.decode(bytes);
}

async function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    return new Uint8Array(await input.arrayBuffer());
  }
  if (input && typeof input.arrayBuffer === "function") {
    return new Uint8Array(await input.arrayBuffer());
  }
  throw new Error("无法识别的 zip 输入类型。");
}

function findEOCD(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      return i;
    }
  }
  return -1;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("当前环境不支持 DecompressionStream，无法解压 zip 内容。");
  }
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 打开 zip。
 * @param {Uint8Array|ArrayBuffer|Blob} input
 * @returns {Promise<{entries:Array, names:string[], read:Function, readText:Function, readBlob:Function}>}
 */
export async function openZip(input) {
  const buf = await toBytes(input);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error("不是有效的 zip 文件（找不到中央目录结束记录）。");

  const total = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true); // 中央目录偏移

  const entries = [];
  for (let i = 0; i < total; i++) {
    if (off + 46 > buf.length || dv.getUint32(off, true) !== CD_SIG) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const uncompSize = dv.getUint32(off + 24, true);
    const fnLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = decodeUtf8(buf.subarray(off + 46, off + 46 + fnLen));
    off += 46 + fnLen + extraLen + commentLen;
    entries.push({ name, method, compSize, uncompSize, localOff, isDir: name.endsWith("/") });
  }

  async function read(target) {
    const e = typeof target === "string" ? entries.find((x) => x.name === target) : target;
    if (!e) return null;
    if (e.isDir) return new Uint8Array(0);
    const lo = e.localOff;
    if (lo + 30 > buf.length || dv.getUint32(lo, true) !== LOCAL_SIG) {
      throw new Error("zip 本地文件头损坏：" + e.name);
    }
    const fnLen = dv.getUint16(lo + 26, true);
    const extraLen = dv.getUint16(lo + 28, true);
    const start = lo + 30 + fnLen + extraLen;
    const comp = buf.subarray(start, start + e.compSize);
    if (e.method === 0) return comp.slice();
    if (e.method === 8) return await inflateRaw(comp);
    throw new Error("不支持的 zip 压缩方式 " + e.method + "：" + e.name);
  }

  return {
    entries,
    names: entries.map((e) => e.name),
    read,
    async readText(target) {
      const bytes = await read(target);
      return bytes ? decodeUtf8(bytes) : null;
    },
    async readBlob(target) {
      const bytes = await read(target);
      return bytes ? new Blob([bytes]) : null;
    },
  };
}

/** 简单并发限制执行器（保持条目顺序不重要）。 */
export async function forEachLimit(items, limit, worker) {
  let idx = 0;
  const runners = [];
  const n = Math.min(limit, items.length);
  for (let i = 0; i < n; i++) {
    runners.push(
      (async () => {
        while (idx < items.length) {
          const cur = idx++;
          await worker(items[cur], cur);
        }
      })()
    );
  }
  await Promise.all(runners);
}
