/**
 * Publication Query Builder – Concept + Intent Aware
 * Layer 1: Intent detection, concept extraction, AND across concepts / OR within concepts, field targeting [TIAB]/[MH].
 */

import { mapToMeSHTerminology } from "./medicalTerminology.service.js";
import { expandQueryWithSynonyms } from "./medicalTerminology.service.js";
import {
  EXPOSURE_FAMILIES,
  EXPOSURE_PHRASES,
  PROTECTED_EXPOSURE_TOKENS,
} from "./exposureConcepts.config.js";

const RECENT_TERMS =
  /\b(latest|recent|new|updated|emerging|202[0-9]|20[3-9][0-9])\b/i;
const TREATMENT_TERMS =
  /\b(treatment|therapy|therapeutic|management|drug|medication|intervention)\b/i;
const TRIAL_TERMS =
  /\b(trial|randomized|rct|placebo|phase\s+[i\d]+|clinical\s+trial)\b/i;

const MODIFIER_TERMS =
  /\b(pediatric|adult|elderly|children|geriatric|latest|recent|new)\b/gi;

const MEDICAL_STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "its",
  "it",
  "as",
  "from",
  "that",
  "this",
  "than",
  "into",
  "not",
  "no",
  "about",
  "around",
  "within",
  "between",
  "across",
]);

function isProtectedExposureToken(token = "") {
  if (!token) return false;
  const t = token.toLowerCase();
  if (PROTECTED_EXPOSURE_TOKENS.has(t)) return true;
  return (
    t.startsWith("mold") ||
    t.startsWith("mould") ||
    t.startsWith("mycotoxin") ||
    t === "fungal" ||
    t === "fungus"
  );
}

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
  const v2 = extractConceptsV2(rawQuery);
  const conditionConcept = v2.coreConcepts.length
    ? [v2.coreConcepts.join(" ")]
    : [];
  const interventionConcept = v2.interventionConcept;
  const modifiers = v2.modifiers || [];
  return { conditionConcept, interventionConcept, modifiers };
}

