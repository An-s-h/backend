/**
 * Medical Terminology Service
 * Layer 1: Translation Layer - MeSH Mapping and UMLS Synonym Expansion
 * Maps user natural language to clinical terminology and expands synonyms
 */

// Common medical condition mappings (MeSH-inspired)
const CONDITION_SYNONYMS = {
  // ALS / Lou Gehrig's Disease
  "lou gehrig's disease": ["Amyotrophic Lateral Sclerosis", "ALS", "Motor Neuron Disease"],
  "lou gehrigs disease": ["Amyotrophic Lateral Sclerosis", "ALS", "Motor Neuron Disease"],
  "als": ["Amyotrophic Lateral Sclerosis", "Motor Neuron Disease"],
  "amyotrophic lateral sclerosis": ["ALS", "Motor Neuron Disease", "Lou Gehrig's Disease"],

  // Breast Cancer
  "breast cancer": ["Malignant Neoplasm of Breast", "Breast Carcinoma", "Mammary Carcinoma"],
  "mammary carcinoma": ["Breast Cancer", "Malignant Neoplasm of Breast"],
  "malignant neoplasm of breast": ["Breast Cancer", "Breast Carcinoma"],

  // Glioblastoma
  "glioblastoma": ["Glioblastoma Multiforme", "GBM", "Grade IV Astrocytoma"],
  "gbm": ["Glioblastoma", "Glioblastoma Multiforme", "Grade IV Astrocytoma"],
  "grade iv astrocytoma": ["Glioblastoma", "GBM"],

  // Alzheimer's
  "alzheimer's": ["Alzheimer Disease", "Alzheimer's Disease", "AD", "Dementia"],
  "alzheimer": ["Alzheimer Disease", "Alzheimer's Disease", "AD"],
  "ad": ["Alzheimer Disease", "Alzheimer's Disease"],

  // Parkinson's
  "parkinson's": ["Parkinson Disease", "Parkinson's Disease", "PD"],
  "parkinson": ["Parkinson Disease", "Parkinson's Disease", "PD"],
  "pd": ["Parkinson Disease", "Parkinson's Disease"],

  // Cancer general terms
  "cancer": ["Neoplasm", "Malignancy", "Carcinoma", "Tumor"],
  "tumor": ["Neoplasm", "Cancer", "Malignancy"],
  "carcinoma": ["Cancer", "Malignancy", "Neoplasm"],

  // Diabetes
  "diabetes": ["Diabetes Mellitus", "DM"],
  "type 2 diabetes": ["Type 2 Diabetes Mellitus", "T2DM", "Non-Insulin Dependent Diabetes"],
  "type 1 diabetes": ["Type 1 Diabetes Mellitus", "T1DM", "Insulin Dependent Diabetes"],

  // Heart conditions
  "heart disease": ["Cardiovascular Disease", "Heart Disease", "Cardiac Disease"],
  "heart attack": ["Myocardial Infarction", "MI", "Acute Myocardial Infarction"],
  "mi": ["Myocardial Infarction", "Heart Attack"],

  // Stroke
  "stroke": ["Cerebrovascular Accident", "CVA", "Brain Attack"],
  "cva": ["Stroke", "Cerebrovascular Accident"],

  // Multiple Sclerosis
  "multiple sclerosis": ["MS", "Disseminated Sclerosis"],
  "ms": ["Multiple Sclerosis", "Disseminated Sclerosis"],

  // Rheumatoid Arthritis
  "rheumatoid arthritis": ["RA", "Rheumatoid Arthritis"],
  "ra": ["Rheumatoid Arthritis"],
};

