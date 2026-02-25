import { Router } from "express";
import mongoose from "mongoose";
import { Profile } from "../models/Profile.js";
import { User } from "../models/User.js";
import { clearRecommendationsCache } from "../services/recommendationsCache.js";
import { Thread } from "../models/Thread.js";
import { Reply } from "../models/Reply.js";
import { Community } from "../models/Community.js";
import { CommunityMembership } from "../models/CommunityMembership.js";
import { Follow } from "../models/Follow.js";
import { Post } from "../models/Post.js";
import {
  fetchFullORCIDProfile,
  fetchORCIDWorks,
} from "../services/orcid.service.js";
import { fetchAllWorksByOrcid } from "../services/openalex.service.js";
import { verifySession } from "../middleware/auth.js";

const router = Router();

// ResearchGate: exact hostnames
const RESEARCHGATE_HOSTS = ["researchgate.net", "www.researchgate.net"];
// Academia.edu: allow academia.edu and *.academia.edu (e.g. sohag-univ.academia.edu, www.academia.edu)
const ACADEMIA_DOMAIN_SUFFIX = ".academia.edu";
const ACADEMIA_REGEX =
  /^https?:\/\/(www\.)?([a-z0-9-]+\.)?academia\.edu\/[A-Za-z0-9._-]+$/i;

function validateAcademicUrl(url) {
  if (!url || typeof url !== "string")
    return { valid: false, platform: null, normalizedUrl: null };
  let normalized = url.trim();
  if (!normalized.startsWith("http://") && !normalized.startsWith("https://"))
    normalized = "https://" + normalized;
  let hostname;
  try {
    hostname = new URL(normalized).hostname.toLowerCase();
  } catch {
    return { valid: false, platform: null, normalizedUrl: null };
  }
  // ResearchGate: allowlist
  if (RESEARCHGATE_HOSTS.includes(hostname)) {
    return { valid: true, platform: "researchgate", normalizedUrl: normalized };
  }
  // Academia.edu: allow academia.edu and *.academia.edu
  if (
    hostname === "academia.edu" ||
    hostname.endsWith(ACADEMIA_DOMAIN_SUFFIX)
  ) {
    if (!ACADEMIA_REGEX.test(normalized))
      return { valid: false, platform: null, normalizedUrl: null };
    return { valid: true, platform: "academia", normalizedUrl: normalized };
  }
  return { valid: false, platform: null, normalizedUrl: null };
}

// GET /api/profile/:userId/forum-profile — public forum profile: name, username, forums posted, communities joined (for user profile modal)
router.get("/profile/:userId/forum-profile", async (req, res) => {
  try {
    const { userId } = req.params;
    const uid = new mongoose.Types.ObjectId(userId);

    const user = await User.findById(uid)
      .select("username handle picture role")
      .lean();
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    let displayName = user.handle || user.username || "User";
    if (user.role === "researcher") {
      const profile = await Profile.findOne({ userId: uid }).lean();
      if (profile?.researcher) {
        const { getResearcherDisplayName } = await import("../utils/researcherDisplayName.js");
        displayName = getResearcherDisplayName(user.username || user.name, profile.researcher);
      }
    }

    // Forums they have posted in (threads authored by this user; include community/subcategory context)
    const threads = await Thread.find({
      authorUserId: uid,
      isResearcherForum: false,
    })
      .populate("communityId", "name slug")
      .populate("subcategoryId", "name slug")
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    const forumsPosted = threads.map((t) => ({
      _id: t._id,
      title: t.title,
      community: t.communityId
        ? { name: t.communityId.name, slug: t.communityId.slug }
        : null,
      subcategory: t.subcategoryId ? { name: t.subcategoryId.name } : null,
      createdAt: t.createdAt,
    }));

    // Communities they have joined
    const memberships = await CommunityMembership.find({ userId: uid })
      .populate("communityId", "name slug color")
      .lean();

    const communitiesJoined = (memberships || [])
      .filter((m) => m.communityId)
      .map((m) => ({
        _id: m.communityId._id,
        name: m.communityId.name,
        slug: m.communityId.slug,
        color: m.communityId.color,
      }));

    res.json({
      user: {
        _id: user._id,
        username: user.username,
        handle: user.handle,
        picture: user.picture,
        role: user.role,
        displayName,
      },
      forumsPosted,
      communitiesJoined,
    });
  } catch (err) {
    if (err.name === "CastError")
      return res.status(400).json({ error: "Invalid user ID" });
    console.error("Error fetching forum profile:", err);
    res.status(500).json({ error: "Failed to load profile" });
  }
});

