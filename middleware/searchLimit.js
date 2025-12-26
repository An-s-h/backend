import crypto from "crypto";
import { SearchLimit } from "../models/SearchLimit.js";

/**
 * RISK-SCORING BASED SEARCH LIMIT SYSTEM
 *
 * Philosophy:
 * - No hard blocks for anonymous users
 * - Soft thresholds: warn → slow down → require action
 * - Fingerprint is a SIGNAL, not an ID (probabilistic)
 * - Time decay: old searches matter less
 * - Transparent: clear messaging about limits
 *
 * Risk Signals (weighted):
 * - Device Token (cookie): +3 weight (most reliable, user can clear)
 * - Signal Hash (coarse fingerprint): +2 weight (probabilistic match)
 * - IP Address: +1 weight (least reliable, shared IPs exist)
 */

// Configuration
const MAX_FREE_SEARCHES = parseInt(process.env.MAX_FREE_SEARCHES || "6", 10);
const SIGNAL_HEADER = "x-client-signal";
const DEVICE_ID_HEADER = "x-device-id";

// Risk weights for different signals
const RISK_WEIGHTS = {
  deviceToken: 3, // High confidence - user's explicit device
  signalHash: 2, // Medium confidence - probabilistic match
  ip: 1, // Low confidence - many false positives
};

// Thresholds for different actions
const THRESHOLDS = {
  ALLOWED: 0, // Free to search
  WARNING: MAX_FREE_SEARCHES - 2, // Show warning about remaining
  SLOW_DOWN: MAX_FREE_SEARCHES - 1, // Add slight delay
  SOFT_LIMIT: MAX_FREE_SEARCHES, // Suggest sign-up
  HARD_LIMIT: MAX_FREE_SEARCHES + 2, // Actually block (with override option)
};

// Time decay: searches older than this are weighted less
const DECAY_HOURS = 24;

/**
 * Hash a string for privacy (one-way)
 */
