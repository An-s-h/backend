import { IPLimit } from "../models/IPLimit.js";
import { getClientIP } from "../utils/ipThrottle.js";
import crypto from "crypto";

// Configuration - Strict limit of 6 searches per IP (hardcoded to ensure strictness)
const MAX_FREE_SEARCHES = 6;

/**
 * Hash IP address for privacy (consistent with ipThrottle.js)
 */
function hashIP(ip) {
  if (!ip) return null;
  const salt = process.env.IP_HASH_SALT || "curalink-ip-throttle-salt";
  const hash = crypto.createHash("sha256");
  hash.update(ip + salt);
  return hash.digest("hex").substring(0, 32);
}

/**
 * Check search limit for anonymous user (IP-based only)
 * Returns strict limit check - blocks after 6 searches
 */
export async function checkSearchLimit(req, res = null) {
  // Get client IP address
  const clientIP = getClientIP(req);

  if (!clientIP) {
    // If we can't get IP, block to be strict
    console.warn("[SearchLimit] Failed to get client IP - blocking request");
    return {
      canSearch: false,
      remaining: 0,
      action: "BLOCKED",
      message: "Unable to verify request. Please try again.",
      showSignUpPrompt: true,
    };
  }

  const hashedIP = hashIP(clientIP);
  if (!hashedIP) {
    console.warn("[SearchLimit] Failed to hash IP - blocking request");
    return {
      canSearch: false,
      remaining: 0,
      action: "BLOCKED",
      message: "Unable to verify request. Please try again.",
      showSignUpPrompt: true,
    };
  }

  try {
    // Find or create IP limit record
    let ipLimitRecord = await IPLimit.findOne({ hashedIP });

    let searchCount = 0;
    if (ipLimitRecord) {
      searchCount = ipLimitRecord.searchCount || 0;
    } else {
      // Create new record with count 0
      ipLimitRecord = await IPLimit.create({
        hashedIP,
        searchCount: 0,
        lastSearchAt: null,
      });
    }

    const remaining = Math.max(0, MAX_FREE_SEARCHES - searchCount);

    // Strict limit: block if searchCount >= MAX_FREE_SEARCHES (strict enforcement)
    if (searchCount >= MAX_FREE_SEARCHES) {
      if (process.env.NODE_ENV !== "production") {
        console.log(
          `[SearchLimit] BLOCKED: hashedIP=${hashedIP.substring(
            0,
            8
          )}..., count=${searchCount}, limit=${MAX_FREE_SEARCHES}`
        );
      }
      return {
        canSearch: false,
        remaining: 0,
        action: "BLOCKED",
        message:
          "You've reached your free search limit. Sign up for unlimited searches.",
        showSignUpPrompt: true,
        effectiveCount: searchCount,
      };
    }

    // Allow search
    if (process.env.NODE_ENV !== "production") {
      console.log(
        `[SearchLimit] ALLOWED: hashedIP=${hashedIP.substring(
          0,
          8
        )}..., count=${searchCount}, remaining=${remaining}`
      );
    }

    return {
      canSearch: true,
      remaining,
      action: "ALLOWED",
      message: remaining <= 2 ? `${remaining} free searches remaining` : null,
      showSignUpPrompt: false,
      effectiveCount: searchCount,
    };
  } catch (error) {
    console.error("[SearchLimit] Error checking limit:", error);
    // Fail closed - block request if there's an error (strict mode)
    return {
      canSearch: false,
      remaining: 0,
      action: "ERROR",
      message: "An error occurred. Please try again later.",
      showSignUpPrompt: false,
    };
  }
}

/**
 * Increment search count for IP address
 */
export async function incrementSearchCount(req) {
  const clientIP = getClientIP(req);

  if (!clientIP) {
    console.warn("[SearchLimit] No IP to increment count for");
    return;
  }

  const hashedIP = hashIP(clientIP);
  if (!hashedIP) {
    console.warn("[SearchLimit] Failed to hash IP for increment");
    return;
  }

  try {
    // Use atomic increment to prevent race conditions
    const result = await IPLimit.findOneAndUpdate(
      { hashedIP },
      {
        $inc: { searchCount: 1 },
        $set: { lastSearchAt: new Date() },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Double-check: if count exceeds limit after increment, don't allow it
    if (result && result.searchCount > MAX_FREE_SEARCHES) {
      // Rollback if somehow we exceeded the limit
      await IPLimit.findOneAndUpdate(
        { hashedIP },
        { $inc: { searchCount: -1 } }
      );
      console.warn(
        `[SearchLimit] Prevented exceeding limit for IP: ${hashedIP.substring(
          0,
          8
        )}...`
      );
    }

    if (process.env.NODE_ENV !== "production") {
      console.log(
        `[SearchLimit] Incremented search count for IP: ${hashedIP.substring(
          0,
          8
        )}...`
      );
    }
  } catch (error) {
    console.error("[SearchLimit] Error incrementing count:", error);
  }
}

/**
 * Get debug info for search limits
 */
export async function getSearchLimitDebug(req) {
  const clientIP = getClientIP(req);

  if (!clientIP) {
    return {
      error: "No client IP found",
      hashedIP: null,
    };
  }

  const hashedIP = hashIP(clientIP);
  if (!hashedIP) {
    return {
      error: "Failed to hash IP",
      hashedIP: null,
    };
  }

  const ipLimitRecord = await IPLimit.findOne({ hashedIP }).lean();

  const count = ipLimitRecord?.searchCount || 0;
  const remaining = Math.max(0, MAX_FREE_SEARCHES - count);

  return {
    hashedIP: hashedIP.substring(0, 8) + "...",
    clientIP: clientIP.substring(0, 8) + "...",
    searchCount: count,
    remaining,
    lastSearchAt: ipLimitRecord?.lastSearchAt || null,
    maxFreeSearches: MAX_FREE_SEARCHES,
    canSearch: count < MAX_FREE_SEARCHES,
  };
}

/**
 * Middleware to ensure IP-based tracking is ready
 * (No longer needs to set cookies, just passes through)
 */
export function searchLimitMiddleware(req, res, next) {
  // No-op middleware - IP tracking happens in checkSearchLimit
  next();
}

export { MAX_FREE_SEARCHES };