// GET /api/profile/:userId/landing-stats — Forums Participated, People Followed, Community Posts (real counts)
router.get("/profile/:userId/landing-stats", async (req, res) => {
  try {
    const { userId } = req.params;
    const uid = new mongoose.Types.ObjectId(userId);

    const user = await User.findById(uid).select("_id").lean();
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Forums Participated: distinct thread IDs where user authored (Thread) OR replied (Reply)
    const [authoredThreadIds, repliedThreadIds] = await Promise.all([
      Thread.find({ authorUserId: uid }).select("_id").lean(),
      Reply.find({ authorUserId: uid }).distinct("threadId"),
    ]);
    const authoredIds = new Set(authoredThreadIds.map((t) => t._id.toString()));
    repliedThreadIds.forEach((id) => authoredIds.add(id.toString()));
    const forumsParticipated = authoredIds.size;

    // People Followed
    const peopleFollowed = await Follow.countDocuments({ followerId: uid });

    // Community Posts
    const communityPosts = await Post.countDocuments({ authorUserId: uid });

    res.json({
      forumsParticipated,
      peopleFollowed,
      communityPosts,
    });
  } catch (err) {
    if (err.name === "CastError")
      return res.status(400).json({ error: "Invalid user ID" });
    console.error("Error fetching landing stats:", err);
    res.status(500).json({ error: "Failed to load stats" });
  }
});

// GET /api/profile/publications — must be before /profile/:userId so "publications" is not captured as userId
router.get("/profile/publications", verifySession, async (req, res) => {
  try {
    const user = req.user;
    if (!user)
      return res.status(401).json({ error: "Authentication required" });

    const profile = await Profile.findOne({ userId: user._id }).lean();
    if (!profile || profile.role !== "researcher")
      return res
        .status(403)
        .json({ error: "Only researchers can fetch profile publications" });

    const orcid = profile.researcher?.orcid?.trim();
    if (!orcid)
      return res
        .status(400)
        .json({
          error: "ORCID is required. Add your ORCID in your profile first.",
        });

    const normalizedOrcid = orcid.replace(/\s+/g, "");

    // Fetch from both ORCID and OpenAlex in parallel
    const [orcidWorks, openalexWorks] = await Promise.allSettled([
      fetchORCIDWorks(normalizedOrcid),
      fetchAllWorksByOrcid(orcid),
    ]);

    const orcidList = orcidWorks.status === "fulfilled" ? orcidWorks.value : [];
    const openalexList =
      openalexWorks.status === "fulfilled" ? openalexWorks.value : [];

    // Deduplicate and merge: prefer doi > pmid > openalexId/orcidWorkId as match key
    const map = new Map();
    const getKey = (p) => {
      if (p.doi) return `doi:${String(p.doi).toLowerCase().trim()}`;
      if (p.pmid) return `pmid:${String(p.pmid).trim()}`;
      if (p.openalexId) return `oa:${p.openalexId}`;
      if (p.orcidWorkId) return `orcid:${p.orcidWorkId}`;
      return `title:${(p.title || "").slice(0, 80)}`;
    };
    const addToMap = (pub, source) => {
      const key = getKey(pub);
      const existing = map.get(key);
      if (existing) {
        const sources = new Set(
          (existing.source || "").split(", ").filter(Boolean),
        );
        sources.add(source);
        existing.source = [...sources].sort().join(", ");
        // Prefer OpenAlex fields when merging (has citedByCount)
        if (source === "openalex" && pub.openalexId)
          existing.openalexId = pub.openalexId;
        if (source === "orcid" && pub.orcidWorkId)
          existing.orcidWorkId = pub.orcidWorkId;
      } else {
        map.set(key, { ...pub, source });
      }
    };

    for (const w of orcidList) addToMap(w, "orcid");
    for (const w of openalexList) addToMap(w, "openalex");

    const publications = Array.from(map.values());
    return res.json({ publications });
  } catch (err) {
    console.error("Fetch profile publications error:", err);
    return res.status(500).json({ error: "Failed to fetch publications" });
  }
});

