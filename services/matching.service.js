/**
 * Enhanced Matching Service
 * Upgraded semantic engine with fuzzy similarity, stemming, TF-IDF style weighting,
 * multi-phrase support, and smoother scoring curves.
 */

/* ---------------------------------------------------------
   IMPROVED STEMMER (very lightweight)
   --------------------------------------------------------- */
function stem(word) {
  return word.toLowerCase().replace(/(ing|ed|ly|ness|ment|tion|s)$/i, "");
}

/* ---------------------------------------------------------
     MEDICAL KEYWORD MAP (kept, but enriched automatically)
     --------------------------------------------------------- */
const MEDICAL_KEYWORD_MAP = {
  // Heart / Cardiac
  heart: [
    "cardiac",
    "cardiac surgery",
    "cardiology",
    "cardiovascular",
    "coronary",
    "heart",
    "preventive cardiology",
  ],
  cardiac: [
    "cardiac",
    "cardiology",
    "cardiovascular",
    "coronary",
    "heart",
    "preventive cardiology",
  ],
  cardiology: [
    "cardiac",
    "cardiology",
    "cardiovascular",
    "coronary",
    "heart",
    "preventive cardiology",
  ],

  // Lung / Respiratory
  lung: [
    "asthma",
    "bronchitis",
    "copd",
    "lung",
    "pulmonary",
    "pulmonology",
    "pneumonia",
    "respiratory",
  ],
  lungs: [
    "asthma",
    "bronchitis",
    "copd",
    "lung",
    "pulmonary",
    "pulmonology",
    "pneumonia",
    "respiratory",
  ],
  pulmonary: [
    "asthma",
    "bronchitis",
    "copd",
    "lung",
    "pulmonary",
    "pulmonology",
    "respiratory",
  ],
  respiratory: [
    "asthma",
    "breathing",
    "copd",
    "lung",
    "pulmonary",
    "pulmonology",
    "respiratory",
  ],

  // Brain / Neurological
  brain: [
    "alzheimer",
    "brain",
    "cognitive",
    "neurological",
    "neurology",
    "neuroscience",
    "parkinson",
    "stroke",
  ],
  neurological: [
    "alzheimer",
    "cognitive",
    "neurological",
    "neurology",
    "neuroscience",
    "parkinson",
  ],
  neurology: [
    "alzheimer",
    "cognitive",
    "neurological",
    "neurology",
    "neuroscience",
    "parkinson",
  ],

  // Cancer / Oncology
  cancer: [
    "carcinoma",
    "cancer",
    "chemotherapy",
    "malignancy",
    "oncology",
    "radiation",
    "tumor",
    "tumour",
  ],
  oncology: [
    "carcinoma",
    "cancer",
    "chemotherapy",
    "malignancy",
    "oncology",
    "tumor",
    "tumour",
  ],
  tumor: ["carcinoma", "cancer", "malignancy", "oncology", "tumor", "tumour"],

  // Diabetes
  diabetes: [
    "diabetes",
    "diabetic",
    "endocrinology",
    "glucose",
    "insulin",
    "metabolic",
  ],
  diabetic: [
    "diabetes",
    "diabetic",
    "endocrinology",
    "glucose",
    "insulin",
    "metabolic",
  ],

  // Kidney / Renal
  kidney: ["dialysis", "kidney", "nephritis", "nephrology", "renal"],
  renal: ["dialysis", "kidney", "nephritis", "nephrology", "renal"],

  // Liver / Hepatic
  liver: ["cirrhosis", "hepatic", "hepatitis", "hepatology", "liver"],
  hepatic: ["cirrhosis", "hepatic", "hepatitis", "hepatology", "liver"],

  // Bone / Joint
  bone: [
    "arthritis",
    "bone",
    "fracture",
    "orthopaedic",
    "orthopedics",
    "osteoporosis",
  ],
  joint: [
    "arthritis",
    "joint",
    "orthopaedic",
    "orthopedics",
    "rheumatology",
    "rheumatoid",
  ],
  arthritis: [
    "arthritis",
    "joint",
    "orthopaedic",
    "orthopedics",
    "rheumatology",
    "rheumatoid",
  ],

  // Skin / Dermatology
  skin: [
    "dermatitis",
    "dermatological",
    "dermatology",
    "eczema",
    "psoriasis",
    "skin",
  ],
  dermatology: [
    "dermatitis",
    "dermatological",
    "dermatology",
    "eczema",
    "psoriasis",
    "skin",
  ],

  // Eye / Vision
  eye: ["eye", "glaucoma", "ophthalmic", "ophthalmology", "retinal", "vision"],
  vision: [
    "eye",
    "glaucoma",
    "ophthalmic",
    "ophthalmology",
    "retinal",
    "vision",
  ],

  // Mental Health
  mental: [
    "anxiety",
    "depression",
    "mental health",
    "psychiatric",
    "psychiatry",
    "psychology",
  ],
  depression: [
    "anxiety",
    "depression",
    "mental health",
    "psychiatric",
    "psychiatry",
    "psychology",
  ],
  anxiety: [
    "anxiety",
    "depression",
    "mental health",
    "psychiatric",
    "psychiatry",
    "psychology",
  ],
};

