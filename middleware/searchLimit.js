import { IPLimit } from "../models/IPLimit.js";
import { getClientIP } from "../utils/ipThrottle.js";
import crypto from "crypto";

// Configuration - Strict limit of 6 searches per browser/device (hardcoded to ensure strictness)
const MAX_FREE_SEARCHES = 6;

/**
 * Hash IP address for privacy (consistent with ipThrottle.js)
 * Used as fallback when deviceId is not available
 */
function hashIP(ip) {
  if (!ip) return null;
  const salt = process.env.IP_HASH_SALT || "curalink-ip-throttle-salt";
  const hash = crypto.createHash("sha256");
  hash.update(ip + salt);
  return hash.digest("hex").substring(0, 32);
}

/**
 * Get device identifier from request
 * Prioritizes browser-based deviceId (from x-device-id header)
 * Falls back to hashed IP address for backward compatibility
 */
function getDeviceIdentifier(req) {
  // Primary: Browser-based device identifier (survives IP changes, proxies, browser restarts)
  const deviceId = req.headers["x-device-id"];
  if (deviceId && deviceId.trim()) {
    return { type: "deviceId", value: deviceId.trim() };
  }

  // Fallback: IP-based identifier (for legacy support or when deviceId is unavailable)
  const clientIP = getClientIP(req);
  if (clientIP) {
    const hashedIP = hashIP(clientIP);
    if (hashedIP) {
      return { type: "hashedIP", value: hashedIP };
    }
  }

  return null;
}

/**
 * Check search limit for anonymous user (browser-based deviceId, fallback to IP)
 * Returns strict limit check - blocks after 6 searches
 */