// GET /api/profile/:userId
router.get("/profile/:userId", async (req, res) => {
  const { userId } = req.params;
  const profile = await Profile.findOne({ userId });
  return res.json({ profile });
});

// PUT /api/profile/:userId/selected-publications — Save selected publications to display on profile
router.put(
  "/profile/:userId/selected-publications",
  verifySession,
  async (req, res) => {
    try {
      const user = req.user;
      if (!user)
        return res.status(401).json({ error: "Authentication required" });

      const { userId } = req.params;
      const userIdStr = user._id?.toString?.() || String(user.id);
      if (userId !== userIdStr)
        return res
          .status(403)
          .json({ error: "You can only update your own profile publications" });

      const profile = await Profile.findOne({ userId: user._id });
      if (!profile || profile.role !== "researcher")
        return res
          .status(403)
          .json({ error: "Only researchers can update profile publications" });

      let selectedPublications = req.body?.selectedPublications;
      if (typeof selectedPublications === "string") {
        try {
          selectedPublications = JSON.parse(selectedPublications);
        } catch {
          return res
            .status(400)
            .json({ error: "Invalid selectedPublications format" });
        }
      }
      if (!Array.isArray(selectedPublications)) {
        return res
          .status(400)
          .json({ error: "selectedPublications must be an array" });
      }

      // Normalize and validate each publication (plain objects, correct types for Mongoose)
      const sanitized = selectedPublications.slice(0, 100).map((p) => {
        const item = {
          title: String(p.title || "Untitled"),
          year: p.year != null ? Number(p.year) || null : null,
          journal: String(p.journal || p.journalTitle || ""),
          journalTitle: String(p.journalTitle || p.journal || ""),
          doi: p.doi ? String(p.doi) : null,
          pmid: p.pmid ? String(p.pmid) : null,
          link: p.link || p.url ? String(p.link || p.url) : null,
          url: p.url || p.link ? String(p.url || p.link) : null,
          authors: Array.isArray(p.authors)
            ? p.authors.map((a) => String(a))
            : [],
          type: p.type ? String(p.type) : null,
          openalexId: p.openalexId ? String(p.openalexId) : null,
          orcidWorkId: p.orcidWorkId != null ? String(p.orcidWorkId) : null,
          source: p.source ? String(p.source) : null,
        };
        return item;
      });

      const updated = await Profile.findOneAndUpdate(
        { userId: user._id },
        { $set: { "researcher.selectedPublications": sanitized } },
        { new: true },
      ).lean();

      return res.json({
        ok: true,
        selectedPublications:
          updated?.researcher?.selectedPublications || sanitized,
      });
    } catch (err) {
      console.error("Save selected publications error:", err);
      return res
        .status(500)
        .json({ error: "Failed to save selected publications" });
    }
  },
);

