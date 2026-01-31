import axios from "axios";

/**
 * Fetch page HTML and extract metadata via regex (no jsdom).
 * Used by admin only for ResearchGate/Academia.edu.
 * Returns name, description, and for Academia.edu: institution, paperCount, followersCount, followingCount, coAuthorsCount.
 * @param {string} url - Full URL
 * @returns {Promise<{ name: string|null, description: string|null, institution?: string|null, paperCount?: number|null, followersCount?: number|null, followingCount?: number|null, coAuthorsCount?: number|null }>}
 */
export async function fetchPageMetadata(url) {
  const result = {
    name: null,
    description: null,
    institution: null,
    paperCount: null,
    followersCount: null,
    followingCount: null,
    coAuthorsCount: null,
  };
  if (!url || typeof url !== "string") return result;
  try {
    const res = await axios.get(url.trim(), {
      timeout: 10000,
      maxRedirects: 5,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      validateStatus: () => true,
    });

    if (res.status !== 200) return result;

    const html = res.data;
    if (!html || typeof html !== "string") return result;

    // og:title
    const ogTitleMatch =
      html.match(/<meta[^>]*property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']*)["']/i) ||
      html.match(/<meta[^>]*content\s*=\s*["']([^"']*)["'][^>]*property\s*=\s*["']og:title["']/i);
    if (ogTitleMatch) {
      const fullTitle = decodeHtmlEntities(ogTitleMatch[1].trim());
      result.name = fullTitle || null;
      // Academia.edu often: "Name - Institution, Department, Role"
      if (fullTitle && fullTitle.includes(" - ")) {
        const parts = fullTitle.split(" - ").map((s) => s.trim());
        result.name = parts[0] || result.name;
        result.institution = parts[1] || null;
      }
    }

    // og:description
    const ogDescMatch =
      html.match(/<meta[^>]*property\s*=\s*["']og:description["'][^>]*content\s*=\s*["']([^"']*)["']/i) ||
      html.match(/<meta[^>]*content\s*=\s*["']([^"']*)["'][^>]*property\s*=\s*["']og:description["']/i);
    if (ogDescMatch) result.description = decodeHtmlEntities(ogDescMatch[1].trim()) || null;

    // fallback: <title>
    if (!result.name) {
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (titleMatch) {
        const t = decodeHtmlEntities(titleMatch[1].trim());
        result.name = t || null;
        if (t && t.includes(" - ")) {
          const parts = t.split(" - ").map((s) => s.trim());
          result.name = parts[0] || result.name;
          result.institution = parts[1] || null;
        }
      }
    }

    const isAcademia = /academia\.edu/i.test(url);
    const isResearchGate = /researchgate\.net/i.test(url);

    // Academia.edu — extract contribution stats from page text
    if (isAcademia) {
      const papersMatch = html.match(/(\d[\d,]*)\s*Papers?\b/i) || html.match(/\bPapers?\s*[\(\[]?\s*(\d[\d,]*)/i);
      if (papersMatch) result.paperCount = parseInt(papersMatch[1].replace(/,/g, ""), 10) || null;
      const followersMatch = html.match(/(\d[\d,]*)\s*Followers?/i);
      if (followersMatch) result.followersCount = parseInt(followersMatch[1].replace(/,/g, ""), 10) || null;
      const followingMatch = html.match(/(\d[\d,]*)\s*Following\b/i);
      if (followingMatch) result.followingCount = parseInt(followingMatch[1].replace(/,/g, ""), 10) || null;
      const coAuthorsMatch = html.match(/(\d[\d,]*)\s*Co-authors?/i);
      if (coAuthorsMatch) result.coAuthorsCount = parseInt(coAuthorsMatch[1].replace(/,/g, ""), 10) || null;
    }

    // ResearchGate — extract name/institution from title; stats if present
    if (isResearchGate && result.name && result.name.includes(" - ")) {
      const parts = result.name.split(" - ").map((s) => s.trim());
      result.name = parts[0] || result.name;
      result.institution = parts[1] || null;
    }
    if (isResearchGate) {
      const papersMatch = html.match(/(\d[\d,]*)\s*Publications?\b/i) || html.match(/(\d[\d,]*)\s*Papers?\b/i);
      if (papersMatch) result.paperCount = parseInt(papersMatch[1].replace(/,/g, ""), 10) || null;
      const followersMatch = html.match(/(\d[\d,]*)\s*Followers?/i);
      if (followersMatch) result.followersCount = parseInt(followersMatch[1].replace(/,/g, ""), 10) || null;
    }

    return result;
  } catch (err) {
    console.error("adminPageMetadata fetch error:", err.message);
    return result;
  }
}

function decodeHtmlEntities(str) {
  if (!str || typeof str !== "string") return str;
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}
