// =============================================================================
// cache.js —— Cache Storage 持久化缓存（贴图 + sprite_index.json）
//
// 策略：
//   - 命中 → 立即返回缓存 Response；若已超过 TTL(7天) 则后台 stale-while-revalidate。
//   - 未命中 → fetch → 成功则 cache.put → 返回。
//   - 任意一步不可用（非 https / 无 caches API / 隐私模式 / localStorage 被禁）
//     都 graceful fallback 到普通 fetch，绝不抛错。
//
// 该模块只在浏览器里真正生效；Node 单测只验证纯逻辑（prefetch.js），不会导入本模块。
// =============================================================================

const CACHE_NAME = "msch-cache-v1";
const META_KEY = "msch-cache-meta";
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

/** 简易命中统计（供状态栏显示「缓存命中 X 张」）。 */
export const cacheInfo = { hits: 0, misses: 0, revalidations: 0 };

export function resetCacheInfo() {
  cacheInfo.hits = 0;
  cacheInfo.misses = 0;
  cacheInfo.revalidations = 0;
}

function hasCacheStorage() {
  try {
    return typeof caches !== "undefined" && typeof caches.open === "function";
  } catch (e) {
    return false;
  }
}

function readMeta() {
  try {
    return JSON.parse(localStorage.getItem(META_KEY) || "{}") || {};
  } catch (e) {
    return {};
  }
}

function writeMeta(meta) {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch (e) {
    // localStorage 不可用：忽略
  }
}

async function openCache() {
  if (!hasCacheStorage()) return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch (e) {
    return null;
  }
}

async function putAndStamp(cache, url, response) {
  try {
    if (response && response.ok) {
      await cache.put(url, response.clone());
      const meta = readMeta();
      meta[url] = Date.now();
      writeMeta(meta);
    }
  } catch (e) {
    // 容量/隐私限制：忽略
  }
}

function revalidateInBackground(cache, url) {
  cacheInfo.revalidations++;
  Promise.resolve()
    .then(() => fetch(url))
    .then((resp) => putAndStamp(cache, url, resp))
    .catch(() => {});
}

/**
 * 带持久化缓存的 fetch。
 * @param {string} url
 * @returns {Promise<Response>}
 */
export async function fetchCached(url) {
  const cache = await openCache();
  if (!cache) {
    cacheInfo.misses++;
    return fetch(url);
  }

  let cached = null;
  try {
    cached = await cache.match(url);
  } catch (e) {
    cached = null;
  }

  if (cached) {
    cacheInfo.hits++;
    const meta = readMeta();
    const ts = meta[url] || 0;
    if (Date.now() - ts > TTL_MS) revalidateInBackground(cache, url);
    return cached;
  }

  cacheInfo.misses++;
  const resp = await fetch(url);
  await putAndStamp(cache, url, resp);
  return resp;
}

/** 清除本工具的全部持久化缓存与时间戳。 */
export async function clearPersistentCache() {
  let ok = true;
  try {
    if (hasCacheStorage()) await caches.delete(CACHE_NAME);
  } catch (e) {
    ok = false;
  }
  try {
    localStorage.removeItem(META_KEY);
  } catch (e) {
    // 忽略
  }
  resetCacheInfo();
  return ok;
}