// POST /api/profile/link-academic — must be before /profile/:userId so "link-academic" is not captured as userId
router.post("/profile/link-academic", verifySession, async (req, res) => {
  try {
    const { url } = req.body || {};
    const user = req.user;
    if (!user)
      return res.status(401).json({ error: "Authentication required" });
    if (!url || !url.trim())
      return res.status(400).json({ error: "URL is required" });

    const validation = validateAcademicUrl(url.trim());
    if (!validation.valid)
      return res
        .status(400)
        .json({
          error:
            "Invalid URL. Use a ResearchGate or Academia.edu profile link.",
        });

    const profile = await Profile.findOne({ userId: user._id });
    if (!profile || profile.role !== "researcher")
      return res
        .status(403)
        .json({ error: "Only researchers can link academic profiles" });

    const update = {};
    if (validation.platform === "researchgate") {
      update["researcher.researchGate"] = validation.normalizedUrl;
      update["researcher.researchGateVerification"] = "pending";
    } else {
      update["researcher.academiaEdu"] = validation.normalizedUrl;
      update["researcher.academiaEduVerification"] = "pending";
    }
    await Profile.findOneAndUpdate(
      { userId: user._id },
      { $set: update },
      { new: true },
    );

    return res.json({
      ok: true,
      saved: true,
      status: "pending",
      platform: validation.platform,
      normalizedUrl: validation.normalizedUrl,
      message: "Your profile will be reviewed by a moderator and verified.",
    });
  } catch (err) {
    console.error("link-academic error:", err);
    return res
      .status(500)
      .json({ error: err.message || "Failed to save link" });
  }
});

// POST /api/profile/:userId
router.post("/profile/:userId", async (req, res) => {
  const { userId } = req.params;
  const payload = req.body || {};
  if (!payload.role) return res.status(400).json({ error: "role is required" });

  // Auto-verify researchers with ORCID
  if (payload.role === "researcher" && payload.researcher?.orcid) {
    // If ORCID exists and is being set/updated, auto-verify
    if (payload.researcher.orcid.trim()) {
      payload.researcher.isVerified = true;
    }
  }

  const doc = await Profile.findOneAndUpdate(
    { userId },
    { ...payload, userId },
    { new: true, upsert: true },
  );
  return res.json({ ok: true, profile: doc });
});

// PUT /api/profile/:userId (same as POST for frontend compatibility)
router.put("/profile/:userId", async (req, res) => {
  const { userId } = req.params;
  const payload = req.body || {};
  if (!payload.role) return res.status(400).json({ error: "role is required" });

  // Auto-verify researchers with ORCID
  if (payload.role === "researcher" && payload.researcher?.orcid) {
    // If ORCID exists and is being set/updated, auto-verify
    if (payload.researcher.orcid.trim()) {
      payload.researcher.isVerified = true;
    }
  }

  const doc = await Profile.findOneAndUpdate(
    { userId },
    { ...payload, userId },
    { new: true, upsert: true },
  );
  return res.json({ ok: true, profile: doc });
});

// PATCH /api/profile/:userId/patient-conditions — update patient conditions and optional primary query indices
// Clears recommendations cache so next load uses new conditions.
router.patch("/profile/:userId/patient-conditions", async (req, res) => {
  try {
    const { userId } = req.params;
    let conditions = req.body?.conditions;
    if (!Array.isArray(conditions)) {
      if (typeof conditions === "string") {
        conditions = conditions
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      } else {
        return res
          .status(400)
          .json({ error: "conditions must be an array of strings" });
      }
    }
    conditions = conditions.map((c) => String(c).trim()).filter(Boolean);

    let primaryConditionIndices = req.body?.primaryConditionIndices;
    if (primaryConditionIndices != null) {
      if (!Array.isArray(primaryConditionIndices)) {
        primaryConditionIndices = [];
      }
      primaryConditionIndices = primaryConditionIndices
        .map((i) => parseInt(i, 10))
        .filter((i) => Number.isInteger(i) && i >= 0 && i < conditions.length)
        .slice(0, 2); // max 2
    }

    const update = { "patient.conditions": conditions };
    if (primaryConditionIndices != null) {
      update["patient.primaryConditionIndices"] = primaryConditionIndices;
    }

    const doc = await Profile.findOneAndUpdate(
      { userId },
      { $set: update },
      { new: true },
    );
    if (!doc) {
      return res.status(404).json({ error: "Profile not found" });
    }
    clearRecommendationsCache(userId);
    return res.json({
      ok: true,
      profile: doc,
      conditions: doc?.patient?.conditions || conditions,
      primaryConditionIndices: doc?.patient?.primaryConditionIndices,
    });
  } catch (err) {
    console.error("Error updating patient conditions:", err);
    return res
      .status(500)
      .json({ error: "Failed to update conditions", message: err.message });
  }
});

