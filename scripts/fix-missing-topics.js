import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const API_URL = process.env.API_URL || "http://localhost:5000";

async function fixMissingTopics() {
  console.log("🔧 Fixing missing Conditions & Topics...\n");

  try {
    // Get all communities
    const response = await axios.get(`${API_URL}/api/communities`);
    const communities = response.data.communities;

    // Find communities that need fixing
    const heartRelated = communities.find((c) => c.slug === "heart-related");
    const lungCancer = communities.find((c) => c.slug === "lung-cancer");

    if (heartRelated) {
      console.log(`📋 Found Heart Health (heart-related): ${heartRelated._id}`);
      const seedRes = await axios.post(
        `${API_URL}/api/communities/${heartRelated._id}/subcategories/seed`,
        {}
      );
      console.log(`   ✅ ${seedRes.data.message}\n`);
    }

    if (lungCancer) {
      console.log(`📋 Found Lung Cancer: ${lungCancer._id}`);
      const seedRes = await axios.post(
        `${API_URL}/api/communities/${lungCancer._id}/subcategories/seed`,
        {}
      );
      console.log(`   ✅ ${seedRes.data.message}\n`);
    }

    // Verify all communities now have Conditions & Topics
    console.log("🔍 Verifying all communities...\n");
    for (const community of communities) {
      const subRes = await axios.get(
        `${API_URL}/api/communities/${community._id}/subcategories`
      );
      const count = subRes.data.subcategories?.length || 0;
      const status = count > 0 ? "✅" : "⚠️";
      console.log(
        `   ${status} ${community.name} (${community.slug}): ${count} Conditions & Topics`
      );
    }
  } catch (error) {
    console.error("❌ Error:", error.message);
    if (error.response) {
      console.error("   Response:", error.response.data);
    }
  }
}

fixMissingTopics();

