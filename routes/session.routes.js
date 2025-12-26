import { Router } from "express";
import { User } from "../models/User.js";
import { Profile } from "../models/Profile.js";
import jwt from "jsonwebtoken";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production";

// Generate JWT token
function generateToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "7d" });
}

// POST /api/auth/register - Register new user
router.post("/auth/register", async (req, res) => {
  const { username, email, password, role, medicalInterests } = req.body || {};
  
  if (!username || !email || !password || !["patient", "researcher"].includes(role)) {
    return res.status(400).json({ error: "username, email, password, and role are required" });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  try {
    // Check if user already exists
    const existingUser = await User.findOne({ email, role });
    if (existingUser) {
      return res.status(400).json({ error: "User with this email and role already exists" });
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
      return res.status(400).json({ error: "Email already exists for this role" });
    }
    return res.status(500).json({ error: "Failed to register user" });
  }
});

// POST /api/auth/login - Login with email and password
router.post("/auth/login", async (req, res) => {
  const { email, password, role } = req.body || {};
  
  if (!email || !password || !["patient", "researcher"].includes(role)) {
    return res.status(400).json({ error: "email, password, and role are required" });
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

// PUT /api/auth/update-user - Update user information (username)
router.put("/auth/update-user/:userId", async (req, res) => {
  const { userId } = req.params;
  const { username } = req.body || {};
  
  if (!userId) {
    return res.status(400).json({ error: "userId is required" });
  }

  try {
    const updateData = {};
    if (username) {
      updateData.username = username;
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const user = await User.findByIdAndUpdate(
      userId,
      updateData,
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
    console.error("User update error:", error);
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
    const hasOnboardingData = !!(role || conditions || location || gender || specialty || researchInterests);

    if (!user) {
      // Try to find by email (user might have registered traditionally before)
      // We'll look for any user with this email
      const existingByEmail = await User.findOne({ email });
      
      if (existingByEmail) {
        // Link OAuth to existing account
        existingByEmail.auth0Id = auth0Id;
        existingByEmail.oauthProvider = provider;
        existingByEmail.picture = picture || existingByEmail.picture;
        existingByEmail.emailVerified = emailVerified || existingByEmail.emailVerified;
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
          emailVerified: emailVerified || false,
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
          } else if (userRole === "researcher" && (specialty || researchInterests || location || educationHistory || skills)) {
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
      user.picture = picture || user.picture;
      user.emailVerified = emailVerified || user.emailVerified;
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
          error: "Auth0 information required to create account. Please sign in again." 
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
          emailVerified: emailVerified || false,
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
          ...(role === "patient" ? { patient: { conditions: [], location: {} } } : {}),
          ...(role === "researcher" ? { researcher: { researchAreas: [], institution: "" } } : {}),
        } 
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
  return res.status(400).json({ error: "Please use /api/auth/register with email and password" });
});

// POST /api/session/signin - Legacy endpoint, redirects to login
router.post("/session/signin", async (req, res) => {
  return res.status(400).json({ error: "Please use /api/auth/login with email and password" });
});

export default router;