// PATCH /api/profile/:userId/researcher-interests — update researcher interests and optional primary query indices
// Clears recommendations cache so next load uses new interests.
router.patch("/profile/:userId/researcher-interests", async (req, res) => {
  try {
    const { userId } = req.params;
    let interests = req.body?.interests;
    if (!Array.isArray(interests)) {
      if (typeof interests === "string") {
        interests = interests
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      } else {
        return res
          .status(400)
          .json({ error: "interests must be an array of strings" });
      }
    }
    interests = interests.map((i) => String(i).trim()).filter(Boolean);

    let primaryInterestIndices = req.body?.primaryInterestIndices;
    if (primaryInterestIndices != null) {
      if (!Array.isArray(primaryInterestIndices)) {
        primaryInterestIndices = [];
      }
      primaryInterestIndices = primaryInterestIndices
        .map((i) => parseInt(i, 10))
        .filter((i) => Number.isInteger(i) && i >= 0 && i < interests.length)
        .slice(0, 2); // max 2
    }

    const update = { "researcher.interests": interests };
    if (primaryInterestIndices != null) {
      update["researcher.primaryInterestIndices"] = primaryInterestIndices;
    }

    const doc = await Profile.findOneAndUpdate(
      { userId },
      { $set: update },
      { new: true },
    );
    if (!doc) {
      return res.status(404).json({ error: "Profile not found" });
    }
    clearRecommendationsCache(userId);
    return res.json({
      ok: true,
      profile: doc,
      interests: doc?.researcher?.interests || interests,
      primaryInterestIndices: doc?.researcher?.primaryInterestIndices,
    });
  } catch (err) {
    console.error("Error updating researcher interests:", err);
    return res
      .status(500)
      .json({ error: "Failed to update interests", message: err.message });
  }
});

