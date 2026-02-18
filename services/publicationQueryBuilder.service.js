/**
 * Publication Query Builder – Concept + Intent Aware
 * Layer 1: Intent detection, concept extraction, AND across concepts / OR within concepts, field targeting [TIAB]/[MH].
 */

import { mapToMeSHTerminology } from "./medicalTerminology.service.js";
import { expandQueryWithSynonyms } from "./medicalTerminology.service.js";

const RECENT_TERMS = /\b(latest|recent|new|updated|emerging|202[0-9]|20[3-9][0-9])\b/i;
const TREATMENT_TERMS = /\b(treatment|therapy|therapeutic|management|drug|medication|intervention)\b/i;
const TRIAL_TERMS = /\b(trial|randomized|rct|placebo|phase\s+[i\d]+|clinical\s+trial)\b/i;

const MODIFIER_TERMS = /\b(pediatric|adult|elderly|children|geriatric|latest|recent|new)\b/gi;

/**
 * Detect user intent flags from raw query.
 * @param {string} rawQuery
 * @returns {{ wantsRecent: boolean, wantsTreatment: boolean, wantsTrial: boolean }}
 */
export function detectIntent(rawQuery = "") {
  const q = (rawQuery || "").trim();
  return {
    wantsRecent: RECENT_TERMS.test(q),
    wantsTreatment: TREATMENT_TERMS.test(q),
    wantsTrial: TRIAL_TERMS.test(q),
  };
}

/**
 * Extract core concepts: condition/disease, intervention (if present), modifiers.
 * Simple extraction: condition is the main topic; treatment/trial terms indicate intervention intent.
 * @param {string} rawQuery
 * @returns {{ conditionConcept: string[], interventionConcept: string[] | null, modifiers: string[] }}
 */
export function extractConcepts(rawQuery = "") {
  let q = (rawQuery || "").trim();
  const modifiers = [];
  let m;
  const modRe = new RegExp(MODIFIER_TERMS.source, "gi");
  while ((m = modRe.exec(q)) !== null) {
    modifiers.push(m[0].toLowerCase());
  }
  q = q.replace(modRe, " ").replace(/\s+/g, " ").trim();

  const conditionTokens = q
    .split(/\s+/)
    .filter(
      (t) =>
        t.length >= 2 &&
        !/^(treatment|therapy|therapeutic|management|drug|medication|trial|randomized|rct|placebo|phase|clinical|in|for|on|about|and|or)$/i.test(
          t
        )
    );
  const conditionConcept = conditionTokens.length
    ? [conditionTokens.join(" ")]
    : [];

  let interventionConcept = null;
  if (TREATMENT_TERMS.test(rawQuery)) {
    interventionConcept = [
      '"drug therapy"[sh]',
      "therapy[tiab]",
      "treatment[tiab]",
      "therapeutics[mh]",
    ];
  }
  if (TRIAL_TERMS.test(rawQuery)) {
    const trialTerms = [
      "randomized controlled trial[pt]",
      "clinical trial[pt]",
      "placebo[tiab]",
      "RCT[tiab]",
    ];
    interventionConcept = interventionConcept
      ? [...interventionConcept, ...trialTerms]
      : trialTerms;
  }

  return { conditionConcept, interventionConcept, modifiers };
}

/**
 * Build one concept clause: OR expansion within concept, with [tiab] and [mh] targeting.
 * @param {string[]} terms - e.g. ["ADHD"] or ["treatment", "therapy"]
 * @param {boolean} useMeSH - include MeSH mapping
 * @returns {string} - e.g. (ADHD[tiab] OR "attention deficit hyperactivity disorder"[tiab] OR ...)
 */
function buildConceptClause(terms, useMeSH = true) {
  if (!terms || terms.length === 0) return "";

  const parts = [];
  for (const t of terms) {
    const trimmed = t.trim();
    if (!trimmed) continue;
    parts.push(`(${trimmed}[tiab])`);
    if (useMeSH) {
      const mesh = mapToMeSHTerminology(trimmed);
      if (mesh !== trimmed) parts.push(`(${mesh}[mh])`);
    }
  }
  const synonymExpanded = expandQueryWithSynonyms(terms.join(" "));
  if (synonymExpanded && synonymExpanded !== terms.join(" ")) {
    const synTerms = synonymExpanded.split(/\s+OR\s+/).map((s) => s.trim());
    for (const s of synTerms) {
      if (s && !parts.some((p) => p.includes(s))) {
        const quoted = s.includes(" ") ? `"${s}"` : s;
        parts.push(`(${quoted}[tiab])`);
      }
    }
  }
  return parts.length ? `(${parts.join(" OR ")})` : "";
}

/**
 * Build full PubMed query: AND across concepts, OR within concepts. Prefer [TIAB] and [MH].
 * @param {string} rawQuery
 * @returns {{ pubmedQuery: string, intent: { wantsRecent: boolean, wantsTreatment: boolean, wantsTrial: boolean }, queryTerms: string[], rawQueryLower: string, hasFieldTags: boolean }}
 */
export function buildConceptAwareQuery(rawQuery = "") {
  const hasFieldTags = /\[[A-Za-z]{2,}\]/.test(rawQuery || "");
  if (hasFieldTags || !rawQuery || !rawQuery.trim()) {
    return {
      pubmedQuery: rawQuery || "",
      intent: detectIntent(rawQuery),
      queryTerms: rawQuery
        ? rawQuery
            .toLowerCase()
            .replace(/[^\w\s-]/g, " ")
            .split(/\s+/)
            .filter((t) => t.length > 2)
        : [],
      rawQueryLower: (rawQuery || "").toLowerCase().trim(),
      hasFieldTags: true,
    };
  }

  const intent = detectIntent(rawQuery);
  const { conditionConcept, interventionConcept } = extractConcepts(rawQuery);

  const conceptA = buildConceptClause(conditionConcept, true);
  const conceptB = interventionConcept
    ? `(${interventionConcept.join(" OR ")})`
    : "";

  let pubmedQuery;
  if (conceptA && conceptB) {
    pubmedQuery = `${conceptA} AND ${conceptB}`;
  } else if (conceptA) {
    pubmedQuery = conceptA;
  } else {
    pubmedQuery = rawQuery.replace(/\s+/g, " ").trim();
  }

  const queryTerms = rawQuery
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);

  // Core concept terms (condition) for filtering and relevance: include each token so "diabetes" matches
  // even when the full phrase is "publications diabetes" (don't require "latest"/"publications" in papers)
  const conditionTokens = conditionConcept.join(" ")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  const coreConceptTerms = [...new Set([...conditionConcept, ...conditionTokens])];
  const synExp = expandQueryWithSynonyms(conditionConcept.join(" "));
  if (synExp && synExp !== conditionConcept.join(" ")) {
    synExp.split(/\s+OR\s+/).forEach((s) => {
      const t = s.trim();
      if (t && !coreConceptTerms.includes(t)) coreConceptTerms.push(t);
    });
  }

  return {
    pubmedQuery,
    intent,
    queryTerms,
    rawQueryLower: rawQuery.toLowerCase().trim(),
    hasFieldTags: false,
    coreConceptTerms,
  };
}
