import { Router } from "express";
import { User } from "../models/User.js";
import { Profile } from "../models/Profile.js";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { sendVerificationEmail } from "../services/email.service.js";
import { verifySession } from "../middleware/auth.js";

const router = Router();
const JWT_SECRET =
  process.env.JWT_SECRET || "your-secret-key-change-in-production";

// Generate JWT token
function generateToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "7d" });
}

// POST /api/auth/register - Register new user
router.post("/auth/register", async (req, res) => {
  const { username, email, password, role, medicalInterests } = req.body || {};

  if (
    !username ||
    !email ||
    !password ||
    !["patient", "researcher"].includes(role)
  ) {
    return res
      .status(400)
      .json({ error: "username, email, password, and role are required" });
  }

  if (password.length < 6) {
    return res
      .status(400)
      .json({ error: "Password must be at least 6 characters" });
  }

  try {
    // Check if user already exists
    const existingUser = await User.findOne({ email, role });
    if (existingUser) {
      return res
        .status(400)
        .json({ error: "User with this email and role already exists" });
    }

    // Create new user
    const user = await User.create({
      username,
      email,
      password, // Will be hashed by pre-save hook
      role,
      medicalInterests: medicalInterests || [],
    });

    // Generate JWT token
    const token = generateToken(user._id.toString());

    // Remove password from response
    const userResponse = user.toObject();
    delete userResponse.password;

    return res.json({ user: userResponse, token });
  } catch (error) {
    console.error("Registration error:", error);
    if (error.code === 11000) {
      return res
        .status(400)
        .json({ error: "Email already exists for this role" });
    }
    return res.status(500).json({ error: "Failed to register user" });
  }
});

// POST /api/auth/login - Login with email and password
router.post("/auth/login", async (req, res) => {
  const { email, password, role } = req.body || {};

  if (!email || !password || !["patient", "researcher"].includes(role)) {
    return res
      .status(400)
      .json({ error: "email, password, and role are required" });
  }

  try {
    // Find user by email and role
    const user = await User.findOne({ email, role });

    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Verify password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Generate JWT token
    const token = generateToken(user._id.toString());

    // Remove password from response
    const userResponse = user.toObject();
    delete userResponse.password;

    return res.json({ user: userResponse, token });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ error: "Failed to login" });
  }
});

