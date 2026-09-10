// =============================================================================
// sources.js —— Mindustry 素材镜像源（手动选择 + 超时 + 自动切换 + 最近可用源）
//
// 源顺序（本设备实测，可靠国内镜像最前）：
//   gh-proxy.com → ghproxy.net → jsDelivr Gcore → jsDelivr TestingCF →
//   jsDelivr cdn → jsDelivr Fastly → GitHub Raw
// 说明：jsDelivr 的 cdn/fastly 对「冷文件」会 301 到 raw.githubusercontent（易被墙卡住），
//       故排在国内镜像与 Gcore 之后；gh-proxy/ghproxy 直接代理 raw，实测 0.6–2s 且 CORS *。
//
// 选择逻辑：
//   - 手动选择（localStorage.msch-source-choice）→ [所选源, ...其余按默认顺序]
//   - 自动 → [上次可用源(msch-source，若有), ...默认顺序去重]
//   - 每次请求 8s 超时，失败/超时自动切下一个源；成功的源写入 msch-source。
//
// 纯逻辑，可在 Node 下单测（可注入 fetchImpl / sources / timeoutMs）。
// =============================================================================

export const SOURCE_DEFS = [
  {
    key: "gh-proxy",
    label: "gh-proxy.com（国内镜像）",
    url: "https://gh-proxy.com/https://raw.githubusercontent.com/Anuken/Mindustry/master/",
  },
  {
    key: "ghproxy-net",
    label: "ghproxy.net（国内镜像）",
    url: "https://ghproxy.net/https://raw.githubusercontent.com/Anuken/Mindustry/master/",
  },
  {
    key: "gcore",
    label: "jsDelivr Gcore",
    url: "https://gcore.jsdelivr.net/gh/Anuken/Mindustry@master/",
  },
  {
    key: "testingcf",
    label: "jsDelivr TestingCF",
    url: "https://testingcf.jsdelivr.net/gh/Anuken/Mindustry@master/",
  },
  {
    key: "cdn",
    label: "jsDelivr 官方（cdn）",
    url: "https://cdn.jsdelivr.net/gh/Anuken/Mindustry@master/",
  },
  {
    key: "fastly",
    label: "jsDelivr Fastly",
    url: "https://fastly.jsdelivr.net/gh/Anuken/Mindustry@master/",
  },
  {
    key: "raw",
    label: "GitHub Raw（直连）",
    url: "https://raw.githubusercontent.com/Anuken/Mindustry/master/",
  },
];

/** 默认源顺序（URL 列表）。 */
export const DEFAULT_SOURCES = SOURCE_DEFS.map((d) => d.url);
/** 向后兼容别名。 */
export const SOURCES = DEFAULT_SOURCES;
export const DEFAULT_SOURCE = DEFAULT_SOURCES[0];
export const DEFAULT_TIMEOUT = 8000;
export const PROBE_TIMEOUT = 3000;
// 探测文件（确实存在于 Mindustry 仓库）
export const PROBE_PATH = "core/assets-raw/sprites/effects/error.png";

const SOURCE_KEY = "msch-source"; // 上次可用源
const CHOICE_KEY = "msch-source-choice"; // 手动选择（存 key，'' = 自动）

/** 按 key 取源定义。 */
export function defByKey(key) {
  return SOURCE_DEFS.find((d) => d.key === key) || null;
}

/** 主机名（用于状态栏提示）。 */
export function sourceHost(src) {
  return String(src || "").replace(/^https?:\/\//, "").split("/")[0];
}

/** 最近可用源（原始存储值，可能不在当前列表内）。 */
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

/** 手动选择的源 key（'' = 自动）。 */
export function getChoiceKey() {
  try {
    return localStorage.getItem(CHOICE_KEY) || "";
  } catch (e) {
    return "";
  }
}

/** 设置手动选择的源 key；传 '' 表示自动。 */
export function setChoiceKey(key) {
  try {
    if (key) localStorage.setItem(CHOICE_KEY, key);
    else localStorage.removeItem(CHOICE_KEY);
  } catch (e) {
    // 忽略
  }
}

/** 首选源：手动选择 > 最近可用源 > 默认源。 */
export function preferredSource() {
  const chosen = defByKey(getChoiceKey());
  if (chosen) return chosen.url;
  return getLastGoodSource() || DEFAULT_SOURCE;
}

/**
 * 返回当前应使用的源顺序（URL 列表）：
 *   - 手动选择：[所选源, ...其余按默认顺序]
 *   - 自动：[上次可用源(若有), ...默认顺序去重]
 */
export function getSourceOrder() {
  const chosen = defByKey(getChoiceKey());
  if (chosen) {
    return [chosen.url, ...DEFAULT_SOURCES.filter((u) => u !== chosen.url)];
  }
  const last = getLastGoodSource();
  if (last && DEFAULT_SOURCES.includes(last)) {
    return [last, ...DEFAULT_SOURCES.filter((u) => u !== last)];
  }
  return [...DEFAULT_SOURCES];
}

/** 把给定列表中的最近可用源排到最前（供自定义 sources 使用）。 */
export function sourceOrder(list = DEFAULT_SOURCES) {
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

/** 探测第一个可用源（顺序探测；结果记忆化；成功后写入 localStorage.msch-source）。 */
export function probeSources({
  sources = DEFAULT_SOURCES,
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

/**
 * 并行探测全部源（用于「检测镜像」按钮）：每个源独立 4s 超时。
 * @returns {Promise<Array<{key,label,url,ok,ms}>>}
 */
export async function probeAllSources({
  defs = SOURCE_DEFS,
  timeoutMs = 4000,
  probePath = PROBE_PATH,
  fetchImpl = fetch,
} = {}) {
  return Promise.all(
    defs.map(async (def) => {
      const t0 = Date.now();
      try {
        const resp = await fetchTimeout(def.url + probePath, timeoutMs, fetchImpl);
        const ok = !!(resp && resp.ok);
        return { key: def.key, label: def.label, url: def.url, ok, ms: Date.now() - t0 };
      } catch (e) {
        return { key: def.key, label: def.label, url: def.url, ok: false, ms: Date.now() - t0 };
      }
    })
  );
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
  const custom = opts.sources;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT;
  const fetchImpl = opts.fetchImpl || fetch;
  const doProbe = opts.probe !== false;

  // 无 last-good 且未手动选择时，先探测一次
  if (doProbe && !getLastGoodSource() && !getChoiceKey()) {
    await probeSources({
      sources: custom || DEFAULT_SOURCES,
      timeoutMs: Math.min(timeoutMs, PROBE_TIMEOUT),
      fetchImpl,
    });
  }

  const order = custom ? sourceOrder(custom) : getSourceOrder();
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
