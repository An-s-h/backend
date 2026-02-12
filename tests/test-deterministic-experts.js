/**
 * Test script for Deterministic Expert Discovery
 * 
 * This script demonstrates how to use the new deterministic expert discovery system
 * and compares it with the old Gemini-first approach.
 * 
 * Usage:
 *   node tests/test-deterministic-experts.js
 */

import axios from "axios";

const BASE_URL = "http://localhost:5000/api";

// Test cases covering various scenarios
const testCases = [
  {
    name: "Parkinson's Disease - Toronto",
    query: "Parkinson's Disease",
    location: "Toronto, Canada",
    limit: 5,
  },
  {
    name: "Deep Brain Stimulation - Global",
    query: "deep brain stimulation",
    location: null,
    limit: 5,
  },
  {
    name: "Multiple Sclerosis - United States",
    query: "Multiple Sclerosis",
    location: "United States",
    limit: 5,
  },
  {
    name: "Alzheimer's Disease - Germany",
    query: "Alzheimer's Disease",
    location: "Germany",
    limit: 5,
  },
];

/**
 * Test the deterministic expert discovery endpoint
 */
async function testDeterministicExpertDiscovery(testCase) {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`📊 Testing: ${testCase.name}`);
  console.log(`${"=".repeat(80)}\n`);

  const startTime = Date.now();

  try {
    const params = {
      q: testCase.query,
      limit: testCase.limit,
    };

    if (testCase.location) {
      params.location = testCase.location;
    }

    const response = await axios.get(`${BASE_URL}/search/experts/deterministic`, {
      params,
      headers: {
        // Add a testing header to bypass rate limits (for development only)
        'X-Testing': 'true',
      },
      timeout: 30000, // 30 second timeout
    });

    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);

    console.log(`✅ Success! Response time: ${duration}s\n`);
    console.log(`📈 Results Summary:`);
    console.log(`   Total found: ${response.data.totalFound}`);
    console.log(`   Method: ${response.data.method}`);
    console.log(`   Results count: ${response.data.results.length}\n`);

    // Display each expert
    response.data.results.forEach((expert, index) => {
      console.log(`${index + 1}. ${expert.name}`);
      console.log(`   Affiliation: ${expert.affiliation || "N/A"}`);
      console.log(`   Location: ${expert.location || "N/A"}`);
      console.log(`   Confidence: ${expert.confidence.toUpperCase()}`);
      console.log(`   Metrics:`);
      console.log(`     - Publications: ${expert.metrics.totalPublications}`);
      console.log(`     - Citations: ${expert.metrics.totalCitations}`);
      console.log(`     - Recent publications (2y): ${expert.metrics.recentPublications}`);
      console.log(`     - h-index: ${expert.metrics.hIndex || "N/A"}`);
      console.log(`     - Field relevance: ${expert.metrics.fieldRelevance}%`);
      console.log(`   Verification:`);
      console.log(`     - Verified: ${expert.verification.verified ? "✓" : "✗"}`);
      console.log(`     - Overlapping DOIs: ${expert.verification.overlappingDOIs}`);
      console.log(`   Scores:`);
      console.log(
        `     - Recency: ${(expert.scores.recency * 100).toFixed(0)}%`
      );
      console.log(
        `     - Citations: ${(expert.scores.citations * 100).toFixed(0)}%`
      );
      console.log(
        `     - Last Author: ${(expert.scores.lastAuthor * 100).toFixed(0)}%`
      );
      console.log(
        `     - Field Relevance: ${(expert.scores.fieldRelevance * 100).toFixed(0)}%`
      );
      console.log(
        `     - FINAL SCORE: ${(expert.scores.final * 100).toFixed(0)}%`
      );
      
      if (expert.biography) {
        console.log(`   Biography: ${expert.biography.substring(0, 150)}...`);
      }
      
      if (expert.recentWorks && expert.recentWorks.length > 0) {
        console.log(`   Recent Works:`);
        expert.recentWorks.slice(0, 2).forEach((work) => {
          console.log(`     - [${work.year}] ${work.title.substring(0, 80)}... (${work.citations} citations)`);
        });
      }
      
      console.log("");
    });

    // Analyze confidence distribution
    const confidenceCounts = {
      high: 0,
      medium: 0,
      low: 0,
    };

    response.data.results.forEach((expert) => {
      confidenceCounts[expert.confidence]++;
    });

    console.log(`📊 Confidence Distribution:`);
    console.log(`   High: ${confidenceCounts.high}`);
    console.log(`   Medium: ${confidenceCounts.medium}`);
    console.log(`   Low: ${confidenceCounts.low}`);

    return {
      success: true,
      duration,
      results: response.data.results,
    };
  } catch (error) {
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);

    console.error(`❌ Error! Response time: ${duration}s\n`);
    
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Error: ${error.response.data.error}`);
      if (error.response.data.details) {
        console.error(`   Details: ${error.response.data.details}`);
      }
    } else {
      console.error(`   Message: ${error.message}`);
    }

    return {
      success: false,
      duration,
      error: error.message,
    };
  }
}

/**
 * Compare deterministic approach with old Gemini-first approach
 */
async function compareApproaches(testCase) {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`🔬 Comparing Approaches: ${testCase.name}`);
  console.log(`${"=".repeat(80)}\n`);

  // Test deterministic approach
  console.log("Testing DETERMINISTIC approach...");
  const deterministicResult = await testDeterministicExpertDiscovery(testCase);

  // Wait a bit to avoid rate limits
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Test old approach (if available)
  console.log("\nTesting OLD (Gemini-first) approach...");
  const oldStartTime = Date.now();
  
  try {
    const query = testCase.location
      ? `${testCase.query} in ${testCase.location}`
      : testCase.query;

    const response = await axios.get(`${BASE_URL}/search/experts`, {
      params: { q: query },
      headers: {
        'X-Testing': 'true',
      },
      timeout: 30000,
    });

    const oldEndTime = Date.now();
    const oldDuration = ((oldEndTime - oldStartTime) / 1000).toFixed(2);

    console.log(`✅ Success! Response time: ${oldDuration}s`);
    console.log(`   Results: ${response.data.results.length}\n`);

    // Compare results
    console.log(`\n📊 Comparison Summary:`);
    console.log(`   Deterministic: ${deterministicResult.duration}s, ${deterministicResult.results?.length || 0} results`);
    console.log(`   Old (Gemini):  ${oldDuration}s, ${response.data.results.length} results`);

    // Check for name overlaps
    if (deterministicResult.results && response.data.results) {
      const detNames = new Set(
        deterministicResult.results.map((r) => r.name.toLowerCase())
      );
      const oldNames = new Set(
        response.data.results.map((r) => r.name.toLowerCase())
      );

      let overlap = 0;
      for (const name of detNames) {
        if (oldNames.has(name)) {
          overlap++;
        }
      }

      console.log(
        `   Name overlap: ${overlap}/${Math.min(detNames.size, oldNames.size)} (${((overlap / Math.min(detNames.size, oldNames.size)) * 100).toFixed(0)}%)`
      );
    }
  } catch (error) {
    console.error(`❌ Old approach failed: ${error.message}`);
  }
}

/**
 * Run all tests
 */
async function runAllTests() {
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║                                                                               ║
║            DETERMINISTIC EXPERT DISCOVERY - TEST SUITE                        ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);

  console.log("This test suite will:");
  console.log("  1. Test the new deterministic expert discovery endpoint");
  console.log("  2. Display detailed results for each expert");
  console.log("  3. Show confidence distribution");
  console.log("  4. Compare with the old Gemini-first approach\n");

  console.log(`Running ${testCases.length} test cases...\n`);

  const results = [];

  // Run individual tests
  for (const testCase of testCases) {
    const result = await testDeterministicExpertDiscovery(testCase);
    results.push({ testCase, result });

    // Wait between tests to avoid rate limits
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  // Run comparison test (only first test case to save time)
  console.log("\n\n");
  await compareApproaches(testCases[0]);

  // Summary
  console.log(`\n\n${"=".repeat(80)}`);
  console.log(`📊 TEST SUITE SUMMARY`);
  console.log(`${"=".repeat(80)}\n`);

  const successful = results.filter((r) => r.result.success).length;
  const failed = results.filter((r) => !r.result.success).length;

  console.log(`Total tests: ${results.length}`);
  console.log(`Successful: ${successful} ✅`);
  console.log(`Failed: ${failed} ${failed > 0 ? "❌" : ""}`);

  if (successful > 0) {
    const avgDuration =
      results
        .filter((r) => r.result.success)
        .reduce((sum, r) => sum + parseFloat(r.result.duration), 0) /
      successful;
    console.log(`Average response time: ${avgDuration.toFixed(2)}s`);

    const totalExperts = results
      .filter((r) => r.result.success)
      .reduce((sum, r) => sum + (r.result.results?.length || 0), 0);
    console.log(`Total experts found: ${totalExperts}`);
  }

  console.log("\n✨ Test suite complete!\n");
}

// Run the tests
runAllTests().catch((error) => {
  console.error("Fatal error running test suite:", error);
  process.exit(1);
});