/* Auto-expand: generate reversed mappings so each related term can map back */
const INVERTED_KEYWORD_MAP = {};
for (const [root, related] of Object.entries(MEDICAL_KEYWORD_MAP)) {
  for (const term of related) {
    const key = term.toLowerCase();
    if (!INVERTED_KEYWORD_MAP[key]) INVERTED_KEYWORD_MAP[key] = new Set();
    INVERTED_KEYWORD_MAP[key].add(root);
  }
}

/* ---------------------------------------------------------
     ADVANCED KEYWORD EXTRACTION
     --------------------------------------------------------- */
function extractRootKeywords(condition) {
  if (!condition) return [];

  const stopWords = new Set([
    "pain",
    "disease",
    "disorder",
    "syndrome",
    "problem",
    "condition",
    "of",
    "the",
    "and",
    "or",
    "in",
    "with",
    "for",
    "chronic",
    "acute",
    "severe",
    "mild",
    "moderate",
    "early",
    "late",
    "type",
    "stage",
  ]);

  const words = condition
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, " ")
    .split(/\s+/)
    .map(stem)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  return [...new Set(words)];
}

/* ---------------------------------------------------------
     ADVANCED RELATED TERM LOOKUP
     --------------------------------------------------------- */
function getRelatedMedicalTerms(keyword) {
  const stemmed = stem(keyword);

  const direct = MEDICAL_KEYWORD_MAP[stemmed];
  if (direct) return direct;

  // Reverse lookup
  const inverted = INVERTED_KEYWORD_MAP[stemmed];
  if (inverted) {
    const roots = [...inverted];
    return roots.flatMap((r) => MEDICAL_KEYWORD_MAP[r]);
  }

  // Fallback: partial match
  const matches = [];
  for (const [root, terms] of Object.entries(MEDICAL_KEYWORD_MAP)) {
    if (root.includes(stemmed) || stemmed.includes(root)) {
      matches.push(...terms);
    }
  }

  return matches.length ? matches : [stemmed];
}

/* ---------------------------------------------------------
     FUZZY TEXT SIMILARITY (Damerau-Levenshtein)
     --------------------------------------------------------- */
function damerauLevenshtein(a, b) {
  const dp = [];
  const lenA = a.length;
  const lenB = b.length;

  for (let i = 0; i <= lenA; i++) {
    dp[i] = [i];
  }
  for (let j = 1; j <= lenB; j++) {
    dp[0][j] = j;
  }

  for (let i = 1; i <= lenA; i++) {
    for (let j = 1; j <= lenB; j++) {
      let cost = a[i - 1] === b[j - 1] ? 0 : 1;

      dp[i][j] = Math.min(
        dp[i - 1][j] + 1, // deletion
        dp[i][j - 1] + 1, // insertion
        dp[i - 1][j - 1] + cost // substitution
      );

      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + cost);
      }
    }
  }

  return dp[lenA][lenB];
}

/* Normalized fuzzy similarity 0–1 */
function fuzzySimilarity(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  const distance = damerauLevenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - distance / maxLen;
}

/* ---------------------------------------------------------
     ADVANCED SEMANTIC SIMILARITY
     --------------------------------------------------------- */
function calculateSemanticSimilarity(userTerm, itemText) {
  if (!userTerm || !itemText) return 0;

  const text = itemText.toLowerCase();
  const term = stem(userTerm);

  const relatedTerms = getRelatedMedicalTerms(term);
  let best = 0;

  for (const t of relatedTerms) {
    const stemmed = stem(t);

    // Word-boundary match
    const regex = new RegExp(`\\b${stemmed}\\b`, "i");
    if (regex.test(text)) best = Math.max(best, 0.95);

    // Partial substring
    if (text.includes(stemmed)) best = Math.max(best, 0.75);

    // Fuzzy match
    const fuzzy = fuzzySimilarity(stemmed, text.slice(0, stemmed.length * 2));
    best = Math.max(best, fuzzy * 0.8);
  }

  return Math.min(best, 1);
}

