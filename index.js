import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { connectMongo } from "./config/mongo.js";
import sessionRoutes from "./routes/session.routes.js";
import profileRoutes from "./routes/profile.routes.js";
import searchRoutes from "./routes/search.routes.js";
import recommendationsRoutes from "./routes/recommendations.routes.js";
import favoritesRoutes from "./routes/favorites.routes.js";
import readItemsRoutes from "./routes/readItems.routes.js";
import forumsRoutes from "./routes/forums.routes.js";
import postsRoutes from "./routes/posts.routes.js";
import communitiesRoutes from "./routes/communities.routes.js";
import trialsRoutes from "./routes/trials.routes.js";
import aiRoutes from "./routes/ai.routes.js";
import insightsRoutes from "./routes/insights.routes.js";
import followRoutes from "./routes/follow.routes.js";
import messagesRoutes from "./routes/messages.routes.js";
import meetingRequestsRoutes from "./routes/meeting-requests.routes.js";
import connectionRequestsRoutes from "./routes/connection-requests.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import waitlistRoutes from "./routes/waitlist.routes.js";
import { optionalSession } from "./middleware/auth.js";
import { searchLimitMiddleware } from "./middleware/searchLimit.js";

dotenv.config();

const app = express();
app.use(
  cors({
    origin: [
  "http://localhost:5173",
  "https://collabiora.vercel.app",
  "https://collabiora-git-main-anshs-projects-d959a793.vercel.app",
  "https://collabioralandingpage.vercel.app",
  "https://incredible-otter-249a24.netlify.app",
  "https://www.collabiora.com",
  "https://collabiora.com"
],
    credentials: true, // Allow cookies to be sent
  })
);
app.use(cookieParser());
app.use(express.json());

// Health
app.get("/", (_req, res) => {
  res.send("CuraLink backend is running 🚀");
});

// Apply optional session middleware globally (for routes that need it)
// Apply search limit middleware globally (sets device token cookie for anonymous users)
app.use(optionalSession);
app.use(searchLimitMiddleware);

// TODO: mount routes here (session, profile, search, recommendations, favorites, forums, trials, ai)
app.use("/api", sessionRoutes);
app.use("/api", profileRoutes);
app.use("/api", searchRoutes);
app.use("/api", recommendationsRoutes);
app.use("/api", favoritesRoutes);
app.use("/api", readItemsRoutes);
app.use("/api", forumsRoutes);
app.use("/api", postsRoutes);
app.use("/api", communitiesRoutes);
app.use("/api", trialsRoutes);
app.use("/api", aiRoutes);
app.use("/api", insightsRoutes);
app.use("/api", followRoutes);
app.use("/api", messagesRoutes);
app.use("/api", meetingRequestsRoutes);
app.use("/api", connectionRequestsRoutes);
app.use("/api", adminRoutes);
app.use("/api", waitlistRoutes);

const PORT = process.env.PORT || 5000;

async function start() {
  await connectMongo();
  // Seed forum categories
  const defaults = [
    { slug: "lung-cancer", name: "Lung Cancer" },
    { slug: "heart-related", name: "Heart Related" },
    { slug: "cancer-research", name: "Cancer Research" },
    { slug: "neurology", name: "Neurology" },
    { slug: "oncology", name: "Oncology" },
    { slug: "cardiology", name: "Cardiology" },
    { slug: "clinical-trials", name: "Clinical Trials" },
    { slug: "general-health", name: "General Health" },
  ];
  for (const c of defaults) {
    // upsert by slug
    await ForumCategory.updateOne(
      { slug: c.slug },
      { $setOnInsert: c },
      { upsert: true }
    );
  }

  // Seed default communities
  const defaultCommunities = [
    { name: "General Health", slug: "general-health", description: "Discuss general health topics, wellness tips, and healthy lifestyle choices", icon: "🏥", color: "#2F3C96", tags: ["health", "wellness", "lifestyle", "general"], isOfficial: true },
    { name: "Cancer Support", slug: "cancer-support", description: "A supportive community for cancer patients, survivors, and caregivers", icon: "🎗️", color: "#E91E63", tags: ["cancer", "oncology", "support", "treatment"], isOfficial: true },
    { name: "Mental Health", slug: "mental-health", description: "Open discussions about mental health, coping strategies, and emotional wellbeing", icon: "🧠", color: "#9C27B0", tags: ["mental health", "anxiety", "depression", "therapy", "wellbeing"], isOfficial: true },
    { name: "Diabetes Management", slug: "diabetes-management", description: "Tips, experiences, and support for managing diabetes", icon: "💉", color: "#2196F3", tags: ["diabetes", "blood sugar", "insulin", "diet"], isOfficial: true },
    { name: "Heart Health", slug: "heart-health", description: "Discussions about cardiovascular health, heart conditions, and prevention", icon: "❤️", color: "#F44336", tags: ["heart", "cardiovascular", "blood pressure", "cholesterol"], isOfficial: true },
    { name: "Nutrition & Diet", slug: "nutrition-diet", description: "Share recipes, nutrition tips, and dietary advice", icon: "🥗", color: "#4CAF50", tags: ["nutrition", "diet", "food", "healthy eating"], isOfficial: true },
    { name: "Fitness & Exercise", slug: "fitness-exercise", description: "Workout routines, fitness tips, and exercise motivation", icon: "💪", color: "#FF9800", tags: ["fitness", "exercise", "workout", "strength"], isOfficial: true },
    { name: "Clinical Trials", slug: "clinical-trials", description: "Information and discussions about participating in clinical trials", icon: "🔬", color: "#673AB7", tags: ["clinical trials", "research", "studies", "participation"], isOfficial: true },
    { name: "Chronic Pain", slug: "chronic-pain", description: "Support and management strategies for chronic pain conditions", icon: "🩹", color: "#795548", tags: ["chronic pain", "pain management", "fibromyalgia", "arthritis"], isOfficial: true },
    { name: "Autoimmune Conditions", slug: "autoimmune-conditions", description: "Community for those dealing with autoimmune diseases", icon: "🛡️", color: "#00BCD4", tags: ["autoimmune", "lupus", "rheumatoid", "multiple sclerosis"], isOfficial: true },
  ];
  for (const c of defaultCommunities) {
    await Community.updateOne(
      { slug: c.slug },
      { $setOnInsert: c },
      { upsert: true }
    );
  }

  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

start().catch((err) => {
  console.error("Failed to start server", err);
  process.exit(1);
});
