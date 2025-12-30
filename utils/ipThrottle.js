import crypto from "crypto";

/**
 * IP-based throttling (secondary check, not identity)
 * Uses a simple time-window based rate limiter
 */

// In-memory store for IP throttling (simple rate limiting)
// Format: Map<hashedIP, { count: number, windowStart: number }>
const ipThrottleStore = new Map();

// Throttle configuration
const THROTTLE_WINDOW_MS = 60 * 1000; // 1 minute window
const MAX_REQUESTS_PER_WINDOW = 5; // Max requests per IP per minute

/**
 * Hash IP address for privacy
 */
function hashIP(ip) {
  if (!ip) return null;
  const salt = process.env.IP_HASH_SALT || "curalink-ip-throttle-salt";
  const hash = crypto.createHash("sha256");
  hash.update(ip + salt);
  return hash.digest("hex").substring(0, 32);
}

/**
 * Extract client IP address from request
 */
export function getClientIP(req) {
  if (!req?.headers) return null;

  // Check Vercel-specific header first
  if (req.headers["x-vercel-forwarded-for"]) {
    return req.headers["x-vercel-forwarded-for"].split(",")[0].trim();
  }
  // Check Cloudflare
  if (req.headers["cf-connecting-ip"]) {
    return req.headers["cf-connecting-ip"];
  }
  // Check standard forwarded header
  const forwardedFor = req.headers["x-forwarded-for"];
  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }
  // Check real IP header
  if (req.headers["x-real-ip"]) {
    return req.headers["x-real-ip"];
  }
  // Fallback to connection remote address
  return (
    req.connection?.remoteAddress || req.socket?.remoteAddress || req.ip || null
  );
}

/**
 * Check if IP is throttled (rate limit exceeded)
 * Returns { throttled: boolean, remaining: number }
 */
export function checkIPThrottle(req) {
  const clientIP = getClientIP(req);
  if (!clientIP) {
    // If we can't get IP, allow (fail open)
    return { throttled: false, remaining: MAX_REQUESTS_PER_WINDOW };
  }

  const hashedIP = hashIP(clientIP);
  if (!hashedIP) {
    return { throttled: false, remaining: MAX_REQUESTS_PER_WINDOW };
  }

  const now = Date.now();
  const entry = ipThrottleStore.get(hashedIP);

  // Clean up old entries periodically (every 1000 checks)
  if (Math.random() < 0.001) {
    cleanupOldEntries(now);
  }

  if (!entry || now - entry.windowStart >= THROTTLE_WINDOW_MS) {
    // New window or expired window - reset
    ipThrottleStore.set(hashedIP, {
      count: 1,
      windowStart: now,
    });
    return { throttled: false, remaining: MAX_REQUESTS_PER_WINDOW - 1 };
  }

  // Increment count
  entry.count += 1;

  if (entry.count > MAX_REQUESTS_PER_WINDOW) {
    return {
      throttled: true,
      remaining: 0,
      resetAt: entry.windowStart + THROTTLE_WINDOW_MS,
    };
  }

  return {
    throttled: false,
    remaining: MAX_REQUESTS_PER_WINDOW - entry.count,
  };
}

/**
 * Clean up old entries from throttle store
 */
function cleanupOldEntries(now) {
  for (const [hashedIP, entry] of ipThrottleStore.entries()) {
    if (now - entry.windowStart >= THROTTLE_WINDOW_MS * 2) {
      // Remove entries older than 2 windows
      ipThrottleStore.delete(hashedIP);
    }
  }
}

// Periodic cleanup every 5 minutes
setInterval(() => {
  const now = Date.now();
  cleanupOldEntries(now);
}, 5 * 60 * 1000);