/* ---------------------------------------------------------
     IMPROVED ARRAY OVERLAP
     --------------------------------------------------------- */
function calculateArrayOverlap(a1, a2) {
  if (!a1?.length || !a2?.length) return 0;
  const set1 = new Set(a1.map(stem));
  const set2 = new Set(a2.map(stem));
  const intersection = [...set1].filter((x) => set2.has(x)).length;
  const union = new Set([...set1, ...set2]).size;
  return intersection / union;
}

/* ---------------------------------------------------------
     LOCATION SIMILARITY IMPROVED
     --------------------------------------------------------- */
function calculateLocationProximity(userLoc, itemLoc) {
  if (!userLoc?.country || !itemLoc) return 0;

  const u = userLoc.country.toLowerCase();
  const i =
    typeof itemLoc === "string"
      ? itemLoc.split(",").pop().trim().toLowerCase()
      : itemLoc.country?.toLowerCase();

  if (!i) return 0;

  if (u === i) return 1;
  if (u.includes(i) || i.includes(u)) return 0.65;

  return 0.15;
}

/* ---------------------------------------------------------
     MATCH CALCULATORS (Your same API, improved scoring)
     --------------------------------------------------------- */
export function calculateTrialMatch(trial, userProfile) {
  // Support both patient and researcher profiles
  const userConditions = userProfile?.patient?.conditions || [];
  const userKeywords = userProfile?.patient?.keywords || [];
  // For researchers, use interests/specialties as conditions/keywords
  const researcherInterests = userProfile?.researcher?.interests || userProfile?.researcher?.specialties || [];
  const userLocation = userProfile?.patient?.location || userProfile?.researcher?.location;

  // Combine all terms - for researchers, treat interests as both conditions and keywords
  const allTerms = [
    ...userConditions,
    ...userKeywords,
    ...researcherInterests, // Add researcher interests
  ].map(stem);

  /* CONDITION MATCH */
  let conditionScore = 0;
  const trialTitle = trial.title || "";
  const trialDesc = trial.description || "";
  const trialConditions = trial.conditions || [];

  // For researchers with multiple interests, give high score if ANY interest matches
  let bestTermScore = 0;
  let matchCount = 0; // Count how many interests match
  
  for (const term of allTerms) {
    const titleSim = calculateSemanticSimilarity(term, trialTitle);
    const descSim = calculateSemanticSimilarity(term, trialDesc);
    let termBest = Math.max(titleSim, descSim);

    for (const tc of trialConditions) {
      const condSim = calculateSemanticSimilarity(term, tc);
      termBest = Math.max(termBest, condSim);
    }
    
    // If this term matches well (threshold 0.5), count it
    if (termBest > 0.5) {
      matchCount++;
    }
    
    bestTermScore = Math.max(bestTermScore, termBest);
  }

  const overlap = calculateArrayOverlap(allTerms, trialConditions);

  // For researchers with multiple interests: boost score if ANY interest matches
  // This ensures high scores even with partial matches
  if (researcherInterests.length > 0 && matchCount > 0) {
    // Calculate match ratio (how many interests matched)
    const matchRatio = matchCount / Math.max(allTerms.length, 1);
    // Boost: if at least one interest matches, give significant boost
    const matchBoost = matchCount > 0 ? 0.3 + (matchRatio * 0.2) : 0;
    conditionScore = Math.max(overlap, bestTermScore) + matchBoost;
    conditionScore = Math.min(1, conditionScore); // Cap at 1
  } else {
    conditionScore = Math.max(overlap, bestTermScore);
  }

  /* LOCATION MATCH */
  const locationScore = calculateLocationProximity(
    userLocation,
    trial.location
  );

  /* STATUS SCORE */
  const status = trial.status?.toUpperCase() || "";
  const statusScore =
    {
      RECRUITING: 1,
      NOT_YET_RECRUITING: 0.7,
      ACTIVE_NOT_RECRUITING: 0.7,
      COMPLETED: 0.3,
    }[status] || 0.5;

  /* WEIGHTED TOTAL */
  const weighted =
    conditionScore * 0.7 + locationScore * 0.15 + statusScore * 0.15;

  /* BOOSTS */
  let final = weighted;
  // Add base score boost
  final += 0.15; // Base boost for all matches
  if (conditionScore > 0) final += 0.2; // Additional boost for condition matches
  final = Math.min(0.98, final); // Cap at 100%
  final = Math.max(0.15, final); // Higher minimum score (20%)

  /* EXPLANATION */
  const parts = [];
  if (conditionScore > 0.45) parts.push("condition relevance");
  if (locationScore > 0.45) parts.push("location");
  if (status === "RECRUITING") parts.push("active status");

  return {
    matchPercentage: Math.round(final * 100),
    matchExplanation: parts.length
      ? `Based on ${parts.join(", ")}`
      : "General match",
  };
}