// POST /api/auth/update-profile - Update user profile with medical interests/conditions
router.post("/auth/update-profile", async (req, res) => {
  const { userId, medicalInterests } = req.body || {};

  if (!userId) {
    return res.status(400).json({ error: "userId is required" });
  }

  try {
    const user = await User.findByIdAndUpdate(
      userId,
      { medicalInterests: medicalInterests || [] },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Remove password from response
    const userResponse = user.toObject();
    delete userResponse.password;

    return res.json({ user: userResponse });
  } catch (error) {
    console.error("Profile update error:", error);
    return res.status(500).json({ error: "Failed to update profile" });
  }
});

// PUT /api/auth/update-user - Update user information (username, handle, nameHidden, picture, age)
router.put("/auth/update-user/:userId", async (req, res) => {
  const { userId } = req.params;
  const { username, handle, nameHidden, picture, age } = req.body || {};

  if (!userId) {
    return res.status(400).json({ error: "userId is required" });
  }

  try {
    const updateData = {};
    if (username !== undefined) {
      updateData.username = username;
    }
    if (handle !== undefined) {
      // Check if handle is unique (if provided and not empty)
      if (handle && handle.trim()) {
        const existingUser = await User.findOne({ 
          handle: handle.trim(),
          _id: { $ne: userId }
        });
        if (existingUser) {
          return res.status(400).json({ error: "Handle is already taken" });
        }
        updateData.handle = handle.trim();
      } else {
        updateData.handle = undefined; // Allow clearing handle
      }
    }
    if (nameHidden !== undefined) {
      updateData.nameHidden = nameHidden;
    }
    if (picture !== undefined) {
      updateData.picture = picture;
    }
    if (age !== undefined) {
      updateData.age = age ? parseInt(age) : undefined;
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const user = await User.findByIdAndUpdate(userId, updateData, {
      new: true,
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Remove password from response
    const userResponse = user.toObject();
    delete userResponse.password;

    return res.json({ user: userResponse });
  } catch (error) {
    console.error("User update error:", error);
    // Handle duplicate key error for handle
    if (error.code === 11000 && error.keyPattern?.handle) {
      return res.status(400).json({ error: "Handle is already taken" });
    }
    return res.status(500).json({ error: "Failed to update user" });
  }
});

// ============================================
// OAUTH / AUTH0 ENDPOINTS
// ============================================

/**
 * POST /api/auth/oauth-sync
 * Sync OAuth user from Auth0 with our database
 * Creates new user or returns existing user
 * IMPORTANT: For sign-in flow (no onboarding data), new users are NOT created here
 * They must complete their profile first via /auth/complete-oauth-profile
 */
// Helper function to check if a picture URL is from an OAuth provider
function isOAuthPicture(pictureUrl) {
  if (!pictureUrl) return false;
  
  const oauthDomains = [
    'googleusercontent.com',
    'lh3.googleusercontent.com',
    'graph.microsoft.com',
    'live.com',
    'fbcdn.net',
    'facebook.com',
    'appleid.apple.com',
    'scontent',
    'auth0.com',
  ];
  
  return oauthDomains.some(domain => pictureUrl.includes(domain));
}

// Helper function to check if a picture URL is from a custom upload (S3/Cloudinary)
function isCustomPicture(pictureUrl) {
  if (!pictureUrl) return false;
  
  const customDomains = [
    'amazonaws.com',
    's3.',
    'cloudinary.com',
    'res.cloudinary.com',
  ];
  
  return customDomains.some(domain => pictureUrl.includes(domain));
}

router.post("/auth/oauth-sync", async (req, res) => {
  const {
    auth0Id,
    email,
    name,
    picture,
    emailVerified,
    provider,
    // Optional onboarding data (patient)
    role,
    conditions,
    location,
    gender,
    // Optional onboarding data (researcher)
    specialty,
    researchInterests,
    educationHistory,
    skills,
    interestedInMeetings,
    interestedInForums,
    meetingRate,
  } = req.body || {};

  if (!auth0Id || !email) {
    return res.status(400).json({ error: "auth0Id and email are required" });
  }

  try {
    // First, try to find user by Auth0 ID
    let user = await User.findOne({ auth0Id });
    let isNewUser = false;
    const hasOnboardingData = !!(
      role ||
      conditions ||
      location ||
      gender ||
      specialty ||
      researchInterests
    );

    if (!user) {
      // Try to find by email (user might have registered traditionally before)
      // We'll look for any user with this email
      const existingByEmail = await User.findOne({ email });

      if (existingByEmail) {
        // Link OAuth to existing account
        existingByEmail.auth0Id = auth0Id;
        existingByEmail.oauthProvider = provider;
        // Only update picture if user doesn't have a custom picture
        // If they have a custom picture (S3/Cloudinary), preserve it
        // If they have an OAuth picture or no picture, update with new OAuth picture
        if (picture) {
          if (!existingByEmail.picture || isOAuthPicture(existingByEmail.picture)) {
            existingByEmail.picture = picture;
          }
          // If existing picture is custom (S3/Cloudinary), don't overwrite it
        }
        // Don't update emailVerified from OAuth - keep existing status or set to false
        // existingByEmail.emailVerified = emailVerified || existingByEmail.emailVerified;
        existingByEmail.isOAuthUser = true;
        await existingByEmail.save();
        user = existingByEmail;
      } else {
        // New user - only create account if onboarding data is provided (sign-up flow)
        // For sign-in flow (no onboarding data), don't create account yet
        if (!hasOnboardingData) {
          // Sign-in flow: user doesn't exist and no onboarding data
          // Return Auth0 info so frontend can redirect to profile completion
          // Account will be created when they complete their profile
          return res.json({
            isNewUser: true,
            needsProfileCompletion: true,
            auth0User: {
              auth0Id,
              email,
              name: name || email.split("@")[0],
              picture,
              emailVerified: emailVerified || false,
              provider,
            },
            // No token or user - they need to complete profile first
          });
        }

        // Sign-up flow: create new OAuth user with onboarding data
        isNewUser = true;
        const userRole = role || "patient"; // Default to patient if not specified

        // Combine medical interests based on role
        let medicalInterests = [];
        if (userRole === "patient") {
          medicalInterests = conditions || [];
        } else if (userRole === "researcher") {
          medicalInterests = [
            ...(specialty ? [specialty] : []),
            ...(researchInterests || []),
          ];
        }

        user = await User.create({
          username: name || email.split("@")[0],
          email,
          auth0Id,
          oauthProvider: provider,
          picture,
          emailVerified: false, // Always start as unverified, even for OAuth users
          isOAuthUser: true,
          role: userRole,
          medicalInterests,
        });

        // Create profile with onboarding data
        if (role) {
          const profileData = {
            userId: user._id,
            role: userRole,
          };

          if (userRole === "patient" && (conditions || location || gender)) {
            profileData.patient = {
              conditions: conditions || [],
              location: location || {},
              gender: gender || undefined,
            };
          } else if (
            userRole === "researcher" &&
            (specialty ||
              researchInterests ||
              location ||
              educationHistory ||
              skills)
          ) {
            profileData.researcher = {
              specialties: specialty ? [specialty] : [],
              interests: researchInterests || [],
              location: location || {},
              education: educationHistory || [],
              skills: skills || [],
              available: interestedInMeetings || false,
              interestedInMeetings: interestedInMeetings || false,
              interestedInForums: interestedInForums || false,
              meetingRate: meetingRate ? parseFloat(meetingRate) : undefined,
            };
          }

          if (profileData.patient || profileData.researcher) {
            await Profile.findOneAndUpdate(
              { userId: user._id },
              { $set: profileData },
              { upsert: true, new: true }
            );
          }
        }
      }
    } else {
      // User exists, update their info
      user.username = name || user.username;
      // Only update picture if user doesn't have a custom picture
      // If they have a custom picture (S3/Cloudinary), preserve it
      // If they have an OAuth picture or no picture, update with new OAuth picture
      if (picture) {
        if (!user.picture || isOAuthPicture(user.picture)) {
          user.picture = picture;
        }
        // If existing picture is custom (S3/Cloudinary), don't overwrite it
      }
      // Don't update emailVerified from OAuth - keep existing status
      // user.emailVerified = emailVerified || user.emailVerified;
      if (provider) user.oauthProvider = provider;
      await user.save();
    }

    // Generate JWT token
    const token = generateToken(user._id.toString());

    // Remove sensitive fields from response
    const userResponse = user.toObject();
    delete userResponse.password;

    return res.json({
      user: userResponse,
      token,
      isNewUser,
    });
  } catch (error) {
    console.error("OAuth sync error:", error);
    return res.status(500).json({ error: "Failed to sync OAuth user" });
  }
});

/**
 * POST /api/auth/complete-oauth-profile
 * Complete OAuth user profile with role selection
 * Called after new OAuth users select their role
 * Creates account if it doesn't exist (for sign-in flow)
 */
router.post("/auth/complete-oauth-profile", async (req, res) => {
  const {
    role,
    // Auth0 info for account creation (required if user doesn't exist)
    auth0Id,
    email,
    name,
    picture,
    emailVerified,
    provider,
  } = req.body || {};

  if (!role || !["patient", "researcher"].includes(role)) {
    return res.status(400).json({ error: "Valid role is required" });
  }

  try {
    let user;

    // Try to get user from auth middleware first (existing user)
    const userId = req.user?.id || req.user?._id;

    if (userId) {
      // User exists and is authenticated
      user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      // Update user role
      user.role = role;
      await user.save();
    } else {
      // No authenticated user - this is a new user from sign-in flow
      // We need Auth0 info to create the account
      if (!auth0Id || !email) {
        return res.status(400).json({
          error:
            "Auth0 information required to create account. Please sign in again.",
        });
      }

      // Check if user already exists (shouldn't happen, but safety check)
      user = await User.findOne({ auth0Id });

      if (!user) {
        // Create new user account
        user = await User.create({
          username: name || email.split("@")[0],
          email,
          auth0Id,
          oauthProvider: provider,
          picture,
          emailVerified: false, // Always start as unverified
          isOAuthUser: true,
          role: role,
          medicalInterests: [],
        });
      } else {
        // User exists, update role
        user.role = role;
        await user.save();
      }
    }

    // Create initial profile
    await Profile.findOneAndUpdate(
      { userId: user._id },
      {
        $set: {
          userId: user._id,
          role,
          ...(role === "patient"
            ? { patient: { conditions: [], location: {} } }
            : {}),
          ...(role === "researcher"
            ? { researcher: { researchAreas: [], institution: "" } }
            : {}),
        },
      },
      { upsert: true, new: true }
    );

    // Generate JWT token for the user
    const token = generateToken(user._id.toString());

    // Remove sensitive fields from response
    const userResponse = user.toObject();
    delete userResponse.password;

    return res.json({
      user: userResponse,
      token, // Return token so frontend can store it
    });
  } catch (error) {
    console.error("Profile completion error:", error);
    return res.status(500).json({ error: "Failed to complete profile" });
  }
});

// Legacy endpoints for backward compatibility (can be removed later)
// POST /api/session - Legacy endpoint, redirects to register
router.post("/session", async (req, res) => {
  const { username, role, email } = req.body || {};
  if (!username || !["patient", "researcher"].includes(role)) {
    return res.status(400).json({ error: "username and role required" });
  }
  return res
    .status(400)
    .json({ error: "Please use /api/auth/register with email and password" });
});

// POST /api/session/signin - Legacy endpoint, redirects to login
router.post("/session/signin", async (req, res) => {
  return res
    .status(400)
    .json({ error: "Please use /api/auth/login with email and password" });
});

// ============================================
// EMAIL VERIFICATION ENDPOINTS
// ============================================

/**
 * POST /api/auth/send-verification-email
 * Send verification email to the authenticated user
 */
router.post(
  "/auth/send-verification-email",
  verifySession,
  async (req, res) => {
    try {
      const user = req.user;

      // Check if email is already verified
      if (user.emailVerified) {
        return res.status(400).json({ error: "Email is already verified" });
      }

      // Check if email was sent within the last 24 hours
      if (user.lastVerificationEmailSent) {
        const lastSentTime = new Date(user.lastVerificationEmailSent);
        const now = new Date();
        const hoursSinceLastSent = (now - lastSentTime) / (1000 * 60 * 60);

        if (hoursSinceLastSent < 24) {
          const hoursRemaining = Math.ceil(24 - hoursSinceLastSent);
          return res.status(429).json({
            error: `Please wait ${hoursRemaining} hour${
              hoursRemaining !== 1 ? "s" : ""
            } before requesting another verification email.`,
            hoursRemaining,
            canResendAt: new Date(lastSentTime.getTime() + 24 * 60 * 60 * 1000),
          });
        }
      }

      // Generate verification token
      const verificationToken = crypto.randomBytes(32).toString("hex");
      const tokenExpiry = new Date();
      tokenExpiry.setHours(tokenExpiry.getHours() + 24); // Token expires in 24 hours

      // Generate 6-digit OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const otpExpiry = new Date();
      otpExpiry.setMinutes(otpExpiry.getMinutes() + 15); // OTP expires in 15 minutes

      // Save token, OTP and update last sent time
      user.emailVerificationToken = verificationToken;
      user.emailVerificationTokenExpiry = tokenExpiry;
      user.emailVerificationOTP = otp;
      user.emailVerificationOTPExpiry = otpExpiry;
      user.lastVerificationEmailSent = new Date();
      await user.save();

      // Send verification email with both link and OTP
      try {
        await sendVerificationEmail(
          user.email,
          user.username,
          verificationToken,
          otp
        );
        return res.json({
          message: "Verification email sent successfully",
          email: user.email,
          otpExpiresAt: otpExpiry,
        });
      } catch (emailError) {
        console.error("Error sending verification email:", emailError);
        // Clear token if email sending fails
        user.emailVerificationToken = undefined;
        user.emailVerificationTokenExpiry = undefined;
        await user.save();
        return res.status(500).json({
          error:
            "Failed to send verification email. Please check email configuration.",
        });
      }
    } catch (error) {
      console.error("Send verification email error:", error);
      return res
        .status(500)
        .json({ error: "Failed to send verification email" });
    }
  }
);

/**
 * GET /api/auth/verify-email
 * Verify email using token from query parameter
 */
router.get("/auth/verify-email", async (req, res) => {
  let { token } = req.query;

  if (!token) {
    return res.status(400).json({ error: "Verification token is required" });
  }

  // Decode URL-encoded token
  try {
    token = decodeURIComponent(token);
  } catch (e) {
    // If decoding fails, use original token
    console.log("Token decode failed, using original:", e);
  }

  try {
    // First, find user with matching token (regardless of expiry or verification status)
    const user = await User.findOne({
      emailVerificationToken: token,
    });

    if (!user) {
      // Token not found - could be invalid, expired and cleared, or already used
      // Check if there are any recently verified users (within last 7 days)
      // who might have used this token
      // Since we can't match by token, we'll return invalid token message
      // But first, let's check if we can find users who were verified recently
      // and might have used this token (though we can't be 100% sure)

      // For now, return invalid token - but we should improve this
      // by keeping a record of used tokens or not clearing them immediately
      return res.status(400).json({
        error:
          "Invalid verification token. Please request a new verification email.",
        code: "INVALID_TOKEN",
      });
    }

    // User found with this token - check verification status first
    if (user.emailVerified) {
      // Email is already verified - this token was already used
      // Keep token for a bit longer (7 days) so we can detect re-clicks
      // But if it's been more than 7 days since verification, we can clear it
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      // Only clear if token expiry is very old (more than 7 days past original expiry)
      // Otherwise keep it so we can show "already verified" message
      if (
        user.emailVerificationTokenExpiry &&
        user.emailVerificationTokenExpiry < sevenDaysAgo
      ) {
        user.emailVerificationToken = undefined;
        user.emailVerificationTokenExpiry = undefined;
        await user.save();
      }

      return res.json({
        message: "Your email is already verified.",
        alreadyVerified: true,
        user: {
          _id: user._id,
          email: user.email,
          emailVerified: user.emailVerified,
        },
      });
    }

    // Email not verified yet - check if token is expired
    if (
      user.emailVerificationTokenExpiry &&
      user.emailVerificationTokenExpiry <= new Date()
    ) {
      return res.status(400).json({
        error:
          "This verification link has expired. Please request a new verification email.",
        code: "EXPIRED_TOKEN",
        expired: true,
      });
    }

    // Token is valid and email is not verified - verify the email
    // IMPORTANT: Don't clear the token immediately - keep it for 7 days
    // so if user clicks link again, we can detect it's already verified
    user.emailVerified = true;
    // Extend token expiry to 7 days from now so we can detect re-clicks
    // This allows us to show "already verified" message if link is clicked again
    const extendedExpiry = new Date();
    extendedExpiry.setDate(extendedExpiry.getDate() + 7); // 7 days from now
    user.emailVerificationTokenExpiry = extendedExpiry;
    // Keep the token so we can find the user if they click the link again
    // user.emailVerificationToken = undefined; // Don't clear - keep for detection
    await user.save();

    return res.json({
      message: "Email verified successfully",
      user: {
        _id: user._id,
        email: user.email,
        emailVerified: user.emailVerified,
      },
    });
  } catch (error) {
    console.error("Email verification error:", error);
    return res.status(500).json({ error: "Failed to verify email" });
  }
});

/**
 * POST /api/auth/verify-otp
 * Verify email using 6-digit OTP code
 */
router.post("/auth/verify-otp", verifySession, async (req, res) => {
  try {
    const { otp } = req.body;
    const user = req.user;

    if (!otp) {
      return res.status(400).json({ error: "OTP code is required" });
    }

    // Check if email is already verified
    if (user.emailVerified) {
      return res.json({
        message: "Your email is already verified.",
        alreadyVerified: true,
        user: {
          _id: user._id,
          email: user.email,
          emailVerified: user.emailVerified,
        },
      });
    }

    // Check if OTP exists and matches
    if (!user.emailVerificationOTP) {
      return res.status(400).json({
        error: "No OTP found. Please request a new verification email.",
        code: "NO_OTP",
      });
    }

    if (user.emailVerificationOTP !== otp) {
      return res.status(400).json({
        error: "Invalid OTP code. Please try again.",
        code: "INVALID_OTP",
      });
    }

    // Check if OTP is expired
    if (
      user.emailVerificationOTPExpiry &&
      user.emailVerificationOTPExpiry <= new Date()
    ) {
      return res.status(400).json({
        error: "This OTP code has expired. Please request a new verification email.",
        code: "EXPIRED_OTP",
        expired: true,
      });
    }

    // OTP is valid - verify the email
    user.emailVerified = true;
    // Clear OTP after successful verification
    user.emailVerificationOTP = undefined;
    user.emailVerificationOTPExpiry = undefined;
    // Extend token expiry to 7 days from now so we can detect re-clicks
    const extendedExpiry = new Date();
    extendedExpiry.setDate(extendedExpiry.getDate() + 7);
    if (user.emailVerificationTokenExpiry) {
      user.emailVerificationTokenExpiry = extendedExpiry;
    }
    await user.save();

    return res.json({
      message: "Email verified successfully",
      user: {
        _id: user._id,
        email: user.email,
        emailVerified: user.emailVerified,
      },
    });
  } catch (error) {
    console.error("OTP verification error:", error);
    return res.status(500).json({ error: "Failed to verify OTP" });
  }
});

/**
 * GET /api/auth/check-email-status
 * Check current user's email verification status
 * Requires authentication token
 */
router.get("/auth/check-email-status", verifySession, async (req, res) => {
  try {
    const user = req.user;

    // Check if verification email was sent recently
    let emailSent = false;
    let hoursRemaining = null;
    let canResendAt = null;

    if (user.lastVerificationEmailSent) {
      const lastSentTime = new Date(user.lastVerificationEmailSent);
      const now = new Date();
      const hoursSinceLastSent = (now - lastSentTime) / (1000 * 60 * 60);

      if (hoursSinceLastSent < 24) {
        emailSent = true;
        hoursRemaining = Math.ceil(24 - hoursSinceLastSent);
        canResendAt = new Date(lastSentTime.getTime() + 24 * 60 * 60 * 1000);
      }
    }

    return res.json({
      emailVerified: user.emailVerified || false,
      userId: user._id.toString(),
      emailSent,
      hoursRemaining,
      canResendAt: canResendAt ? canResendAt.toISOString() : null,
    });
  } catch (error) {
    console.error("Check email status error:", error);
    return res.status(500).json({ error: "Failed to check email status" });
  }
});

/**
 * POST /api/auth/reset-verification-email-limit
 * Reset the 24-hour limit for sending verification emails
 * Allows user to request a new verification email immediately
 * Requires authentication token
 */
router.post(
  "/auth/reset-verification-email-limit",
  verifySession,
  async (req, res) => {
    try {
      const user = req.user;

      // Check if email is already verified
      if (user.emailVerified) {
        return res.status(400).json({ error: "Email is already verified" });
      }

      // Reset the lastVerificationEmailSent timestamp
      user.lastVerificationEmailSent = undefined;
      await user.save();

      return res.json({
        message:
          "Verification email limit reset successfully. You can now request a new verification email.",
        success: true,
      });
    } catch (error) {
      console.error("Reset verification email limit error:", error);
      return res
        .status(500)
        .json({ error: "Failed to reset verification email limit" });
    }
  }
);

export default router;
