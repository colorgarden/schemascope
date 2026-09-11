// =============================================================================
// cache.js —— Cache Storage 持久化缓存（贴图 + sprite_index.json）
//
// 策略：
//   - 缓存键规范化：Mindustry 素材统一用 `location.origin + "/__sprites__/" + relPath`，
//     与具体镜像源无关，换源后缓存依然命中。
//   - 命中 → 立即返回缓存 Response；超过 TTL(7天) 则后台 stale-while-revalidate。
//   - 未命中 → 走超时/切源链路 fetch → 成功才 cache.put；失败/超时绝不写缓存。
//   - 任意一步不可用（非 https / 无 caches API / 隐私模式 / localStorage 被禁）
//     都 graceful fallback 到普通 fetch，绝不抛错。
//
// 该模块主要在浏览器里生效；Node 单测通过注入 mock（caches/location/fetch）运行。
// =============================================================================

import { fetchMindustry, fetchTimeout, DEFAULT_TIMEOUT } from "./sources.js";

const CACHE_PREFIX = "msch-cache";
const CACHE_NAME = "msch-cache-v2"; // 升级 v2
const MOD_CACHE_NAME = "msch-mods-v1";
const META_KEY = "msch-cache-meta";
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const SPRITE_KEY_PREFIX = "/__sprites__/";

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

/** 规范化缓存键：与镜像源无关的相对路径。 */
export function spriteCacheKey(relPath) {
  const origin = typeof location !== "undefined" && location.origin ? location.origin : "";
  return origin + SPRITE_KEY_PREFIX + String(relPath).replace(/^\/+/, "");
}

async function matchKey(cache, key) {
  try {
    return (await cache.match(key)) || null;
  } catch (e) {
    return null;
  }
}

/** 仅成功响应才写缓存并记录时间戳；失败/超时不缓存。 */
async function putIfOk(cache, key, response) {
  try {
    if (response && response.ok) {
      await cache.put(key, response.clone());
      const meta = readMeta();
      meta[key] = Date.now();
      writeMeta(meta);
      return true;
    }
  } catch (e) {
    // 容量/隐私限制：忽略
  }
  return false;
}

function maybeRevalidate(cache, key) {
  const meta = readMeta();
  const ts = meta[key] || 0;
  return Date.now() - ts > TTL_MS;
}

/**
 * 带持久化缓存的普通 fetch（同源：sprite_index.json、本地 assets/…）。
 * 8 秒超时；失败不写缓存。
 */
export async function fetchCached(url, opts = {}) {
  const key = opts.cacheKey || url;
  const cache = await openCache();
  if (!cache) {
    cacheInfo.misses++;
    return fetchTimeout(url, opts.timeoutMs || DEFAULT_TIMEOUT);
  }

  const cached = await matchKey(cache, key);
  if (cached) {
    cacheInfo.hits++;
    if (maybeRevalidate(cache, key)) {
      cacheInfo.revalidations++;
      Promise.resolve()
        .then(() => fetchTimeout(url, opts.timeoutMs || DEFAULT_TIMEOUT))
        .then((resp) => putIfOk(cache, key, resp))
        .catch(() => {});
    }
    return cached;
  }

  cacheInfo.misses++;
  const resp = await fetchTimeout(url, opts.timeoutMs || DEFAULT_TIMEOUT);
  await putIfOk(cache, key, resp);
  return resp;
}

/**
 * 带缓存 + 镜像源自动切换的 Mindustry 素材 fetch。
 * @param {string} relPath 相对源根路径（如 "core/assets-raw/sprites/..."）
 * @param {object} opts fetchMindustry 选项（onSwitch/sources/timeoutMs/fetchImpl/probe）
 */
export async function fetchMindustryCached(relPath, opts = {}) {
  const key = spriteCacheKey(relPath);
  const cache = await openCache();
  if (!cache) {
    cacheInfo.misses++;
    return fetchMindustry(relPath, opts);
  }

  const cached = await matchKey(cache, key);
  if (cached) {
    cacheInfo.hits++;
    if (maybeRevalidate(cache, key)) {
      cacheInfo.revalidations++;
      Promise.resolve()
        .then(() => fetchMindustry(relPath, opts))
        .then((resp) => putIfOk(cache, key, resp))
        .catch(() => {});
    }
    return cached;
  }

  cacheInfo.misses++;
  const resp = await fetchMindustry(relPath, opts);
  if (resp && resp.ok) await putIfOk(cache, key, resp);
  return resp;
}

/** 清除本工具的全部持久化缓存（含旧版本 msch-cache-*）与时间戳。 */
export async function clearPersistentCache() {
  let ok = true;
  try {
    if (hasCacheStorage()) {
      const names = (await caches.keys()).filter((n) => n.startsWith(CACHE_PREFIX));
      await Promise.all(names.map((n) => caches.delete(n)));
    }
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

// -----------------------------------------------------------------------------
// 模组 zip 持久化（独立缓存 msch-mods-v1，key 形如 /__mods__/<文件名>）
// -----------------------------------------------------------------------------

const MOD_KEY_PREFIX = "/__mods__/";

async function openModCache() {
  if (!hasCacheStorage()) return null;
  try {
    return await caches.open(MOD_CACHE_NAME);
  } catch (e) {
    return null;
  }
}

function modRequest(fileName) {
  return new Request(MOD_KEY_PREFIX + encodeURIComponent(fileName));
}

/** 保存模组 zip（失败返回 false，不抛错）。 */
export async function putMod(fileName, data) {
  const cache = await openModCache();
  if (!cache) return false;
  try {
    const body = data instanceof Blob ? data : new Blob([data]);
    await cache.put(modRequest(fileName), new Response(body));
    return true;
  } catch (e) {
    return false;
  }
}

/** 列出缓存中的模组：[{ fileName, blob }]。 */
export async function listMods() {
  const cache = await openModCache();
  if (!cache) return [];
  const out = [];
  try {
    const keys = await cache.keys();
    for (const req of keys) {
      const m = req.url.match(/\/__mods__\/(.+)$/);
      if (!m) continue;
      let fileName;
      try {
        fileName = decodeURIComponent(m[1]);
      } catch (e) {
        fileName = m[1];
      }
      const resp = await cache.match(req);
      if (resp) out.push({ fileName, blob: await resp.blob() });
    }
  } catch (e) {
    return out;
  }
  return out;
}

/** 删除指定模组缓存。 */
export async function deleteMod(fileName) {
  const cache = await openModCache();
  if (!cache) return false;
  try {
    return await cache.delete(modRequest(fileName));
  } catch (e) {
    return false;
  }
}

/** 清空全部模组缓存。 */
export async function clearMods() {
  try {
    if (hasCacheStorage()) await caches.delete(MOD_CACHE_NAME);
    return true;
  } catch (e) {
    return false;
  }
}