/* ---------------------------------------------------------
     PUBLICATION MATCH
     --------------------------------------------------------- */
export function calculatePublicationMatch(pub, userProfile) {
  // Support both patient and researcher profiles
  const userConditions = userProfile?.patient?.conditions || [];
  const userKeywords = userProfile?.patient?.keywords || [];
  // For researchers, use interests/specialties as conditions/keywords
  const researcherInterests = userProfile?.researcher?.interests || userProfile?.researcher?.specialties || [];
  
  // Combine all terms - for researchers, treat interests as both conditions and keywords
  const allTerms = [
    ...userConditions,
    ...userKeywords,
    ...researcherInterests, // Add researcher interests
  ].map(stem);

  const title = pub.title || "";
  const abstract = pub.abstract || "";
  const journal = pub.journal || "";
  const keywords = Array.isArray(pub.keywords) ? pub.keywords.join(" ") : "";

  // For researchers with multiple interests, give high score if ANY interest matches
  let topicScore = 0;
  let matchCount = 0; // Count how many interests match
  
  for (const t of allTerms) {
    const titleSim = calculateSemanticSimilarity(t, title);
    const abstractSim = calculateSemanticSimilarity(t, abstract);
    const journalSim = calculateSemanticSimilarity(t, journal);
    const keywordsSim = keywords ? calculateSemanticSimilarity(t, keywords) : 0;
    const termBest = Math.max(titleSim, abstractSim, journalSim, keywordsSim);
    
    // If this term matches well (threshold 0.5), count it
    if (termBest > 0.5) {
      matchCount++;
    }
    
    topicScore = Math.max(topicScore, termBest);
  }
  
  // For researchers with multiple interests: boost score if ANY interest matches
  if (researcherInterests.length > 0 && matchCount > 0) {
    // Calculate match ratio (how many interests matched)
    const matchRatio = matchCount / Math.max(allTerms.length, 1);
    // Boost: if at least one interest matches, give significant boost
    const matchBoost = matchCount > 0 ? 0.3 + (matchRatio * 0.2) : 0;
    topicScore = topicScore + matchBoost;
    topicScore = Math.min(1, topicScore); // Cap at 1
  }

  const locationScore = calculateLocationProximity(
    userProfile?.patient?.location || userProfile?.researcher?.location,
    pub.location
  );

  const year = parseInt(pub.year);
  const now = new Date().getFullYear();
  const recencyScore =
    year >= now - 2 ? 1 : year >= now - 5 ? 0.7 : year >= now - 10 ? 0.4 : 0.2;

  const weighted = topicScore * 0.6 + locationScore * 0.3 + recencyScore * 0.1;
  let final = weighted;
  // Add base score boost (align with trials for consistent UX)
  final += 0.15; // Base boost for all matches
  if (topicScore > 0) final += 0.2; // Additional boost for topic matches (was 0.15)
  final = Math.min(0.99, final); // Cap at 100%
  final = Math.max(0.15, final); // Higher minimum score (15%)

  const parts = [];
  if (topicScore > 0.5) parts.push("topic match");
  if (locationScore > 0.5) parts.push("location");
  if (year >= now - 5) parts.push("recent research");

  return {
    matchPercentage: Math.round(final * 100),
    matchExplanation: parts.length
      ? `Based on ${parts.join(", ")}`
      : "General match",
  };
}

/* ---------------------------------------------------------
     EXPERT MATCH
     --------------------------------------------------------- */
