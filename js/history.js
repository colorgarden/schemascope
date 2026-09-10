// =============================================================================
// history.js —— 本地历史记录（纯函数，可在 Node 下单测）
//
// 存储键：localStorage["msch-history"] = JSON 数组（新→旧）。
// 条目结构：{ hash, name, w, h, tiles, time, input }
// 容量策略：单条 input > 1MB 不记录；总条数 ≤ 16；总字节（按 input.length）≤ 2MB，
//           超限从最旧开始淘汰；写入失败（配额）→ 淘汰一半重试一次，仍失败放弃。
// =============================================================================

export const HISTORY_KEY = "msch-history";
export const HISTORY_MAX_ITEMS = 16;
export const HISTORY_MAX_BYTES = 2 * 1024 * 1024; // 2MB
export const HISTORY_MAX_INPUT = 1024 * 1024; // 单条 1MB

function inputLen(e) {
  return e && typeof e.input === "string" ? e.input.length : 0;
}

/** 按「条数 ≤ maxItems、总字节 ≤ maxBytes」从最旧淘汰（列表假定新→旧）。 */
export function pruneHistory(list, { maxItems = HISTORY_MAX_ITEMS, maxBytes = HISTORY_MAX_BYTES } = {}) {
  const out = list.slice(0, maxItems);
  let total = out.reduce((s, e) => s + inputLen(e), 0);
  while (out.length > 0 && total > maxBytes) {
    const removed = out.pop();
    total -= inputLen(removed);
  }
  return out;
}

/**
 * 追加/更新一条历史：同 hash 去重并置顶（更新时间）；input 超单条上限则跳过。
 * @returns {Array} 新的历史列表（新→旧）
 */
export function addHistory(list, entry, opts = {}) {
  const maxInput = opts.maxInput !== undefined ? opts.maxInput : HISTORY_MAX_INPUT;
  if (!entry || typeof entry.input !== "string") return list.slice();
  if (entry.input.length > maxInput) return list.slice();
  const without = list.filter((e) => e.hash !== entry.hash);
  return pruneHistory([entry, ...without], opts);
}

/** 删除指定 hash 的条目。 */
export function removeHistory(list, hash) {
  return list.filter((e) => e.hash !== hash);
}

/** 读取历史（失败/损坏返回空数组）。 */
export function loadHistory(storage = typeof localStorage !== "undefined" ? localStorage : null) {
  if (!storage) return [];
  try {
    const raw = storage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((e) => e && typeof e === "object" && typeof e.hash === "string");
  } catch (e) {
    return [];
  }
}

/**
 * 保存历史。写入失败（配额）时淘汰一半重试一次，仍失败返回 null。
 * @returns {Array|null} 实际保存的列表；失败返回 null
 */
export function saveHistory(list, storage = typeof localStorage !== "undefined" ? localStorage : null) {
  if (!storage) return null;
  try {
    storage.setItem(HISTORY_KEY, JSON.stringify(list));
    return list;
  } catch (e) {
    const half = list.slice(0, Math.max(0, Math.floor(list.length / 2)));
    try {
      storage.setItem(HISTORY_KEY, JSON.stringify(half));
      return half;
    } catch (e2) {
      return null;
    }
  }
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / N 个月前 / N 年前。 */
export function formatRelativeTime(time, now = Date.now()) {
  const diff = Math.max(0, now - Number(time || 0));
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return min + " 分钟前";
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + " 小时前";
  const days = Math.floor(hr / 24);
  if (days === 1) return "昨天";
  if (days < 30) return days + " 天前";
  const months = Math.floor(days / 30);
  if (months < 12) return months + " 个月前";
  return Math.floor(months / 12) + " 年前";
}
