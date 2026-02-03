import express from "express";
import axios from "axios";
import jwt from "jsonwebtoken";

const router = express.Router();

// ORCID OAuth Configuration
const ORCID_CLIENT_ID = process.env.ORCID_CLIENT_ID || "APP-PYTJTCYSJWCJ40TN";
const ORCID_CLIENT_SECRET =
  process.env.ORCID_CLIENT_SECRET || "39dbd008-149c-4208-a3e9-00a08c5881ae";
const ORCID_REDIRECT_URI =
  process.env.ORCID_REDIRECT_URI ||
  (process.env.NODE_ENV === "production"
    ? "https://collabiora.vercel.app/auth/orcid/callback"
    : "http://localhost:5173/auth/orcid/callback");

// ORCID OAuth endpoints
const ORCID_AUTH_URL = "https://orcid.org/oauth/authorize";
const ORCID_TOKEN_URL = "https://orcid.org/oauth/token";

/**
 * @route   GET /api/orcid/auth
 * @desc    Initiate ORCID OAuth flow
 * @access  Public
 */
router.get("/orcid/auth", (req, res) => {
  try {
    // Generate state parameter for CSRF protection
    const state = jwt.sign(
      { timestamp: Date.now() },
      process.env.JWT_SECRET || "your-secret-key",
      { expiresIn: "10m" }
    );

    // Build authorization URL
    const authUrl = `${ORCID_AUTH_URL}?client_id=${ORCID_CLIENT_ID}&response_type=code&scope=/authenticate&redirect_uri=${encodeURIComponent(
      ORCID_REDIRECT_URI
    )}&state=${state}`;

    res.json({ authUrl, state });
  } catch (error) {
    console.error("Error initiating ORCID OAuth:", error);
    res.status(500).json({ error: "Failed to initiate ORCID authentication" });
  }
});

/**
 * @route   POST /api/orcid/callback
 * @desc    Handle ORCID OAuth callback and exchange code for token
 * @access  Public
 */
router.post("/orcid/callback", async (req, res) => {
  try {
    const { code, state } = req.body;

    if (!code) {
      return res.status(400).json({ error: "Authorization code is required" });
    }

    // Verify state parameter (CSRF protection)
    if (state) {
      try {
        jwt.verify(state, process.env.JWT_SECRET || "your-secret-key");
      } catch (error) {
        return res.status(400).json({ error: "Invalid state parameter" });
      }
    }

    // Exchange authorization code for access token
    const tokenResponse = await axios.post(
      ORCID_TOKEN_URL,
      new URLSearchParams({
        client_id: ORCID_CLIENT_ID,
        client_secret: ORCID_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: code,
        redirect_uri: ORCID_REDIRECT_URI,
      }),
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const { orcid, access_token, name } = tokenResponse.data;

    if (!orcid) {
      return res.status(400).json({ error: "ORCID ID not received" });
    }

    // Fetch full ORCID profile (optional, for additional data)
    let profileData = null;
    try {
      const profileResponse = await axios.get(
        `https://pub.orcid.org/v3.0/${orcid}/record`,
        {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${access_token}`,
          },
          timeout: 10000,
        }
      );

      const record = profileResponse.data;
      const person = record.person || {};
      const activities =
        record["activities-summary"] || record.activitiesSummary || {};

      // Extract useful profile information
      const given = person?.name?.["given-names"]?.value || "";
      const family = person?.name?.["family-name"]?.value || "";
      const fullName = `${given} ${family}`.trim() || name || "Unknown";

      // Get affiliations
      const employmentGroups =
        activities?.employments?.["affiliation-group"] || [];
      const employments = [];
      employmentGroups.forEach((group) => {
        const summaries = group.summaries || [];
        summaries.forEach((summary) => {
          if (summary["employment-summary"]) {
            employments.push(summary["employment-summary"]);
          }
        });
      });

      const currentAffiliation =
        employments[0]?.organization?.name ||
        employments[0]?.["department-name"] ||
        null;

      // Get research interests
      const interests =
        (person?.keywords?.keyword || [])
          .map((k) => k?.content)
          .filter(Boolean) || [];

      // Get primary email (if visible in record)
      const emails = person?.emails?.email || [];
      const primaryEmail = emails[0]?.email || null;

      profileData = {
        name: fullName,
        affiliation: currentAffiliation,
        researchInterests: interests,
        email: primaryEmail,
      };
    } catch (profileError) {
      console.error("Error fetching ORCID profile:", profileError.message);
      // Continue without profile data
    }

    // Return ORCID ID and profile data
    res.json({
      success: true,
      orcid,
      profile: profileData,
    });
  } catch (error) {
    console.error("Error handling ORCID callback:", error);
    if (error.response) {
      console.error("ORCID API error:", error.response.data);
      return res
        .status(error.response.status)
        .json({ error: error.response.data.error_description || "ORCID authentication failed" });
    }
    res.status(500).json({ error: "Failed to complete ORCID authentication" });
  }
});

/**
 * @route   GET /api/orcid/profile/:orcidId
 * @desc    Fetch ORCID profile by ID
 * @access  Public
 */
router.get("/orcid/profile/:orcidId", async (req, res) => {
  try {
    const { orcidId } = req.params;

    if (!orcidId) {
      return res.status(400).json({ error: "ORCID ID is required" });
    }

    // Fetch profile from public ORCID API
    const response = await axios.get(
      `https://pub.orcid.org/v3.0/${orcidId}/record`,
      {
        headers: { Accept: "application/json" },
        timeout: 10000,
      }
    );

    const record = response.data;
    const person = record.person || {};

    const given = person?.name?.["given-names"]?.value || "";
    const family = person?.name?.["family-name"]?.value || "";
    const fullName = `${given} ${family}`.trim();

    res.json({
      success: true,
      orcid: orcidId,
      name: fullName,
      profile: record,
    });
  } catch (error) {
    console.error("Error fetching ORCID profile:", error);
    res.status(500).json({ error: "Failed to fetch ORCID profile" });
  }
});

export default router;
