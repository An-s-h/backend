import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const API_URL = process.env.API_URL || "http://localhost:5000";

async function verifyAllTopics() {
  console.log("🔍 Verifying all Conditions & Topics...\n");
  console.log(`📍 API URL: ${API_URL}\n`);

  try {
    // Get all communities
    const response = await axios.get(`${API_URL}/api/communities`);
    const communities = response.data.communities;

    console.log(`Found ${communities.length} communities\n`);
    console.log("=".repeat(70));

    let totalTopics = 0;
    let communitiesWithTopics = 0;
    let communitiesWithoutTopics = [];

    for (const community of communities) {
      try {
        const subRes = await axios.get(
          `${API_URL}/api/communities/${community._id}/subcategories`
        );
        const count = subRes.data.subcategories?.length || 0;
        totalTopics += count;

        if (count > 0) {
          communitiesWithTopics++;
          const names = subRes.data.subcategories
            .slice(0, 3)
            .map((s) => s.name)
            .join(", ");
          console.log(
            `✅ ${community.name.padEnd(30)} (${community.slug.padEnd(25)}) ${count.toString().padStart(2)} topics`
          );
          console.log(`   Sample: ${names}${count > 3 ? "..." : ""}`);
        } else {
          communitiesWithoutTopics.push(community);
          console.log(
            `⚠️  ${community.name.padEnd(30)} (${community.slug.padEnd(25)}) ${count.toString().padStart(2)} topics`
          );
        }
      } catch (error) {
        console.log(
          `❌ ${community.name.padEnd(30)} (${community.slug.padEnd(25)}) Error: ${error.message}`
        );
        communitiesWithoutTopics.push(community);
      }
      console.log();
    }

    console.log("=".repeat(70));
    console.log("\n📊 SUMMARY");
    console.log("=".repeat(70));
    console.log(`Total Communities: ${communities.length}`);
    console.log(`Communities with Conditions & Topics: ${communitiesWithTopics}`);
    console.log(`Communities without Conditions & Topics: ${communitiesWithoutTopics.length}`);
    console.log(`Total Conditions & Topics: ${totalTopics}`);

    if (communitiesWithoutTopics.length > 0) {
      console.log("\n⚠️  Communities needing seed data:");
      communitiesWithoutTopics.forEach((c) => {
        console.log(`   - ${c.name} (slug: ${c.slug})`);
      });
      console.log(
        "\n💡 Run: node scripts/fix-missing-topics.js to seed missing communities"
      );
    } else {
      console.log("\n✨ All communities have Conditions & Topics!");
    }
  } catch (error) {
    console.error("❌ Error:", error.message);
    if (error.response) {
      console.error("   Response:", error.response.data);
    }
    process.exit(1);
  }
}

verifyAllTopics();

