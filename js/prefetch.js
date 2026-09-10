// =============================================================================
// prefetch.js —— 输入哈希 + 预加载管理器（纯逻辑，可在 Node 下单测）
//
// 职责：
//   - simpleHash(input)：对文本 / 二进制做确定性哈希（用于判断输入是否变化）。
//   - createPrefetchManager(parse, load)：解析 + 后台加载的管理器，
//     支持「按 hash 复用已解析结果」「await 未完成的加载」「竞态保护」。
//
// parse(input) → Promise<schem>（失败时 reject）
// load(schem, onProgress) → Promise<any>
// =============================================================================

/** 确定性简单哈希（FNV-1a 32 位 + 字节长度），返回字符串。 */
export function simpleHash(input) {
  let bytes;
  if (typeof input === "string") {
    bytes = new TextEncoder().encode(input);
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else {
    bytes = new TextEncoder().encode(String(input));
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return "h" + (h >>> 0).toString(16) + "-" + bytes.length;
}

/**
 * 创建预加载管理器。
 * @param {(input:any)=>Promise<any>} parse
 * @param {(schem:any, onProgress?:Function)=>Promise<any>} load
 */
export function createPrefetchManager(parse, load) {
  let seq = 0;
  let cur = null; // { key, schem, promise, done }

  async function ensure(input, onProgress) {
    const key = simpleHash(input);

    // 命中：复用已解析的 schem 与未完成的加载 promise
    if (cur && cur.key === key && cur.schem) {
      return { key, schem: cur.schem, promise: cur.promise, reused: true, done: cur.done, race: false };
    }

    const mySeq = ++seq;
    let schem;
    try {
      schem = await parse(input);
    } catch (e) {
      if (mySeq === seq) cur = null; // 清掉可能残留的旧状态
      throw e;
    }

    // 竞态保护：等待解析期间输入已变化 → 丢弃本次结果
    if (mySeq !== seq) {
      return { key, schem: null, promise: Promise.resolve(), reused: false, done: false, race: true };
    }

    const entry = { key, schem, promise: null, done: false };
    let markDone;
    entry.promise = new Promise((resolve) => {
      markDone = resolve;
    });
    cur = entry;

    Promise.resolve()
      .then(() => load(schem, onProgress))
      .catch(() => {})
      .then(() => {
        if (mySeq === seq) entry.done = true;
        markDone();
      });

    return { key, schem, promise: entry.promise, reused: false, done: false, race: false };
  }

  return {
    ensure,
    /** 使已缓存结果失效（模组变化后调用）：后续 ensure 会重新解析并加载。 */
    invalidate() {
      seq++;
      cur = null;
    },
    get current() {
      return cur;
    },
  };
}