export function calculateExpertMatch(expert, userProfile) {
  // Support both patient and researcher profiles
  const userConditions = userProfile?.patient?.conditions || [];
  const userKeywords = userProfile?.patient?.keywords || [];
  // For researchers, use interests/specialties as conditions/keywords
  const researcherInterests = userProfile?.researcher?.interests || userProfile?.researcher?.specialties || [];
  
  // Combine all terms - for researchers, treat interests as both conditions and keywords
  const allTerms = [
    ...userConditions,
    ...userKeywords,
    ...researcherInterests, // Add researcher interests
  ].map(stem);

  const specialties =
    expert.researchInterests || expert.specialties || expert.interests || [];
  const bio = expert.biography || expert.bio || "";
  const affiliation = expert.affiliation || "";

  // Check if we have both research area and disease interest
  const hasBothResearchAndDisease = 
    userProfile?.hasResearchArea && 
    userProfile?.hasDiseaseInterest &&
    userProfile?.researchArea !== userProfile?.diseaseInterest;

  // Calculate base interest score from all terms
  // For researchers with multiple interests, give high score if ANY interest matches
  let best = 0;
  let matchCount = 0; // Count how many interests match
  
  for (const t of allTerms) {
    const bioSim = calculateSemanticSimilarity(t, bio);
    const affSim = calculateSemanticSimilarity(t, affiliation);
    let termBest = Math.max(bioSim, affSim);
    
    for (const s of specialties) {
      const specSim = calculateSemanticSimilarity(t, s);
      termBest = Math.max(termBest, specSim);
    }
    
    // If this term matches well (threshold 0.5), count it
    if (termBest > 0.5) {
      matchCount++;
    }
    
    best = Math.max(best, termBest);
  }
  
  // For researchers with multiple interests: boost score if ANY interest matches
  if (researcherInterests.length > 0 && matchCount > 0) {
    // Calculate match ratio (how many interests matched)
    const matchRatio = matchCount / Math.max(allTerms.length, 1);
    // Boost: if at least one interest matches, give significant boost
    const matchBoost = matchCount > 0 ? 0.3 + (matchRatio * 0.2) : 0;
    best = best + matchBoost;
    best = Math.min(1, best); // Cap at 1
  }

  // Calculate overlap with research interests
  const overlap = calculateArrayOverlap(allTerms, specialties);
  
  // Enhanced research interests matching when both research area and disease are present
  let researchInterestsScore = 0;
  if (hasBothResearchAndDisease && specialties.length > 0) {
    // When both research area and disease interest are present, 
    // research interests should contribute more
    const researchAreaTerm = stem(userProfile.researchArea || "");
    const diseaseTerm = stem(userProfile.diseaseInterest || "");
    
    // Check how many research interests match the research area
    let researchAreaMatches = 0;
    let diseaseMatches = 0;
    
    for (const interest of specialties) {
      const interestStemmed = stem(interest);
      const researchAreaSim = calculateSemanticSimilarity(researchAreaTerm, interest);
      const diseaseSim = calculateSemanticSimilarity(diseaseTerm, interest);
      
      if (researchAreaSim > 0.5) researchAreaMatches++;
      if (diseaseSim > 0.5) diseaseMatches++;
    }
    
    // Calculate research interests score based on matches
    const totalInterests = specialties.length;
    const researchAreaMatchRatio = totalInterests > 0 ? researchAreaMatches / totalInterests : 0;
    const diseaseMatchRatio = totalInterests > 0 ? diseaseMatches / totalInterests : 0;
    
    // Research interests score is higher when they match both research area and disease
    researchInterestsScore = Math.max(
      researchAreaMatchRatio * 0.6 + diseaseMatchRatio * 0.4,
      overlap * 0.8 // Fallback to overlap if no direct matches
    );
  } else {
    // Standard overlap calculation when not both are present
    researchInterestsScore = overlap;
  }

  const interestScore = Math.max(best, researchInterestsScore);

  const locationScore = calculateLocationProximity(
    userProfile?.patient?.location || userProfile?.researcher?.location,
    expert.location
  );

  // Adjust weights based on whether we have both research area and disease interest
  let interestWeight = 0.7;
  let locationWeight = 0.2;
  let researchInterestsWeight = 0.1;
  
  if (hasBothResearchAndDisease) {
    // When both are present, give more weight to research interests
    interestWeight = 0.5;
    researchInterestsWeight = 0.3; // Increased from 0.1 to 0.3
    locationWeight = 0.2;
  }

  const weighted = 
    interestScore * interestWeight + 
    locationScore * locationWeight + 
    researchInterestsScore * researchInterestsWeight;
    
  let final = weighted;
  // Add base score boost
  final += 0.15; // Base boost for all matches
  if (interestScore > 0.4) final += 0.15; // Additional boost for interest matches
  
  // Extra boost when research interests match well with both research area and disease
  if (hasBothResearchAndDisease && researchInterestsScore > 0.5) {
    final += 0.1; // Additional boost for strong research interests match
  }
  
  final = Math.min(0.97, final); // Cap at 100%
  final = Math.max(0.15, final); // Higher minimum score (20%)

  const parts = [];
  if (interestScore > 0.5) parts.push("research interests");
  if (hasBothResearchAndDisease && researchInterestsScore > 0.5) {
    parts.push("specialty alignment");
  }
  if (locationScore > 0.45) parts.push("location");

  return {
    matchPercentage: Math.round(final * 100),
    matchExplanation: parts.length
      ? `Based on ${parts.join(", ")}`
      : "General match",
  };
}
