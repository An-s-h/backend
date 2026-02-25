/**
 * Shared recommendations cache so profile routes can invalidate when conditions change.
 * Key: recommendations:${userId}. TTL 30 minutes.
 */

const cache = new Map();
const TTL_MS = 1000 * 60 * 30; // 30 minutes

function getKey(userId) {
  return `recommendations:${userId}`;
}

export function getRecommendationsCache(userId) {
  const key = getKey(userId);
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expires) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

export function setRecommendationsCache(userId, value) {
  const key = getKey(userId);
  cache.set(key, { value, expires: Date.now() + TTL_MS });

  if (cache.size > 100) {
    const now = Date.now();
    const keysToDelete = [];
    for (const [k, v] of cache.entries()) {
      if (now > v.expires) keysToDelete.push(k);
    }
    keysToDelete.forEach((k) => cache.delete(k));
    if (cache.size > 100) {
      const entries = Array.from(cache.entries());
      entries.sort((a, b) => a[1].expires - b[1].expires);
      entries.slice(0, entries.length - 100).forEach(([k]) => cache.delete(k));
    }
  }
}

/** Clear cache for a user (e.g. when conditions are updated). */
export function clearRecommendationsCache(userId) {
  const key = getKey(userId);
  const had = cache.has(key);
  cache.delete(key);
  return had;
}