export function hashString(str) {
  if (!str) return null;
  const salt = process.env.HASH_SALT || "curalink-search-limit-salt";
  const hash = crypto.createHash("sha256");
  hash.update(str + salt);
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
 * Extract all signals from request
 */
function extractSignals(req) {
  if (!req) return { signals: [], raw: {} };

  const signals = [];
  const raw = {};

  // 1. Device Token from cookie (most reliable)
  const deviceToken = req.cookies?.device_token;
  if (deviceToken) {
    signals.push({
      id: deviceToken,
      type: "deviceToken",
      weight: RISK_WEIGHTS.deviceToken,
    });
    raw.deviceToken = deviceToken.substring(0, 8) + "...";
  }

  // 2. Device ID from header (localStorage-based, fallback to cookie)
  const deviceId = req.headers[DEVICE_ID_HEADER];
  if (deviceId && deviceId !== deviceToken) {
    signals.push({
      id: hashString(deviceId),
      type: "deviceToken",
      weight: RISK_WEIGHTS.deviceToken,
    });
    raw.deviceId = deviceId.substring(0, 8) + "...";
  }

  // 3. Signal Hash (coarse browser fingerprint) - PROBABILISTIC
  const signalHash = req.headers[SIGNAL_HEADER];
  if (signalHash) {
    signals.push({
      id: signalHash,
      type: "signalHash",
      weight: RISK_WEIGHTS.signalHash,
    });
    raw.signalHash = signalHash;
  }

  // 4. IP Address (fallback - least reliable)
  const clientIP = getClientIP(req);
  if (clientIP) {
    const hashedIP = hashString(clientIP);
    if (hashedIP) {
      signals.push({
        id: hashedIP,
        type: "ip",
        weight: RISK_WEIGHTS.ip,
      });
      raw.ip = clientIP.substring(0, 10) + "...";
    }
  }

  return { signals, raw };
}

/**
 * Calculate time-decayed count
 * Recent searches count more than old ones
 */
function applyTimeDecay(searchCount, lastSearchAt) {
  if (!lastSearchAt) return searchCount;

  const hoursSinceLastSearch =
    (Date.now() - new Date(lastSearchAt).getTime()) / (1000 * 60 * 60);

  if (hoursSinceLastSearch > DECAY_HOURS * 7) {
    // After a week, reduce by 50%
    return Math.floor(searchCount * 0.5);
  } else if (hoursSinceLastSearch > DECAY_HOURS * 3) {
    // After 3 days, reduce by 25%
    return Math.floor(searchCount * 0.75);
  } else if (hoursSinceLastSearch > DECAY_HOURS) {
    // After 24 hours, reduce by 10%
    return Math.floor(searchCount * 0.9);
  }

  return searchCount;
}

/**
 * Calculate risk score from all matching records
 * Uses weighted signals, not just max count
 */
function calculateRiskScore(records, signals) {
  if (!records || records.length === 0) return { score: 0, effectiveCount: 0 };

  let totalWeight = 0;
  let weightedCount = 0;
  let highestCount = 0;

  for (const record of records) {
    // Find the signal that matched this record
    const matchingSignal = signals.find((s) => s.id === record.identifier);
    const weight = matchingSignal?.weight || 1;

    // Apply time decay
    const decayedCount = applyTimeDecay(
      record.searchCount,
      record.lastSearchAt
    );

    // Weighted contribution
    weightedCount += decayedCount * weight;
    totalWeight += weight;

    // Track highest raw count for hard limits
    if (record.searchCount > highestCount) {
      highestCount = record.searchCount;
    }
  }

  // Normalized weighted count
  const effectiveCount =
    totalWeight > 0 ? Math.round(weightedCount / totalWeight) : highestCount;

  return {
    score: effectiveCount,
    effectiveCount,
    highestRawCount: highestCount,
  };
}

/**
 * Determine action based on risk score
 */
function determineAction(score, highestRawCount) {
  // Hard limit uses raw count (no gaming the decay)
  if (highestRawCount >= THRESHOLDS.HARD_LIMIT) {
    return {
      action: "BLOCKED",
      canSearch: false,
      message:
        "You've reached your free search limit. Sign up for unlimited searches.",
      showSignUpPrompt: true,
    };
  }

  // Soft limit
  if (score >= THRESHOLDS.SOFT_LIMIT) {
    return {
      action: "SOFT_LIMIT",
      canSearch: true, // Still allowed but strongly encouraged to sign up
      message: "You've used all your free searches. Sign up to continue.",
      showSignUpPrompt: true,
      addDelay: 1000, // 1 second delay
    };
  }

  // Slow down
  if (score >= THRESHOLDS.SLOW_DOWN) {
    return {
      action: "SLOW_DOWN",
      canSearch: true,
      message: "Last free search! Sign up for unlimited access.",
      showSignUpPrompt: false,
      addDelay: 500, // 0.5 second delay
    };
  }

  // Warning
  if (score >= THRESHOLDS.WARNING) {
    return {
      action: "WARNING",
      canSearch: true,
      message: `${THRESHOLDS.SOFT_LIMIT - score} free searches remaining`,
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
 * Check search limit for anonymous user
 * Returns risk assessment with soft thresholds
 */
export async function checkSearchLimit(req) {
  const { signals, raw } = extractSignals(req);

  // If no signals at all, allow but log
  if (signals.length === 0) {
    console.warn("[SearchLimit] No signals found for request");
    return {
      canSearch: true,
      remaining: MAX_FREE_SEARCHES,
      action: "ALLOWED",
      signals: raw,
    };
  }

  try {
    // Find all records matching any signal
    const records = await SearchLimit.find({
      $or: signals.map(({ id, type }) => ({
        identifier: id,
        identifierType: type,
      })),
    });

    // Calculate risk score
    const { score, effectiveCount, highestRawCount } = calculateRiskScore(
      records,
      signals
    );
    const remaining = Math.max(0, MAX_FREE_SEARCHES - effectiveCount);
    const action = determineAction(score, highestRawCount);

    // Debug logging
    if (process.env.NODE_ENV !== "production") {
      console.log(
        `[SearchLimit] Check: signals=${signals.length}, score=${score}, remaining=${remaining}, action=${action.action}`
      );
    }

    return {
      ...action,
      remaining,
      effectiveCount,
      signals: raw,
    };
  } catch (error) {
    console.error("[SearchLimit] Error checking limit:", error);
    // Fail open - allow request if there's an error
    return {
      canSearch: true,
      remaining: MAX_FREE_SEARCHES,
      action: "ERROR",
      signals: raw,
    };
  }
}

/**
 * Increment search count for all signals
 * Links signals together for cross-device tracking
 *
 * FIX: Increment each signal by 1 individually, instead of syncing all to max.
 * This prevents the score from jumping multiple steps in a single search when
 * new signals (with low counts) are present alongside old signals (with high counts).
 */
export async function incrementSearchCount(req) {
  const { signals } = extractSignals(req);

  if (signals.length === 0) {
    console.warn("[SearchLimit] No signals to increment");
    return;
  }

  try {
    // Get all signal IDs for linking
    const allSignalIds = signals.map((s) => s.id);

    // Increment each signal's count by 1 individually (not sync to max)
    // This ensures one search = +1 to the effective score
    const updatePromises = signals.map(({ id, type }) =>
      SearchLimit.findOneAndUpdate(
        { identifier: id, identifierType: type },
        {
          $inc: { searchCount: 1 }, // Increment by 1, not set to max
          $set: { lastSearchAt: new Date() },
          $addToSet: {
            linkedIdentifiers: { $each: allSignalIds.filter((i) => i !== id) },
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      )
    );

    const results = await Promise.all(updatePromises);

    if (process.env.NODE_ENV !== "production") {
      const counts = results.map((r) => r.searchCount);
      console.log(
        `[SearchLimit] Incremented: ${
          signals.length
        } signals, counts=[${counts.join(",")}]`
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
  const { signals, raw } = extractSignals(req);

  const records = await SearchLimit.find({
    $or: signals.map(({ id, type }) => ({
      identifier: id,
      identifierType: type,
    })),
  }).lean();

  const { score, effectiveCount, highestRawCount } = calculateRiskScore(
    records,
    signals
  );

  return {
    signals: raw,
    signalCount: signals.length,
    records: records.map((r) => ({
      type: r.identifierType,
      count: r.searchCount,
      decayedCount: applyTimeDecay(r.searchCount, r.lastSearchAt),
      lastSearch: r.lastSearchAt,
      linkedCount: r.linkedIdentifiers?.length || 0,
    })),
    riskScore: score,
    effectiveCount,
    highestRawCount,
    remaining: Math.max(0, MAX_FREE_SEARCHES - effectiveCount),
    thresholds: THRESHOLDS,
    maxFreeSearches: MAX_FREE_SEARCHES,
  };
}

/**
 * Middleware to ensure device token cookie is set
 */
export function searchLimitMiddleware(req, res, next) {
  // Set device token cookie if not present
  if (!req.cookies?.device_token) {
    const newToken = `dt_${Date.now().toString(36)}_${crypto
      .randomBytes(8)
      .toString("hex")}`;
    res.cookie("device_token", newToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 1000 * 60 * 60 * 24 * 365, // 1 year
    });
    req.cookies = req.cookies || {};
    req.cookies.device_token = newToken;

    if (process.env.NODE_ENV !== "production") {
      console.log("[DeviceToken] New cookie set");
    }
  } else {
    if (process.env.NODE_ENV !== "production") {
      console.log("[DeviceToken] Cookie received: YES");
    }
  }

  next();
}

export { MAX_FREE_SEARCHES };