// Biomarker and mutation terms
const BIOMARKER_TERMS = {
  // Genetic mutations
  "idh1": ["IDH1 mutation", "Isocitrate Dehydrogenase 1", "IDH1-mutant"],
  "idh": ["IDH1", "IDH2", "Isocitrate Dehydrogenase"],
  "brca": ["BRCA1", "BRCA2", "BRCA mutation"],
  "brca1": ["BRCA1 mutation", "Breast Cancer Gene 1"],
  "brca2": ["BRCA2 mutation", "Breast Cancer Gene 2"],
  "her2": ["HER2/neu", "ERBB2", "Human Epidermal Growth Factor Receptor 2"],
  "egfr": ["EGFR", "Epidermal Growth Factor Receptor"],
  "kras": ["KRAS mutation", "Kirsten Rat Sarcoma"],
  "braf": ["BRAF mutation", "B-Raf"],
  "p53": ["TP53", "Tumor Protein p53"],
  "alk": ["ALK", "Anaplastic Lymphoma Kinase"],
  "ros1": ["ROS1", "ROS Proto-Oncogene 1"],

  // Protein biomarkers
  "tau": ["Tau protein", "MAPT", "Microtubule-Associated Protein Tau"],
  "amyloid-beta": ["Amyloid beta", "Aβ", "Beta-amyloid"],
  "amyloid": ["Amyloid-beta", "Aβ"],
  "psa": ["Prostate-Specific Antigen", "PSA"],
  "cea": ["Carcinoembryonic Antigen", "CEA"],
  "ca125": ["CA-125", "Cancer Antigen 125"],
  "ca19-9": ["CA 19-9", "Carbohydrate Antigen 19-9"],

  // Other biomarkers
  "pd-l1": ["PD-L1", "Programmed Death-Ligand 1", "CD274"],
  "msi": ["MSI", "Microsatellite Instability"],
  "tmb": ["TMB", "Tumor Mutational Burden"],
};

// Centers of Excellence (for Layer 5 ranking)
const CENTERS_OF_EXCELLENCE = [
  "Mayo Clinic",
  "Dana-Farber",
  "Mass General",
  "Massachusetts General Hospital",
  "Johns Hopkins",
  "MD Anderson",
  "Memorial Sloan Kettering",
  "Cleveland Clinic",
  "Mayo",
  "Dana Farber",
  "MSK",
  "Memorial Sloan",
];

// Major biotech sponsors (for Layer 5 ranking)
const MAJOR_BIOTECH_SPONSORS = [
  "Biogen",
  "Genentech",
  "Roche",
  "Pfizer",
  "Merck",
  "Novartis",
  "Bristol-Myers Squibb",
  "BMS",
  "AstraZeneca",
  "Eli Lilly",
  "Amgen",
  "Gilead",
  "Regeneron",
  "Moderna",
  "BioNTech",
];

/**
 * Expand query with synonyms based on medical terminology
 * @param {string} query - User's natural language query
 * @returns {string} - Expanded query with synonyms
 */