export function extractConceptsV2(rawQuery = "") {
  let q = (rawQuery || "").trim();
  const modifiers = [];
  let m;
  const modRe = new RegExp(MODIFIER_TERMS.source, "gi");
  while ((m = modRe.exec(q)) !== null) {
    modifiers.push(m[0].toLowerCase());
  }
  q = q.replace(modRe, " ").replace(/\s+/g, " ").trim();

  const lower = q.toLowerCase();

  const modifierConcepts = [];
  const rareConcepts = [];
  for (const phrase of EXPOSURE_PHRASES) {
    const p = phrase.toLowerCase();
    if (p && lower.includes(p)) {
      if (!modifierConcepts.includes(phrase)) modifierConcepts.push(phrase);
      if (!rareConcepts.includes(phrase)) rareConcepts.push(phrase);
      const phraseRe = new RegExp(
        phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "ig",
      );
      q = q.replace(phraseRe, " ").replace(/\s+/g, " ").trim();
    }
  }

  const allTokens = q
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const coreTokens = [];
  for (const token of allTokens) {
    if (isProtectedExposureToken(token)) {
      if (!modifierConcepts.includes(token)) modifierConcepts.push(token);
      if (!rareConcepts.includes(token)) rareConcepts.push(token);
      continue;
    }
    if (MEDICAL_STOP_WORDS.has(token)) continue;
    coreTokens.push(token);
  }

  const coreConcepts = coreTokens.length ? [coreTokens.join(" ")] : [];

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

  return {
    coreConcepts,
    modifierConcepts,
    rareConcepts,
    interventionConcept,
    modifiers,
  };
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
function buildExposureConceptClause(terms) {
  if (!terms || terms.length === 0) return "";
  const parts = [];
  for (const t of terms) {
    const trimmed = t.trim();
    if (!trimmed) continue;
    const quoted = trimmed.includes(" ") ? `"${trimmed}"` : trimmed;
    parts.push(`(${quoted}[tiab])`);
  }
  return parts.length ? `(${parts.join(" OR ")})` : "";
}

/**
 * @param {string} rawQuery
 * @param {{ simplifiedExposure?: boolean }} [opts] - If true, exposure uses only modifierConcepts + rareConcepts (no full EXPOSURE_FAMILIES expansion). Use when combining multiple sources.
 */
export function buildConceptAwareQuery(rawQuery = "", opts = {}) {
  const simplifiedExposure = opts.simplifiedExposure === true;
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
      coreConceptTerms: [],
    };
  }

  const intent = detectIntent(rawQuery);
  const {
    coreConcepts,
    modifierConcepts,
    rareConcepts,
    interventionConcept,
  } = extractConceptsV2(rawQuery);

  const diseaseGroupQuery = buildConceptClause(coreConcepts, true);

  const lower = rawQuery.toLowerCase();
  const exposureTerms = new Set();
  // Seed from detected modifier concepts
  for (const mc of modifierConcepts) {
    if (mc && mc.trim()) exposureTerms.add(mc.trim());
  }
  for (const r of rareConcepts || []) {
    if (r && r.trim()) exposureTerms.add(r.trim());
  }
  if (!simplifiedExposure) {
    const lower = rawQuery.toLowerCase();
    for (const fam of EXPOSURE_FAMILIES) {
      let familyActive = false;
      for (const phrase of fam.phrases || []) {
        const p = phrase.toLowerCase();
        if (p && lower.includes(p)) {
          familyActive = true;
          break;
        }
      }
      if (!familyActive) {
        for (const tok of fam.tokens || []) {
          const t = tok.toLowerCase();
          if (t && lower.includes(t)) {
            familyActive = true;
            break;
          }
        }
      }
      if (familyActive) {
        (fam.tokens || []).forEach((t) => {
          if (t && t.trim()) exposureTerms.add(t.trim());
        });
        (fam.phrases || []).forEach((p) => {
          if (p && p.trim()) exposureTerms.add(p.trim());
        });
      }
    }
  }
  const exposureGroupQuery = buildExposureConceptClause([...exposureTerms]);

  const toxicityTokens = new Set();
  for (const fam of EXPOSURE_FAMILIES) {
    (fam.toxicityTokens || []).forEach((t) => toxicityTokens.add(t));
  }
  const toxicityGroupQuery = buildExposureConceptClause([...toxicityTokens]);

  const interventionGroup =
    interventionConcept && interventionConcept.length > 0
      ? `(${interventionConcept.join(" OR ")})`
      : "";

  const hasDisease = !!diseaseGroupQuery;
  const hasExposure = !!exposureGroupQuery;
  const hasToxicity = !!toxicityGroupQuery;
  const isMultiConcept = hasDisease && hasExposure;

  let tier1Query = "";
  let tier2Query = "";
  if (hasDisease && hasExposure) {
    tier2Query = `${diseaseGroupQuery} AND ${exposureGroupQuery}`;
    tier1Query = hasToxicity
      ? `${tier2Query} AND ${toxicityGroupQuery}`
      : tier2Query;
  }

  let pubmedQuery;
  if (tier1Query) {
    pubmedQuery = tier1Query;
  } else if (tier2Query) {
    pubmedQuery = tier2Query;
  } else if (diseaseGroupQuery && interventionGroup) {
    pubmedQuery = `${diseaseGroupQuery} AND ${interventionGroup}`;
  } else if (diseaseGroupQuery) {
    pubmedQuery = diseaseGroupQuery;
  } else if (interventionGroup) {
    pubmedQuery = interventionGroup;
  } else {
    pubmedQuery = rawQuery.replace(/\s+/g, " ").trim();
  }

  const queryTerms = rawQuery
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);

  const conditionTokens = coreConcepts
    .join(" ")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  const coreConceptTerms = [
    ...new Set([...coreConcepts, ...conditionTokens]),
  ];
  const synExp = expandQueryWithSynonyms(coreConcepts.join(" "));
  if (synExp && synExp !== coreConcepts.join(" ")) {
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
    coreConcepts,
    modifierConcepts,
    rareConcepts,
    diseaseGroupQuery,
    exposureGroupQuery,
    toxicityGroupQuery,
    tier1Query: tier1Query || undefined,
    tier2Query: tier2Query || undefined,
    isMultiConcept,
  };
}
