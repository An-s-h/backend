import { IPLimit } from "../models/IPLimit.js";

// Configuration - Strict limit of 6 searches per browser/device (hardcoded to ensure strictness)
const MAX_FREE_SEARCHES = 6;

/**
 * Get device identifier from request
 * Uses browser-based deviceId (from x-device-id header)
 */
function getDeviceIdentifier(req) {
  const deviceId = req.headers["x-device-id"];
  if (deviceId && deviceId.trim()) {
    return deviceId.trim();
  }
  return null;
}

/**
 * Check search limit for anonymous user (browser-based deviceId only)
 * Returns strict limit check - blocks after 6 searches
 */
export async function checkSearchLimit(req, res = null) {
  // Allow bypassing search limit in development mode for testing
  if (process.env.NODE_ENV !== "production" && req.headers["x-testing"] === "true") {
    console.log("[SearchLimit] BYPASS: Testing mode enabled - skipping limit check");
    return {
      canSearch: true,
      remaining: 999,
      action: "TESTING_BYPASS",
      message: null,
      showSignUpPrompt: false,
    };
  }

  // Get device identifier (deviceId only)
  const deviceId = getDeviceIdentifier(req);

  if (!deviceId) {
    // If we can't get device identifier, block to be strict
    console.warn(
      "[SearchLimit] Failed to get deviceId - blocking request"
    );
    return {
      canSearch: false,
      remaining: 0,
      action: "BLOCKED",
      message: "Unable to verify request. Please try again.",
      showSignUpPrompt: true,
    };
  }

  try {
    // Find existing record by deviceId
    let limitRecord = await IPLimit.findOne({ deviceId });

    let searchCount = 0;
    if (limitRecord) {
      searchCount = limitRecord.searchCount || 0;
    } else {
      // Create new record with count 0
      if (!deviceId || !deviceId.trim()) {
        console.warn("[SearchLimit] Cannot create record with null identifier value");
        return {
          canSearch: false,
          remaining: 0,
          action: "ERROR",
          message: "Unable to verify request. Please try again.",
          showSignUpPrompt: false,
        };
      }

      const recordData = {
        deviceId,
        searchCount: 0,
        lastSearchAt: null,
      };

      try {
        limitRecord = await IPLimit.create(recordData);
      } catch (createError) {
        // Handle duplicate key error during creation
        if (createError.code === 11000) {
          // Record already exists (race condition), try to find it
          limitRecord = await IPLimit.findOne({ deviceId });
          if (!limitRecord) {
            throw createError; // Re-throw if we still can't find it
          }
        } else {
          throw createError;
        }
      }
    }

    const remaining = Math.max(0, MAX_FREE_SEARCHES - searchCount);

    // Strict limit: block if searchCount >= MAX_FREE_SEARCHES (strict enforcement)
    if (searchCount >= MAX_FREE_SEARCHES) {
      if (process.env.NODE_ENV !== "production") {
        const idDisplay = `deviceId=${deviceId.substring(0, 12)}...`;
        console.log(
          `[SearchLimit] BLOCKED: ${idDisplay}, count=${searchCount}, limit=${MAX_FREE_SEARCHES}`
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
      const idDisplay = `deviceId=${deviceId.substring(0, 12)}...`;
      console.log(
        `[SearchLimit] ALLOWED: ${idDisplay}, count=${searchCount}, remaining=${remaining}`
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
 * Increment search count for device (deviceId only)
 */
export async function incrementSearchCount(req) {
  // Skip incrementing in testing mode
  if (process.env.NODE_ENV !== "production" && req.headers["x-testing"] === "true") {
    console.log("[SearchLimit] BYPASS: Testing mode - skipping count increment");
    return;
  }

  const deviceId = getDeviceIdentifier(req);

  if (!deviceId) {
    console.warn("[SearchLimit] No device identifier to increment count for");
    return;
  }

  try {
    // Ensure we have a valid identifier value (never null/undefined)
    if (!deviceId || !deviceId.trim()) {
      console.warn("[SearchLimit] Invalid identifier value, skipping increment");
      return;
    }

    const query = { deviceId };

    // Use atomic increment to prevent race conditions
    const result = await IPLimit.findOneAndUpdate(
      query,
      {
        $inc: { searchCount: 1 },
        $set: { lastSearchAt: new Date() },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Double-check: if count exceeds limit after increment, don't allow it
    if (result && result.searchCount > MAX_FREE_SEARCHES) {
      // Rollback if somehow we exceeded the limit
      await IPLimit.findOneAndUpdate(query, { $inc: { searchCount: -1 } });
      const idDisplay = `deviceId: ${deviceId.substring(0, 12)}...`;
      console.warn(`[SearchLimit] Prevented exceeding limit for ${idDisplay}`);
    }

    if (process.env.NODE_ENV !== "production") {
      const idDisplay = `deviceId: ${deviceId.substring(0, 12)}...`;
      console.log(`[SearchLimit] Incremented search count for ${idDisplay}`);
    }
  } catch (error) {
    // Handle duplicate key errors gracefully (shouldn't happen with proper checks, but just in case)
    if (error.code === 11000) {
      // Duplicate key error - try to find existing record and update it instead
      const resolvedDeviceId = getDeviceIdentifier(req);
      if (resolvedDeviceId) {
        const query = { deviceId: resolvedDeviceId };

        try {
          await IPLimit.findOneAndUpdate(
            query,
            {
              $inc: { searchCount: 1 },
              $set: { lastSearchAt: new Date() },
            },
            { new: true }
          );
          console.log("[SearchLimit] Recovered from duplicate key error by updating existing record");
        } catch (recoveryError) {
          console.error("[SearchLimit] Error recovering from duplicate key error:", recoveryError);
        }
      }
    } else {
      console.error("[SearchLimit] Error incrementing count:", error);
    }
  }
}

/**
 * Get debug info for search limits
 */
export async function getSearchLimitDebug(req) {
  const deviceId = getDeviceIdentifier(req);

  if (!deviceId) {
    return {
      error: "No device identifier found (deviceId required)",
      identifier: null,
    };
  }

  const query = { deviceId };

  const limitRecord = await IPLimit.findOne(query).lean();

  const count = limitRecord?.searchCount || 0;
  const remaining = Math.max(0, MAX_FREE_SEARCHES - count);

  const result = {
    identifierType: "deviceId",
    identifier: deviceId.substring(0, 12) + "...",
    searchCount: count,
    remaining,
    lastSearchAt: limitRecord?.lastSearchAt || null,
    maxFreeSearches: MAX_FREE_SEARCHES,
    canSearch: count < MAX_FREE_SEARCHES,
  };

  return result;
}

/**
 * Middleware to ensure browser-based tracking is ready
 * (No longer needs to set cookies, just passes through)
 */
export function searchLimitMiddleware(req, res, next) {
  // No-op middleware - device tracking happens in checkSearchLimit
  next();
}

export { MAX_FREE_SEARCHES };
