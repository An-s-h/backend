import crypto from "crypto";

const TOKEN_SECRET =
  process.env.ANONYMOUS_TOKEN_SECRET ||
  "change-this-in-production-anonymous-token-secret";
const TOKEN_COOKIE_NAME = "anonymous_session_token";
const TOKEN_EXPIRY_DAYS = 365; // 1 year

/**
 * Generate an anonymous session token
 * Format: base64(uuid.issuedAt.signature)
 * Signature: HMAC-SHA256(uuid.issuedAt, secret)
 */
export function generateAnonymousToken() {
  const uuid = crypto.randomUUID();
  const issuedAt = Date.now();

  // Create HMAC signature
  const hmac = crypto.createHmac("sha256", TOKEN_SECRET);
  hmac.update(`${uuid}.${issuedAt}`);
  const signature = hmac.digest("hex");

  // Combine: uuid.issuedAt.signature
  const token = `${uuid}.${issuedAt}.${signature}`;

  // Base64 encode for cookie storage
  return Buffer.from(token).toString("base64url");
}

/**
 * Verify and parse an anonymous session token
 * Returns { valid: boolean, uuid: string, issuedAt: number } or null
 */
export function verifyAnonymousToken(tokenBase64) {
  if (!tokenBase64) return null;

  try {
    // Decode from base64url
    const token = Buffer.from(tokenBase64, "base64url").toString("utf-8");

    // Split into parts
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null; // Invalid format
    }

    const [uuid, issuedAtStr, signature] = parts;

    // Verify signature
    const hmac = crypto.createHmac("sha256", TOKEN_SECRET);
    hmac.update(`${uuid}.${issuedAtStr}`);
    const expectedSignature = hmac.digest("hex");

    // Constant-time comparison to prevent timing attacks
    if (
      !crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
      )
    ) {
      return null; // Invalid signature
    }

    const issuedAt = parseInt(issuedAtStr, 10);
    if (isNaN(issuedAt)) {
      return null; // Invalid timestamp
    }

    return {
      valid: true,
      uuid,
      issuedAt,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Get or create anonymous session token from request
 * Sets cookie if not present, returns token data
 */
export function getOrCreateAnonymousToken(req, res) {
  // Check if token exists in cookie
  let tokenBase64 = req.cookies?.[TOKEN_COOKIE_NAME];
  let tokenData = null;

  if (tokenBase64) {
    tokenData = verifyAnonymousToken(tokenBase64);
  }

  // If no valid token, generate new one
  if (!tokenData || !tokenData.valid) {
    tokenBase64 = generateAnonymousToken();
    tokenData = verifyAnonymousToken(tokenBase64); // Should always succeed

    // Set HttpOnly cookie
    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000, // 1 year
      path: "/",
    };

    res.cookie(TOKEN_COOKIE_NAME, tokenBase64, cookieOptions);
  }

  return {
    token: tokenBase64,
    uuid: tokenData?.uuid,
    issuedAt: tokenData?.issuedAt,
  };
}

/**
 * Get anonymous token UUID from request (without creating new one)
 */
export function getAnonymousTokenUuid(req) {
  const tokenBase64 = req.cookies?.[TOKEN_COOKIE_NAME];
  if (!tokenBase64) return null;

  const tokenData = verifyAnonymousToken(tokenBase64);
  return tokenData?.valid ? tokenData.uuid : null;
}

export { TOKEN_COOKIE_NAME };
