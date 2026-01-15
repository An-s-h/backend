/**
 * Query parsing utilities for PubMed and Google Scholar style queries
 * Supports field tags, Boolean operators, proximity search, and Google Scholar syntax
 */

/**
 * Parse Google Scholar-style operators and convert to PubMed field tags
 * Examples:
 * - author:"Smith J" -> "Smith J"[AU]
 * - intitle:"cancer" -> "cancer"[TI]
 * - journal:"Nature" -> "Nature"[TA]
 */
export function parseGoogleScholarQuery(query) {
  if (!query || typeof query !== "string") return query;

  // Google Scholar operator patterns
  const patterns = {
    author: /author:["']?([^"'\s]+(?:\s+[^"'\s]+)*)["']?/gi,
    intitle: /intitle:["']?([^"'\s]+(?:\s+[^"'\s]+)*)["']?/gi,
    intext: /intext:["']?([^"'\s]+(?:\s+[^"'\s]+)*)["']?/gi,
    journal: /journal:["']?([^"'\s]+(?:\s+[^"'\s]+)*)["']?/gi,
    site: /site:([^\s]+)/gi, // Not directly supported in PubMed, but we can note it
  };

  let parsedQuery = query;

  // Convert Google Scholar syntax to PubMed syntax
  Object.entries(patterns).forEach(([operator, pattern]) => {
    const fieldMap = {
      author: "[AU]",
      intitle: "[TI]",
      intext: "[TW]",
      journal: "[TA]",
      site: "", // Not supported in PubMed
    };

    parsedQuery = parsedQuery.replace(pattern, (match, term) => {
      const fieldTag = fieldMap[operator];
      if (!fieldTag) return match; // Keep site: as-is (can't convert)

      // Wrap term in quotes if not already quoted and contains spaces
      let formattedTerm = term.trim();
      if (formattedTerm.includes(" ") && !formattedTerm.startsWith('"')) {
        formattedTerm = `"${formattedTerm}"`;
      }

      return `${formattedTerm}${fieldTag}`;
    });
  });

  return parsedQuery;
}

/**
 * Parse minus sign (-) as NOT operator (Google Scholar style)
 * Examples:
 * - cancer -treatment -> cancer NOT treatment
 * - "breast cancer" -metastasis -> "breast cancer" NOT metastasis
 */
export function parseMinusAsNot(query) {
  if (!query || typeof query !== "string") return query;

  let parsedQuery = query;

  // Replace -term with NOT term (but preserve negative numbers and already quoted phrases)
  // Pattern: space followed by minus followed by word or quoted phrase
  parsedQuery = parsedQuery.replace(/\s+-(\w+)/g, " NOT $1");
  parsedQuery = parsedQuery.replace(/\s+-"([^"]+)"/g, ' NOT "$1"');
  parsedQuery = parsedQuery.replace(/\s+-'([^']+)'/g, " NOT '$1'");

  return parsedQuery;
}

/**
 * Check if query already contains date filter [dp] tag
 */
export function hasDateFilter(query) {
  if (!query || typeof query !== "string") return false;
  // Check for [dp] or [DP] tag
  return /\[\s*dp\s*\]/i.test(query);
}

/**
 * Normalize and clean query string
 * - Remove extra spaces
 * - Normalize Boolean operators (and -> AND, or -> OR, not -> NOT)
 * - Ensure proper spacing around operators
 */
export function normalizeQuery(query) {
  if (!query || typeof query !== "string") return query;

  let normalized = query;

  // Normalize Boolean operators (case-insensitive)
  normalized = normalized.replace(/\b(and)\b/gi, "AND");
  normalized = normalized.replace(/\b(or)\b/gi, "OR");
  normalized = normalized.replace(/\b(not)\b/gi, "NOT");

  // Ensure proper spacing around operators (but preserve within quotes)
  normalized = normalized.replace(/\s*(\bAND\b|\bOR\b|\bNOT\b)\s*/gi, " $1 ");

  // Remove extra spaces
  normalized = normalized.replace(/\s+/g, " ").trim();

  return normalized;
}

/**
 * Main query parser that applies all transformations
 * Order matters: Google Scholar -> Minus as NOT -> Normalize
 */
export function parseQuery(query) {
  if (!query || typeof query !== "string") return query;

  let parsed = query;

  // Step 1: Parse Google Scholar operators
  parsed = parseGoogleScholarQuery(parsed);

  // Step 2: Parse minus sign as NOT
  parsed = parseMinusAsNot(parsed);

  // Step 3: Normalize query
  parsed = normalizeQuery(parsed);

  return parsed;
}

/**
 * Extract date range from query if it contains [dp] tag
 * Returns { mindate, maxdate } or null
 */
export function extractDateRangeFromQuery(query) {
  if (!query || typeof query !== "string") return null;

  // Pattern: YYYY/MM/DD:YYYY/MM/DD[dp] or YYYY/MM:YYYY/MM[dp]
  const datePattern = /(\d{4}\/\d{1,2}(?:\/\d{1,2})?):(\d{4}\/\d{1,2}(?:\/\d{1,2})?)\[dp\]/i;
  const match = query.match(datePattern);

  if (match) {
    const [, startDate, endDate] = match;
    return {
      mindate: startDate,
      maxdate: endDate,
    };
  }

  return null;
}

/**
 * Remove date filter from query if it exists
 * Useful when we want to handle dates separately
 */
export function removeDateFilterFromQuery(query) {
  if (!query || typeof query !== "string") return query;

  // Remove date range pattern: YYYY/MM/DD:YYYY/MM/DD[dp]
  let cleaned = query.replace(
    /\d{4}\/\d{1,2}(?:\/\d{1,2})?:\d{4}\/\d{1,2}(?:\/\d{1,2})?\[dp\]/gi,
    ""
  );

  // Clean up resulting AND/OR operators that might be orphaned
  cleaned = cleaned.replace(/\s*(AND|OR)\s*\(?\s*(AND|OR)\s*/gi, " $1 ");
  cleaned = cleaned.replace(/\s*\(?\s*(AND|OR)\s*\)?\s*$/gi, "");
  cleaned = cleaned.replace(/^\s*\(?\s*(AND|OR)\s*\)?\s*/gi, "");

  // Remove extra spaces
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  return cleaned;
}

