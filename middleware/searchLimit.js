import { SearchLimit } from "../models/SearchLimit.js";
import {
  getOrCreateAnonymousToken,
  getAnonymousTokenUuid,
  TOKEN_COOKIE_NAME,
} from "../utils/anonymousToken.js";
import { checkIPThrottle } from "../utils/ipThrottle.js";

// Configuration
const MAX_FREE_SEARCHES = parseInt(process.env.MAX_FREE_SEARCHES || "6", 10);

// Thresholds for different actions
const THRESHOLDS = {
  ALLOWED: 0,
  WARNING: MAX_FREE_SEARCHES - 2, // Show warning about remaining
  SLOW_DOWN: MAX_FREE_SEARCHES - 1, // Add slight delay
  SOFT_LIMIT: MAX_FREE_SEARCHES, // Suggest sign-up
  HARD_LIMIT: MAX_FREE_SEARCHES + 2, // Actually block (with override option)
};

/**
 * Check search limit for anonymous user (token-based)
 * Returns risk assessment with soft thresholds
 */
export async function checkSearchLimit(req, res = null) {
  // Get or create anonymous session token (res is optional for cases where we just want to check)
  const tokenData = res
    ? getOrCreateAnonymousToken(req, res)
    : { uuid: getAnonymousTokenUuid(req) };

  if (!tokenData || !tokenData.uuid) {
    // If we can't get/create token, allow but log
    console.warn("[SearchLimit] Failed to get anonymous token");
    return {
      canSearch: true,
      remaining: MAX_FREE_SEARCHES,
      action: "ALLOWED",
    };
  }

  const tokenUuid = tokenData.uuid;

  try {
    // Check IP throttling first (secondary check, not identity)
    const ipThrottle = checkIPThrottle(req);
    if (ipThrottle.throttled) {
      return {
        canSearch: false,
        remaining: 0,
        action: "THROTTLED",
        message: "Too many requests. Please try again in a moment.",
        showSignUpPrompt: false,
      };
    }

    // Find search limit record for this token
    const searchLimitRecord = await SearchLimit.findOne({ tokenUuid });

    let searchCount = 0;
    if (searchLimitRecord) {
      searchCount = searchLimitRecord.searchCount;
    }

    const remaining = Math.max(0, MAX_FREE_SEARCHES - searchCount);
    const action = determineAction(searchCount);

    // Debug logging
    if (process.env.NODE_ENV !== "production") {
      console.log(
        `[SearchLimit] Check: tokenUuid=${tokenUuid.substring(
          0,
          8
        )}..., count=${searchCount}, remaining=${remaining}, action=${
          action.action
        }`
      );
    }

    return {
      ...action,
      remaining,
      effectiveCount: searchCount,
    };
  } catch (error) {
    console.error("[SearchLimit] Error checking limit:", error);
    // Fail open - allow request if there's an error
    return {
      canSearch: true,
      remaining: MAX_FREE_SEARCHES,
      action: "ERROR",
    };
  }
}

/**
 * Determine action based on search count
 */
function determineAction(count) {
  // Hard limit
  if (count >= THRESHOLDS.HARD_LIMIT) {
    return {
      action: "BLOCKED",
      canSearch: false,
      message:
        "You've reached your free search limit. Sign up for unlimited searches.",
      showSignUpPrompt: true,
    };
  }

  // Soft limit
  if (count >= THRESHOLDS.SOFT_LIMIT) {
    return {
      action: "SOFT_LIMIT",
      canSearch: true, // Still allowed but strongly encouraged to sign up
      message: "You've used all your free searches. Sign up to continue.",
      showSignUpPrompt: true,
      addDelay: 1000, // 1 second delay
    };
  }

  // Slow down
  if (count >= THRESHOLDS.SLOW_DOWN) {
    return {
      action: "SLOW_DOWN",
      canSearch: true,
      message: "Last free search! Sign up for unlimited access.",
      showSignUpPrompt: false,
      addDelay: 500, // 0.5 second delay
    };
  }

  // Warning
  if (count >= THRESHOLDS.WARNING) {
    return {
      action: "WARNING",
      canSearch: true,
      message: `${THRESHOLDS.SOFT_LIMIT - count} free searches remaining`,
      showSignUpPrompt: false,
    };
  }

  // Fully allowed
  return {
    action: "ALLOWED",
    canSearch: true,
    message: null,
    showSignUpPrompt: false,
  };
}

/**
 * Increment search count for anonymous session token
 * Returns the updated search count and remaining searches
 */
export async function incrementSearchCount(req) {
  const tokenUuid = getAnonymousTokenUuid(req);

  if (!tokenUuid) {
    console.warn("[SearchLimit] No token UUID to increment");
    return { searchCount: 0, remaining: MAX_FREE_SEARCHES };
  }

  try {
    const updated = await SearchLimit.findOneAndUpdate(
      { tokenUuid },
      {
        $inc: { searchCount: 1 },
        $set: { lastSearchAt: new Date() },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const searchCount = updated.searchCount || 0;
    const remaining = Math.max(0, MAX_FREE_SEARCHES - searchCount);

    if (process.env.NODE_ENV !== "production") {
      console.log(
        `[SearchLimit] Incremented search count for token: ${tokenUuid.substring(
          0,
          8
        )}..., new count=${searchCount}, remaining=${remaining}`
      );
    }

    return { searchCount, remaining };
  } catch (error) {
    console.error("[SearchLimit] Error incrementing count:", error);
    // Return fallback values on error
    return { searchCount: 0, remaining: MAX_FREE_SEARCHES };
  }
}

/**
 * Get debug info for search limits
 */
export async function getSearchLimitDebug(req) {
  const tokenUuid = getAnonymousTokenUuid(req);

  if (!tokenUuid) {
    return {
      error: "No anonymous token found",
      tokenUuid: null,
    };
  }

  const searchLimitRecord = await SearchLimit.findOne({ tokenUuid }).lean();

  const count = searchLimitRecord?.searchCount || 0;
  const remaining = Math.max(0, MAX_FREE_SEARCHES - count);

  return {
    tokenUuid: tokenUuid.substring(0, 8) + "...",
    searchCount: count,
    remaining,
    lastSearchAt: searchLimitRecord?.lastSearchAt || null,
    thresholds: THRESHOLDS,
    maxFreeSearches: MAX_FREE_SEARCHES,
    action: determineAction(count),
  };
}

/**
 * Middleware to ensure anonymous session token cookie is set
 */
export function searchLimitMiddleware(req, res, next) {
  // Only set token for non-authenticated users
  if (!req.user) {
    // This will create token if it doesn't exist and set the cookie
    getOrCreateAnonymousToken(req, res);
  }
  next();
}

export { MAX_FREE_SEARCHES };