// GET /api/collabiora-expert/profile/:userId - Get Collabiora expert profile with ORCID data and forums
router.get("/collabiora-expert/profile/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { currentUserId } = req.query; // For checking follow/favorite status

    // Fetch profile from database
    const profile = await Profile.findOne({ userId })
      .populate("userId", "username email")
      .lean();

    if (!profile || profile.role !== "researcher") {
      return res.status(404).json({ error: "CuraLink expert not found" });
    }

    const user = profile.userId;
    const researcher = profile.researcher || {};

    // Base profile data from database
    let profileData = {
      _id: user._id || user.id,
      userId: user._id || user.id,
      name: user.username || "Unknown Researcher",
      email: user.email,
      orcid: researcher.orcid || null,
      researchGate: researcher.researchGate || null,
      researchGateVerification: researcher.researchGateVerification || null,
      academiaEdu: researcher.academiaEdu || null,
      academiaEduVerification: researcher.academiaEduVerification || null,
      bio: researcher.bio || null,
      location: researcher.location || null,
      specialties: researcher.specialties || [],
      interests: researcher.interests || [],
      available: researcher.available || false,
      isVerified: researcher.isVerified || false,
      onCuraLink: true, // They are on CuraLink
      contactable: true, // They can be contacted (via message request)
    };

    // If ORCID exists, fetch ORCID profile data
    if (researcher.orcid) {
      try {
        // Normalize ORCID ID (remove spaces, ensure proper format)
        const normalizedOrcid = researcher.orcid.trim().replace(/\s+/g, "");
        const orcidProfileData = await fetchFullORCIDProfile(normalizedOrcid);
        if (orcidProfileData) {
          // Merge ALL ORCID data with database data (keep database name, ORCID takes precedence for other fields)
          profileData = {
            ...profileData,
            // Keep database name - don't use ORCID name
            name: profileData.name,
            // Use ORCID biography if available, otherwise use database bio
            biography: orcidProfileData.biography || researcher.bio || null,
            bio: orcidProfileData.biography || researcher.bio || null,
            // Use ORCID affiliation if available
            affiliation: orcidProfileData.affiliation || null,
            // Use ORCID location if available
            location: orcidProfileData.location || researcher.location || null,
            // Merge research interests from ORCID with database interests
            researchInterests: [
              ...new Set([
                ...(orcidProfileData.researchInterests || []),
                ...(researcher.interests || []),
                ...(researcher.specialties || []),
              ]),
            ],
            // Add ORCID-specific data - include ALL extracted fields
            email: orcidProfileData.email || user.email,
            currentPosition: orcidProfileData.currentPosition || null,
            education: orcidProfileData.education || null,
            age: orcidProfileData.age || null,
            yearsOfExperience: orcidProfileData.yearsOfExperience || null,
            achievements: orcidProfileData.achievements || null,
            // Specialties from ORCID (AI-extracted) or from database
            specialties:
              orcidProfileData.specialties?.length > 0
                ? orcidProfileData.specialties
                : researcher.specialties || [],
            // Areas of expertise (same as specialties/research interests, formatted for frontend)
            areasOfExpertise: [
              ...new Set([
                ...(orcidProfileData.specialties || []),
                ...(orcidProfileData.researchInterests || []),
                ...(researcher.specialties || []),
                ...(researcher.interests || []),
              ]),
            ].slice(0, 10), // Limit to top 10
            // Keep ORCID ID for reference
            orcidId: orcidProfileData.orcidId || normalizedOrcid,
            // Use researcher-selected publications if any; otherwise fall back to ORCID works
            works:
              researcher.selectedPublications?.length > 0
                ? researcher.selectedPublications.map((p) => ({
                    title: p.title || "Untitled",
                    year: p.year || null,
                    journal: p.journalTitle || p.journal || null,
                    journalTitle: p.journalTitle || p.journal || null,
                    doi: p.doi || null,
                    pmid: p.pmid || null,
                    link: p.link || p.url || null,
                    url: p.url || p.link || null,
                    authors: p.authors || [],
                    type: p.type || null,
                    id: p.pmid || p.doi || p.openalexId || p.orcidWorkId,
                    citations: 0,
                    source: p.source || null,
                  }))
                : orcidProfileData.works || [],
            publications:
              researcher.selectedPublications?.length > 0
                ? researcher.selectedPublications.map((p) => ({
                    title: p.title || "Untitled",
                    year: p.year || null,
                    journal: p.journalTitle || p.journal || null,
                    journalTitle: p.journalTitle || p.journal || null,
                    doi: p.doi || null,
                    pmid: p.pmid || null,
                    link: p.link || p.url || null,
                    url: p.url || p.link || null,
                    authors: p.authors || [],
                    type: p.type || null,
                    id: p.pmid || p.doi || p.openalexId || p.orcidWorkId,
                    citations: 0,
                    source: p.source || null,
                  }))
                : orcidProfileData.works || [],
            // Add impact metrics
            impactMetrics: orcidProfileData.impactMetrics || {
              totalPublications:
                researcher.selectedPublications?.length > 0
                  ? researcher.selectedPublications.length
                  : orcidProfileData.publications?.length || 0,
              hIndex: 0,
              totalCitations: 0,
              maxCitations: 0,
            },
            // Add all other ORCID data (note: researchInterests already merged above)
            externalLinks: orcidProfileData.externalLinks || {},
            // Additional ORCID data
            country: orcidProfileData.country || null,
            emails: orcidProfileData.emails || [],
            otherNames: orcidProfileData.otherNames || [],
            employments: orcidProfileData.employments || [],
            educations: orcidProfileData.educations || [],
            fundings: orcidProfileData.fundings || [],
            totalFundings: orcidProfileData.totalFundings || 0,
            totalPeerReviews: orcidProfileData.totalPeerReviews || 0,
            totalWorks:
              researcher.selectedPublications?.length > 0
                ? researcher.selectedPublications.length
                : orcidProfileData.totalWorks ||
                  orcidProfileData.publications?.length ||
                  0,
            publicationsAreSelected: !!(
              researcher.selectedPublications?.length > 0
            ),
          };
        } else {
          // ORCID fetch failed; use selectedPublications if any, else empty
          const sel = researcher.selectedPublications || [];
          const mapped = sel.map((p) => ({
            title: p.title || "Untitled",
            year: p.year || null,
            journal: p.journalTitle || p.journal || null,
            journalTitle: p.journalTitle || p.journal || null,
            doi: p.doi || null,
            pmid: p.pmid || null,
            link: p.link || p.url || null,
            url: p.url || p.link || null,
            authors: p.authors || [],
            type: p.type || null,
            id: p.pmid || p.doi || p.openalexId || p.orcidWorkId,
            citations: 0,
            source: p.source || null,
          }));
          profileData.publications = mapped;
          profileData.works = mapped;
          profileData.impactMetrics = {
            totalPublications: mapped.length,
            hIndex: 0,
            totalCitations: 0,
            maxCitations: 0,
          };
          profileData.publicationsAreSelected = mapped.length > 0;
        }
      } catch (error) {
        console.error("Error fetching ORCID profile:", error.message);
        // Use selectedPublications if any; otherwise empty
        const sel = researcher.selectedPublications || [];
        const mapped = sel.map((p) => ({
          title: p.title || "Untitled",
          year: p.year || null,
          journal: p.journalTitle || p.journal || null,
          journalTitle: p.journalTitle || p.journal || null,
          doi: p.doi || null,
          pmid: p.pmid || null,
          link: p.link || p.url || null,
          url: p.url || p.link || null,
          authors: p.authors || [],
          type: p.type || null,
          id: p.pmid || p.doi || p.openalexId || p.orcidWorkId,
          citations: 0,
          source: p.source || null,
        }));
        profileData.publications = mapped;
        profileData.works = mapped;
        profileData.impactMetrics = {
          totalPublications: mapped.length,
          hIndex: 0,
          totalCitations: 0,
          maxCitations: 0,
        };
        profileData.publicationsAreSelected = mapped.length > 0;
      }
    }

    // Fetch forums created by this expert
    const forums = await Thread.find({ authorUserId: userId })
      .populate("categoryId", "name slug")
      .populate("authorUserId", "username email")
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    // Get reply counts for each forum
    const forumIds = forums.map((f) => f._id);
    const replyCounts = await Reply.aggregate([
      { $match: { threadId: { $in: forumIds } } },
      { $group: { _id: "$threadId", count: { $sum: 1 } } },
    ]);

    const countMap = {};
    replyCounts.forEach((item) => {
      countMap[item._id.toString()] = item.count;
    });

    // Format forums for frontend
    const formattedForums = forums.map((forum) => ({
      _id: forum._id,
      categoryId: forum.categoryId?._id || forum.categoryId,
      categoryName: forum.categoryId?.name || "Uncategorized",
      authorUserId: forum.authorUserId?._id || forum.authorUserId,
      authorUsername: forum.authorUserId?.username || "Unknown",
      title: forum.title,
      body: forum.body,
      upvotes: forum.upvotes?.length || 0,
      downvotes: forum.downvotes?.length || 0,
      voteScore: (forum.upvotes?.length || 0) - (forum.downvotes?.length || 0),
      replyCount: countMap[forum._id.toString()] || 0,
      viewCount: forum.viewCount || 0,
      createdAt: forum.createdAt,
      updatedAt: forum.updatedAt,
    }));

    // Add forums to profile data
    profileData.forums = formattedForums;
    profileData.totalForums = formattedForums.length;

    // Fetch forums where expert has participated (replied to)
    // Convert userId to ObjectId for proper matching (handle both string and ObjectId)
    let userIdObjectId;
    if (mongoose.Types.ObjectId.isValid(userId)) {
      userIdObjectId = new mongoose.Types.ObjectId(userId);
    } else {
      userIdObjectId = userId; // Fallback if not valid ObjectId
    }

    // Find all replies by this expert
    const expertReplies = await Reply.find({
      $or: [
        { authorUserId: userIdObjectId },
        { authorUserId: userId }, // Also try string version for compatibility
      ],
    })
      .select("threadId")
      .lean();

    // Get unique thread IDs
    const participatedThreadIds = [
      ...new Set(expertReplies.map((reply) => reply.threadId.toString())),
    ];

    // If no replies found, set empty array
    if (participatedThreadIds.length === 0) {
      profileData.participatedForums = [];
      profileData.totalParticipatedForums = 0;
    } else {
      // Convert thread IDs to ObjectIds for query
      const threadObjectIds = participatedThreadIds
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

      // Fetch threads where expert has participated (INCLUDE all forums where they replied, even if they created them)
      const participatedForums =
        threadObjectIds.length > 0
          ? await Thread.find({
              _id: { $in: threadObjectIds },
            })
              .populate("categoryId", "name slug")
              .populate("authorUserId", "username email")
              .sort({ createdAt: -1 })
              .limit(20)
              .lean()
          : [];

      // Get reply counts for participated forums
      const participatedForumIds = participatedForums.map((f) => f._id);
      const participatedReplyCounts =
        participatedForumIds.length > 0
          ? await Reply.aggregate([
              { $match: { threadId: { $in: participatedForumIds } } },
              { $group: { _id: "$threadId", count: { $sum: 1 } } },
            ])
          : [];

      const participatedCountMap = {};
      participatedReplyCounts.forEach((item) => {
        participatedCountMap[item._id.toString()] = item.count;
      });

      // Get count of expert's replies in each participated forum
      const expertReplyCounts =
        participatedForumIds.length > 0
          ? await Reply.aggregate([
              {
                $match: {
                  threadId: { $in: participatedForumIds },
                  $or: [
                    { authorUserId: userIdObjectId },
                    { authorUserId: userId }, // Also try string version for compatibility
                  ],
                },
              },
              { $group: { _id: "$threadId", count: { $sum: 1 } } },
            ])
          : [];

      const expertReplyCountMap = {};
      expertReplyCounts.forEach((item) => {
        expertReplyCountMap[item._id.toString()] = item.count;
      });

      // Format participated forums for frontend
      const formattedParticipatedForums = participatedForums.map((forum) => ({
        _id: forum._id,
        categoryId: forum.categoryId?._id || forum.categoryId,
        categoryName: forum.categoryId?.name || "Uncategorized",
        authorUserId: forum.authorUserId?._id || forum.authorUserId,
        authorUsername: forum.authorUserId?.username || "Unknown",
        title: forum.title,
        body: forum.body,
        upvotes: forum.upvotes?.length || 0,
        downvotes: forum.downvotes?.length || 0,
        voteScore:
          (forum.upvotes?.length || 0) - (forum.downvotes?.length || 0),
        replyCount: participatedCountMap[forum._id.toString()] || 0,
        expertReplyCount: expertReplyCountMap[forum._id.toString()] || 0, // Number of replies by this expert
        isCreator:
          forum.authorUserId?._id?.toString() === userId ||
          forum.authorUserId?.toString() === userId, // Whether expert created this forum
        viewCount: forum.viewCount || 0,
        createdAt: forum.createdAt,
        updatedAt: forum.updatedAt,
      }));

      // Add participated forums to profile data
      profileData.participatedForums = formattedParticipatedForums;
      profileData.totalParticipatedForums = formattedParticipatedForums.length;
    }

    res.json({ profile: profileData });
  } catch (error) {
    console.error("Error fetching CuraLink expert profile:", error);
    res.status(500).json({ error: "Failed to fetch CuraLink expert profile" });
  }
});

export default router;
