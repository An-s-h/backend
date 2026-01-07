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
import forumsRoutes from "./routes/forums.routes.js";
import { ForumCategory } from "./models/ForumCategory.js";
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
app.use("/api", forumsRoutes);
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
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

start().catch((err) => {
  console.error("Failed to start server", err);
  process.exit(1);
});
