import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const API_URL = process.env.API_URL || "http://localhost:5000";

async function seedCommunities() {
  console.log("🌱 Seeding communities...");
  try {
    const response = await axios.post(`${API_URL}/api/communities/seed`, {});
    const data = response.data;
    console.log(`✅ ${data.message}`);
    if (data.communities && data.communities.length > 0) {
      console.log(`   Created ${data.communities.length} communities`);
    }
    return true;
  } catch (error) {
    if (error.response) {
      console.error(`❌ Error: ${error.response.data?.error || "Unknown error"}`);
    } else {
      console.error(`❌ Failed to seed communities:`, error.message);
    }
    return false;
  }
}

async function getAllCommunities() {
  console.log("\n📋 Fetching all communities...");
  try {
    const response = await axios.get(`${API_URL}/api/communities`);
    const data = response.data;
    console.log(`✅ Found ${data.communities.length} communities`);
    return data.communities;
  } catch (error) {
    if (error.response) {
      console.error(`❌ Error fetching communities: ${error.response.data?.error}`);
    } else {
      console.error(`❌ Failed to fetch communities:`, error.message);
    }
    return [];
  }
}

async function seedConditionsAndTopics(communityId, communityName) {
  try {
    const response = await axios.post(
      `${API_URL}/api/communities/${communityId}/subcategories/seed`,
      {}
    );
    const data = response.data;
    console.log(
      `   ✅ ${communityName}: ${data.message} (${data.subcategories?.length || 0} Conditions & Topics)`
    );
    return { success: true, count: data.subcategories?.length || 0 };
  } catch (error) {
    if (error.response) {
      const errorMsg = error.response.data?.error || error.response.data?.message || "Unknown error";
      console.log(`   ⚠️  ${communityName}: ${errorMsg}`);
      return { success: false, error: errorMsg };
    } else {
      console.log(`   ❌ ${communityName}: Failed - ${error.message}`);
      return { success: false, error: error.message };
    }
  }
}

async function verifyConditionsAndTopics(communityId, communityName) {
  try {
    const response = await axios.get(
      `${API_URL}/api/communities/${communityId}/subcategories`
    );
    const data = response.data;
    const count = data.subcategories?.length || 0;
    if (count > 0) {
      console.log(
        `   ✅ ${communityName}: Verified ${count} Conditions & Topics`
      );
      // Show first few names
      const names = data.subcategories
        .slice(0, 3)
        .map((s) => s.name)
        .join(", ");
      console.log(`      Sample: ${names}${count > 3 ? "..." : ""}`);
    } else {
      console.log(`   ⚠️  ${communityName}: No Conditions & Topics found`);
    }
    return count;
  } catch (error) {
    if (error.response) {
      console.log(`   ❌ ${communityName}: Failed to verify - ${error.response.data?.error || "Unknown error"}`);
    } else {
      console.log(`   ❌ ${communityName}: Verification error - ${error.message}`);
    }
    return 0;
  }
}

async function main() {
  console.log("🚀 Starting seed process...\n");
  console.log(`📍 API URL: ${API_URL}\n`);

  // Step 1: Seed communities
  const communitiesSeeded = await seedCommunities();
  if (!communitiesSeeded) {
    console.log("\n⚠️  Communities seeding had issues, but continuing...");
  }

  // Step 2: Get all communities
  const communities = await getAllCommunities();
  if (communities.length === 0) {
    console.log("\n❌ No communities found. Exiting.");
    process.exit(1);
  }

  // Step 3: Seed Conditions & Topics for each community
  console.log("\n🌱 Seeding Conditions & Topics for each community...");
  const results = [];
  for (const community of communities) {
    const result = await seedConditionsAndTopics(
      community._id,
      community.name
    );
    results.push({
      community: community.name,
      ...result,
    });
    // Small delay to avoid overwhelming the server
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Step 4: Verify all Conditions & Topics
  console.log("\n🔍 Verifying Conditions & Topics...");
  const verificationResults = [];
  for (const community of communities) {
    const count = await verifyConditionsAndTopics(community._id, community.name);
    verificationResults.push({
      community: community.name,
      count,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("📊 SUMMARY");
  console.log("=".repeat(60));
  
  const successful = results.filter((r) => r.success).length;
  const total = results.length;
  console.log(`\n✅ Successfully seeded: ${successful}/${total} communities`);
  
  const totalConditions = verificationResults.reduce(
    (sum, r) => sum + r.count,
    0
  );
  console.log(`📋 Total Conditions & Topics created: ${totalConditions}`);
  
  console.log("\n📝 Breakdown by community:");
  verificationResults.forEach((r) => {
    console.log(`   ${r.community}: ${r.count} Conditions & Topics`);
  });

  console.log("\n✨ Seed process completed!");
}

main().catch((error) => {
  console.error("\n❌ Fatal error:", error);
  process.exit(1);
});

