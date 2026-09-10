// =============================================================================
// sources.js —— Mindustry 素材镜像源（超时 + 自动切换 + 最近可用源记忆）
//
// 设计：
//   - 源列表按优先级排列；每次请求用 AbortController 设超时（默认 8s），
//     超时/失败自动切换下一个源。
//   - 成功的源记入 localStorage.msch-source，后续请求优先使用。
//   - 首次（无记录）用小文件探测一次（默认 3s 超时），避免前 16 个并发
//     全部各等 8s。
//
// 纯逻辑，可在 Node 下单测（可注入 fetchImpl / sources / timeoutMs）。
// =============================================================================

export const SOURCES = [
  "https://cdn.jsdelivr.net/gh/Anuken/Mindustry@master/",
  "https://fastly.jsdelivr.net/gh/Anuken/Mindustry@master/",
  "https://gcore.jsdelivr.net/gh/Anuken/Mindustry@master/",
  "https://testingcf.jsdelivr.net/gh/Anuken/Mindustry@master/",
  "https://raw.githack.com/Anuken/Mindustry/master/",
  "https://raw.githubusercontent.com/Anuken/Mindustry/master/",
];

export const DEFAULT_SOURCE = SOURCES[0];
export const DEFAULT_TIMEOUT = 8000;
export const PROBE_TIMEOUT = 3000;
// 探测文件（确实存在于 Mindustry 仓库）
export const PROBE_PATH = "core/assets-raw/sprites/effects/error.png";

const SOURCE_KEY = "msch-source";

/** 主机名（用于状态栏提示）。 */
export function sourceHost(src) {
  return String(src || "").replace(/^https?:\/\//, "").split("/")[0];
}

/** 最近可用源（原始存储值，可能不在给定列表内）。 */
export function getLastGoodSource() {
  try {
    return localStorage.getItem(SOURCE_KEY) || null;
  } catch (e) {
    return null;
  }
}

export function setLastGoodSource(src) {
  try {
    if (src) localStorage.setItem(SOURCE_KEY, src);
  } catch (e) {
    // localStorage 不可用：忽略
  }
}

/** 首选源：最近可用源，否则默认源。 */
export function preferredSource() {
  return getLastGoodSource() || DEFAULT_SOURCE;
}

/** 返回把最近可用源排到最前的源顺序。 */
export function sourceOrder(list = SOURCES) {
  const last = getLastGoodSource();
  const arr = [...list];
  if (last && arr.includes(last)) {
    return [last, ...arr.filter((s) => s !== last)];
  }
  return arr;
}

/** 带超时的 fetch。 */
export async function fetchTimeout(url, ms, fetchImpl = fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetchImpl(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

let probePromise = null;

/** 探测可用源（结果记忆化；成功后写入 localStorage）。 */
export function probeSources({
  sources = SOURCES,
  timeoutMs = PROBE_TIMEOUT,
  probePath = PROBE_PATH,
  fetchImpl = fetch,
} = {}) {
  if (!probePromise) {
    probePromise = (async () => {
      for (const src of sources) {
        try {
          const resp = await fetchTimeout(src + probePath, timeoutMs, fetchImpl);
          if (resp && resp.ok) {
            setLastGoodSource(src);
            return src;
          }
        } catch (e) {
          // 试下一个源
        }
      }
      return null;
    })();
  }
  return probePromise;
}

/** 仅供测试：重置探测记忆。 */
export function resetProbe() {
  probePromise = null;
}

/**
 * 按源顺序获取 Mindustry 素材。
 * @param {string} relPath 相对源根的路径（如 "core/assets-raw/sprites/..."）
 * @param {object} opts { onSwitch(from,to), sources, timeoutMs, fetchImpl, probe }
 * @returns {Promise<Response>} 成功时一定是 ok 的响应
 */
export async function fetchMindustry(relPath, opts = {}) {
  const sources = opts.sources || SOURCES;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT;
  const fetchImpl = opts.fetchImpl || fetch;
  const doProbe = opts.probe !== false;

  if (doProbe && !getLastGoodSource()) {
    await probeSources({ sources, timeoutMs: Math.min(timeoutMs, PROBE_TIMEOUT), fetchImpl });
  }

  const order = sourceOrder(sources);
  const first = order[0];
  let lastErr = null;
  for (let i = 0; i < order.length; i++) {
    const src = order[i];
    try {
      const resp = await fetchTimeout(src + relPath, timeoutMs, fetchImpl);
      if (!resp || !resp.ok) throw new Error("HTTP " + (resp ? resp.status : "0"));
      if (src !== first && typeof opts.onSwitch === "function") opts.onSwitch(first, src);
      if (src !== getLastGoodSource()) setLastGoodSource(src);
      return resp;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("所有镜像源均不可用");
}