export function expandQueryWithSynonyms(query) {
  if (!query || typeof query !== "string") return query;

  const queryLower = query.toLowerCase().trim();
  const expandedTerms = new Set([query]); // Start with original query

  // Check condition synonyms - use word boundary matching to avoid false positives
  for (const [key, synonyms] of Object.entries(CONDITION_SYNONYMS)) {
    // Use word boundary regex to match whole words/phrases only
    // This prevents "bowel" from matching "bowel" inside "irritable bowel syndrome" incorrectly
    const keyLower = key.toLowerCase();
    // For multi-word keys, check if the key appears as a complete phrase
    // For single-word keys, use word boundaries
    const keyWords = keyLower.split(/\s+/);
    if (keyWords.length > 1) {
      // Multi-word phrase: must appear as complete phrase
      const phraseRegex = new RegExp(`\\b${keyWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")}\\b`, "i");
      if (phraseRegex.test(queryLower)) {
        synonyms.forEach((syn) => expandedTerms.add(syn));
        expandedTerms.add(query); // Keep original
      }
    } else {
      // Single word: use word boundary
      const wordRegex = new RegExp(`\\b${keyLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (wordRegex.test(queryLower)) {
        synonyms.forEach((syn) => expandedTerms.add(syn));
        expandedTerms.add(query); // Keep original
      }
    }
  }

  // Check biomarker terms - use word boundary matching
  for (const [key, synonyms] of Object.entries(BIOMARKER_TERMS)) {
    const keyLower = key.toLowerCase();
    const wordRegex = new RegExp(`\\b${keyLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (wordRegex.test(queryLower)) {
      synonyms.forEach((syn) => expandedTerms.add(syn));
    }
  }

  // If we found synonyms, combine them with OR logic
  if (expandedTerms.size > 1) {
    return Array.from(expandedTerms).join(" OR ");
  }

  return query;
}

/**
 * Extract biomarkers from text (for Layer 3: Molecular Match)
 * @param {string} text - Text to search (e.g., eligibility criteria)
 * @returns {Array<string>} - Array of found biomarkers
 */
export function extractBiomarkers(text) {
  if (!text || typeof text !== "string") return [];

  const textLower = text.toLowerCase();
  const foundBiomarkers = new Set();

  // Check for biomarker mentions
  for (const [key, synonyms] of Object.entries(BIOMARKER_TERMS)) {
    // Check if key or any synonym appears in text
    const patterns = [key, ...synonyms.map((s) => s.toLowerCase())];
    for (const pattern of patterns) {
      // Use word boundary regex for better matching
      const regex = new RegExp(`\\b${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (regex.test(textLower)) {
        foundBiomarkers.add(key.toUpperCase());
        break;
      }
    }
  }

  return Array.from(foundBiomarkers);
}

/**
 * Check if a location/institution is a Center of Excellence
 * @param {string} location - Location or institution name
 * @returns {boolean}
 */
export function isCenterOfExcellence(location) {
  if (!location || typeof location !== "string") return false;

  const locationLower = location.toLowerCase();
  return CENTERS_OF_EXCELLENCE.some((center) =>
    locationLower.includes(center.toLowerCase())
  );
}

/**
 * Check if a sponsor is a major biotech company
 * @param {string} sponsor - Sponsor name
 * @returns {boolean}
 */
export function isMajorBiotechSponsor(sponsor) {
  if (!sponsor || typeof sponsor !== "string") return false;

  const sponsorLower = sponsor.toLowerCase();
  return MAJOR_BIOTECH_SPONSORS.some((company) =>
    sponsorLower.includes(company.toLowerCase())
  );
}

/**
 * Map user query to MeSH-style clinical terminology
 * @param {string} userQuery - Natural language query
 * @returns {string} - Mapped clinical terminology
 */
export function mapToMeSHTerminology(userQuery) {
  if (!userQuery || typeof userQuery !== "string") return userQuery;

  const queryLower = userQuery.toLowerCase().trim();

  // Direct mappings - only map exact phrases, not partial matches
  const meshMappings = {
    "lou gehrig's disease": "Amyotrophic Lateral Sclerosis",
    "lou gehrigs disease": "Amyotrophic Lateral Sclerosis",
    "breast cancer": "Malignant Neoplasm of Breast",
    "heart attack": "Myocardial Infarction",
    "stroke": "Cerebrovascular Accident",
  };

  for (const [key, value] of Object.entries(meshMappings)) {
    const keyLower = key.toLowerCase();
    // Use word boundary regex to match complete phrases only
    // This prevents "heart attack" from matching inside "irritable bowel syndrome"
    const keyWords = keyLower.split(/\s+/);
    if (keyWords.length > 1) {
      // Multi-word phrase: must appear as complete phrase
      const phraseRegex = new RegExp(`\\b${keyWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")}\\b`, "i");
      if (phraseRegex.test(queryLower)) {
        return value;
      }
    } else {
      // Single word: use word boundary
      const wordRegex = new RegExp(`\\b${keyLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (wordRegex.test(queryLower)) {
        return value;
      }
    }
  }

  return userQuery; // Return original if no mapping found
}