export async function checkSearchLimit(req, res = null) {
  // Get device identifier (deviceId preferred, IP as fallback)
  const identifier = getDeviceIdentifier(req);

  if (!identifier) {
    // If we can't get any identifier, block to be strict
    console.warn(
      "[SearchLimit] Failed to get device identifier - blocking request"
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
    // Find existing record by deviceId or hashedIP
    let limitRecord = null;
    if (identifier.type === "deviceId") {
      // Primary: Look up by deviceId
      limitRecord = await IPLimit.findOne({ deviceId: identifier.value });

      // Migration: If not found by deviceId, try hashedIP (for users upgrading from IP-based tracking)
      if (!limitRecord) {
        const clientIP = getClientIP(req);
        if (clientIP) {
          const hashedIP = hashIP(clientIP);
          if (hashedIP) {
            limitRecord = await IPLimit.findOne({ hashedIP });
            // If found by IP, migrate to deviceId (preserve search count)
            if (limitRecord) {
              // Check if deviceId already exists (edge case - should be rare)
              const existingByDeviceId = await IPLimit.findOne({
                deviceId: identifier.value,
              });
              if (existingByDeviceId) {
                // DeviceId record exists - use it and merge counts (take maximum)
                existingByDeviceId.searchCount = Math.max(
                  existingByDeviceId.searchCount || 0,
                  limitRecord.searchCount || 0
                );
                await existingByDeviceId.save();
                // Delete old IP-based record (save ID before reassigning)
                const oldIpRecordId = limitRecord._id;
                limitRecord = existingByDeviceId;
                await IPLimit.deleteOne({ _id: oldIpRecordId });
              } else {
                // Migrate IP record to deviceId (preserve search count)
                limitRecord.deviceId = identifier.value;
                await limitRecord.save();
              }
            }
          }
        }
      }
    } else {
      // Fallback: Look up by hashedIP only
      limitRecord = await IPLimit.findOne({ hashedIP: identifier.value });
    }

    let searchCount = 0;
    if (limitRecord) {
      searchCount = limitRecord.searchCount || 0;
    } else {
      // Create new record with count 0
      const recordData = {
        searchCount: 0,
        lastSearchAt: null,
      };

      if (identifier.type === "deviceId") {
        recordData.deviceId = identifier.value;
      } else {
        recordData.hashedIP = identifier.value;
      }

      limitRecord = await IPLimit.create(recordData);
    }

    const remaining = Math.max(0, MAX_FREE_SEARCHES - searchCount);

    // Strict limit: block if searchCount >= MAX_FREE_SEARCHES (strict enforcement)
    if (searchCount >= MAX_FREE_SEARCHES) {
      if (process.env.NODE_ENV !== "production") {
        const idDisplay =
          identifier.type === "deviceId"
            ? `deviceId=${identifier.value.substring(0, 12)}...`
            : `hashedIP=${identifier.value.substring(0, 8)}...`;
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
      const idDisplay =
        identifier.type === "deviceId"
          ? `deviceId=${identifier.value.substring(0, 12)}...`
          : `hashedIP=${identifier.value.substring(0, 8)}...`;
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
 * Increment search count for device (deviceId preferred, IP as fallback)
 */
export async function incrementSearchCount(req) {
  const identifier = getDeviceIdentifier(req);

  if (!identifier) {
    console.warn("[SearchLimit] No device identifier to increment count for");
    return;
  }

  try {
    // Build query based on identifier type
    const query =
      identifier.type === "deviceId"
        ? { deviceId: identifier.value }
        : { hashedIP: identifier.value };

    // Use atomic increment to prevent race conditions
    const result = await IPLimit.findOneAndUpdate(
      query,
      {
        $inc: { searchCount: 1 },
        $set: { lastSearchAt: new Date() },
        // Set deviceId if incrementing via IP and deviceId is available
        ...(identifier.type === "hashedIP" && req.headers["x-device-id"]
          ? { $setOnInsert: { deviceId: req.headers["x-device-id"].trim() } }
          : {}),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Double-check: if count exceeds limit after increment, don't allow it
    if (result && result.searchCount > MAX_FREE_SEARCHES) {
      // Rollback if somehow we exceeded the limit
      await IPLimit.findOneAndUpdate(query, { $inc: { searchCount: -1 } });
      const idDisplay =
        identifier.type === "deviceId"
          ? `deviceId: ${identifier.value.substring(0, 12)}...`
          : `IP: ${identifier.value.substring(0, 8)}...`;
      console.warn(`[SearchLimit] Prevented exceeding limit for ${idDisplay}`);
    }

    if (process.env.NODE_ENV !== "production") {
      const idDisplay =
        identifier.type === "deviceId"
          ? `deviceId: ${identifier.value.substring(0, 12)}...`
          : `IP: ${identifier.value.substring(0, 8)}...`;
      console.log(`[SearchLimit] Incremented search count for ${idDisplay}`);
    }
  } catch (error) {
    console.error("[SearchLimit] Error incrementing count:", error);
  }
}

/**
 * Get debug info for search limits
 */
export async function getSearchLimitDebug(req) {
  const identifier = getDeviceIdentifier(req);

  if (!identifier) {
    return {
      error: "No device identifier found (neither deviceId nor IP)",
      identifier: null,
    };
  }

  // Build query based on identifier type
  const query =
    identifier.type === "deviceId"
      ? { deviceId: identifier.value }
      : { hashedIP: identifier.value };

  const limitRecord = await IPLimit.findOne(query).lean();

  const count = limitRecord?.searchCount || 0;
  const remaining = Math.max(0, MAX_FREE_SEARCHES - count);

  const clientIP = getClientIP(req);
  const result = {
    identifierType: identifier.type,
    identifier:
      identifier.type === "deviceId"
        ? identifier.value.substring(0, 12) + "..."
        : identifier.value.substring(0, 8) + "...",
    searchCount: count,
    remaining,
    lastSearchAt: limitRecord?.lastSearchAt || null,
    maxFreeSearches: MAX_FREE_SEARCHES,
    canSearch: count < MAX_FREE_SEARCHES,
  };

  if (clientIP) {
    result.clientIP = clientIP.substring(0, 8) + "...";
  }

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
