import crypto from "crypto";
import { DeviceToken } from "../models/DeviceToken.js";

const DEVICE_TOKEN_COOKIE_NAME = "device_token";
// Allow configuration via environment variable for testing
const MAX_FREE_SEARCHES = parseInt(process.env.MAX_FREE_SEARCHES || "6", 10);

// In-memory cache to prevent duplicate token creation during race conditions
// Maps IP+UserAgent -> { token, timestamp, promise }
const tokenCreationCache = new Map();
const CACHE_TTL = 10000; // 10 seconds

// Cleanup cache periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of tokenCreationCache.entries()) {
    if (now - data.timestamp > CACHE_TTL) {
      tokenCreationCache.delete(key);
    }
  }
}, 15000); // Cleanup every 15 seconds

// Generate a cache key based on request fingerprint
function getRequestFingerprint(req) {
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  const userAgent = req.get("user-agent") || "unknown";
  return `${ip}:${userAgent}`;
}

/**
 * Middleware to get or create a device token for anonymous users
 * Sets the token in a HttpOnly cookie and attaches it to req.deviceToken
 */
export async function getOrCreateDeviceToken(req, res, next) {
  try {
    // Check if user is authenticated - authenticated users don't need device tokens
    if (req.user) {
      req.deviceToken = null;
      return next();
    }

    // Try to get token from cookie
    let token = req.cookies?.[DEVICE_TOKEN_COOKIE_NAME];

    // Debug logging for incognito mode issues
    if (process.env.NODE_ENV !== "production") {
      console.log(`[DeviceToken] Cookie received: ${token ? "YES" : "NO"}`);
    }

    // If no token in cookie, generate a new one (or wait for existing creation)
    if (!token) {
      // Get request fingerprint to prevent parallel token creation
      const fingerprint = getRequestFingerprint(req);

      // Check if we're already creating a token for this fingerprint
      const cached = tokenCreationCache.get(fingerprint);
      if (cached && cached.promise) {
        // Wait for the existing token creation to complete
        if (process.env.NODE_ENV !== "production") {
          console.log(
            `[DeviceToken] Waiting for existing token creation for fingerprint: ${fingerprint.substring(
              0,
              20
            )}...`
          );
        }
        try {
          token = await cached.promise;

          // Set cookie for this request too
          const cookieOptions = {
            httpOnly: true,
            secure: true, // REQUIRED for cross-origin (sameSite: "none")
            sameSite: "none", // REQUIRED for cross-origin cookies
            maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
            path: "/",
          };
          res.cookie(DEVICE_TOKEN_COOKIE_NAME, token, cookieOptions);

          req.deviceToken = token;
          return next();
        } catch (error) {
          // If waiting failed, continue to create a new token
          console.error(
            "[DeviceToken] Error waiting for token creation:",
            error
          );
        }
      }

      // Create new token
      token = crypto.randomUUID();

      // Create promise for token creation to handle race conditions
      const tokenCreationPromise = (async () => {
        try {
          // Create device token record in database
          // Note: Token will auto-delete after 7 days if never used (via TTL index)
          await DeviceToken.create({
            token,
            searchCount: 0,
            // Don't set lastSearchAt initially - let TTL handle unused tokens
          });

          // Debug logging
          if (process.env.NODE_ENV !== "production") {
            console.log(
              `[DeviceToken] Created new token: ${token.substring(0, 8)}...`
            );
          }

          return token;
        } catch (error) {
          // If duplicate key error (token already exists), just continue
          if (error.code === 11000) {
            if (process.env.NODE_ENV !== "production") {
              console.log(
                `[DeviceToken] Token already exists in DB, skipping creation`
              );
            }
            return token;
          }
          throw error;
        }
      })();

      // Store in cache with promise
      tokenCreationCache.set(fingerprint, {
        token,
        timestamp: Date.now(),
        promise: tokenCreationPromise,
      });

      // Wait for token creation
      try {
        await tokenCreationPromise;
      } catch (error) {
        console.error("[DeviceToken] Error creating token:", error);
      } finally {
        // Clean up cache after a delay
        setTimeout(() => tokenCreationCache.delete(fingerprint), CACHE_TTL);
      }

      // Set HttpOnly cookie (expires in 1 year)
      // Use sameSite: "none" and secure: true for cross-origin support (required on Vercel)
      const cookieOptions = {
        httpOnly: true,
        secure: true, // REQUIRED for cross-origin (sameSite: "none")
        sameSite: "none", // REQUIRED for cross-origin cookies
        maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
        path: "/",
      };
      res.cookie(DEVICE_TOKEN_COOKIE_NAME, token, cookieOptions);
    } else {
      // Verify token exists in database
      const deviceTokenRecord = await DeviceToken.findOne({ token });

      if (!deviceTokenRecord) {
        // Token in cookie but not in DB - create new one
        token = crypto.randomUUID();
        await DeviceToken.create({
          token,
          searchCount: 0,
        });

        res.cookie(DEVICE_TOKEN_COOKIE_NAME, token, {
          httpOnly: true,
          secure: true, // REQUIRED for cross-origin (sameSite: "none")
          sameSite: "none", // REQUIRED for cross-origin cookies
          maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
          path: "/",
        });
      }
    }

    req.deviceToken = token;
    next();
  } catch (error) {
    console.error("Error in getOrCreateDeviceToken middleware:", error);
    // Continue without device token if there's an error
    req.deviceToken = null;
    next();
  }
}

/**
 * Check if anonymous user can perform a search
 * Uses deviceToken only
 * Returns { canSearch: boolean, remaining: number }
 */
export async function checkSearchLimit(deviceToken, req = null) {
  void req;
  if (deviceToken) {
    try {
      const deviceTokenRecord = await DeviceToken.findOne({
        token: deviceToken,
      });

      if (deviceTokenRecord) {
        const remaining = Math.max(
          0,
          MAX_FREE_SEARCHES - deviceTokenRecord.searchCount
        );
        return {
          canSearch: remaining > 0,
          remaining,
        };
      }
    } catch (error) {
      console.error("Error checking device token search limit:", error);
    }
  }

  // If no deviceToken, allow (fail open)
  return { canSearch: true, remaining: MAX_FREE_SEARCHES };
}

/**
 * Increment search count for a device token
 */
export async function incrementSearchCount(deviceToken, req = null) {
  void req;
  if (deviceToken) {
    try {
      await DeviceToken.findOneAndUpdate(
        { token: deviceToken },
        {
          $inc: { searchCount: 1 },
          $set: { lastSearchAt: new Date() },
        },
        { upsert: false } // Don't create if doesn't exist (should already exist)
      );
      return;
    } catch (error) {
      console.error("Error incrementing device token search count:", error);
    }
  }
}
