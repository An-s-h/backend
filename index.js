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
import { ForumCategory } from "./models/ForumCategory.js";
import { Community } from "./models/Community.js";

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
app.use(express.json({ limit: "10mb" })); // Limit request body size

// Request timeout middleware (30 seconds)
app.use((req, res, next) => {
  req.setTimeout(30000, () => {
    if (!res.headersSent) {
      res.status(408).json({ error: "Request timeout" });
    }
  });
  next();
});

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

// Global error handlers - CRITICAL for AWS deployments
// Handle unhandled promise rejections (common cause of crashes)
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  // Don't exit in production, just log the error
  // The server should continue running
});

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  // Log and attempt graceful shutdown
  process.exit(1);
});

// Handle SIGTERM (AWS/PM2 shutdown signal)
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully");
  process.exit(0);
});

// Handle SIGINT (Ctrl+C)
process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down gracefully");
  process.exit(0);
});

async function start() {
  try {
    await connectMongo();
    
    // Seed forum categories with error handling
    try {
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
        try {
          await ForumCategory.updateOne(
            { slug: c.slug },
            { $setOnInsert: c },
            { upsert: true }
          );
        } catch (error) {
          console.error(`Error seeding forum category ${c.slug}:`, error.message);
          // Continue with other categories
        }
      }
    } catch (error) {
      console.error("Error seeding forum categories:", error.message);
      // Don't fail server startup if seeding fails
    }

    // Seed default communities with error handling
    try {
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
        try {
          await Community.updateOne(
            { slug: c.slug },
            { $setOnInsert: c },
            { upsert: true }
          );
        } catch (error) {
          console.error(`Error seeding community ${c.slug}:`, error.message);
          // Continue with other communities
        }
      }
    } catch (error) {
      console.error("Error seeding communities:", error.message);
      // Don't fail server startup if seeding fails
    }

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    // Give time for logs to flush before exiting
    setTimeout(() => process.exit(1), 1000);
  }
}

start().catch((err) => {
  console.error("Failed to start server", err);
  setTimeout(() => process.exit(1), 1000);
});
