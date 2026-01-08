/**
 * Script to set all existing users to emailVerified: false
 * This includes both regular users and Auth0 users
 *
 * Run with: node server/scripts/setUsersUnverified.js
 * Or from server directory: node scripts/setUsersUnverified.js
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { connectMongo } from "../config/mongo.js";
import { User } from "../models/User.js";

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env file from server directory (parent of scripts directory)
const envPath = join(__dirname, "..", ".env");
dotenv.config({ path: envPath });

// Also try loading from root directory (in case .env is there)
const rootEnvPath = join(__dirname, "..", "..", ".env");
dotenv.config({ path: rootEnvPath, override: false });

// Log which env file was loaded (for debugging)
if (process.env.MONGO_URI) {
  console.log("✅ Environment variables loaded successfully");
} else {
  console.error("❌ MONGO_URI not found. Please check your .env file.");
  console.error(`   Tried loading from: ${envPath}`);
  console.error(`   Tried loading from: ${rootEnvPath}`);
  console.error("\n   Make sure your .env file contains:");
  console.error("   MONGO_URI=mongodb://...");
  process.exit(1);
}

async function setUsersUnverified() {
  try {
    console.log("Connecting to MongoDB...");
    await connectMongo();
    console.log("Connected to MongoDB");

    // Update all users to set emailVerified to false
    const result = await User.updateMany(
      {},
      { $set: { emailVerified: false } }
    );

    console.log(
      `\n✅ Successfully updated ${result.modifiedCount} users to unverified status`
    );
    console.log(`   Total users matched: ${result.matchedCount}`);

    // Count users by type
    const totalUsers = await User.countDocuments({});
    const oauthUsers = await User.countDocuments({ isOAuthUser: true });
    const regularUsers = totalUsers - oauthUsers;

    console.log(`\n📊 User Statistics:`);
    console.log(`   Total users: ${totalUsers}`);
    console.log(`   OAuth users: ${oauthUsers}`);
    console.log(`   Regular users: ${regularUsers}`);

    process.exit(0);
  } catch (error) {
    console.error("❌ Error setting users to unverified:", error);
    process.exit(1);
  }
}

setUsersUnverified();
