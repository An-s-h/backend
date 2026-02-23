/**
 * Pre-loaded sample experts for the Experts page tutorial.
 * Returned by GET /api/search/experts/tutorial so the tour shows example cards
 * without calling OpenAlex/Semantic Scholar or using search limits.
 */
export const TUTORIAL_EXPERTS = [
  {
    name: "Dr. Sarah Chen",
    affiliation: "University of Toronto, Department of Medicine",
    location: "Toronto, Canada",
    biography:
      "Physician-scientist focused on hypertension and cardiovascular outcomes. Leads trials on lifestyle interventions and blood pressure control in diverse populations.",
    orcid: "0000-0002-1234-5678",
    orcidUrl: "https://orcid.org/0000-0002-1234-5678",
    matchPercentage: 94,
    matchExplanation: "Strong match: expertise in hypertension and your location.",
    metrics: {
      totalPublications: 87,
      totalCitations: 3240,
      totalPublicationsLabel: "87 publications",
      totalCitationsLabel: "3,240 citations",
    },
    scores: {
      citations: 0.85,
      works: 0.82,
      recency: 0.78,
      fieldRelevance: 0.92,
      location: 0.9,
    },
    currentPosition: "Associate Professor of Medicine",
    researchInterests: ["Hypertension", "Cardiovascular disease", "Clinical trials"],
  },
  {
    name: "Prof. James Okonkwo",
    affiliation: "McGill University Health Centre",
    location: "Montreal, Canada",
    biography:
      "Researcher in resistant hypertension and renal denervation. Principal investigator on several international Phase III trials.",
    orcid: "0000-0003-2345-6789",
    orcidUrl: "https://orcid.org/0000-0003-2345-6789",
    matchPercentage: 88,
    matchExplanation: "Relevant expertise in hypertension and interventional approaches.",
    metrics: {
      totalPublications: 62,
      totalCitations: 2100,
      totalPublicationsLabel: "62 publications",
      totalCitationsLabel: "2,100 citations",
    },
    scores: {
      citations: 0.78,
      works: 0.75,
      recency: 0.85,
      fieldRelevance: 0.88,
      location: 0.72,
    },
    currentPosition: "Professor of Cardiology",
    researchInterests: ["Resistant hypertension", "Interventional cardiology", "Renal denervation"],
  },
  {
    name: "Dr. Maria Santos",
    affiliation: "University of British Columbia",
    location: "Vancouver, Canada",
    biography:
      "Epidemiologist and trialist specializing in blood pressure epidemiology, salt sensitivity, and population health interventions.",
    orcid: "0000-0001-3456-7890",
    orcidUrl: "https://orcid.org/0000-0001-3456-7890",
    matchPercentage: 85,
    matchExplanation: "Strong fit for hypertension research and lifestyle factors.",
    metrics: {
      totalPublications: 54,
      totalCitations: 1850,
      totalPublicationsLabel: "54 publications",
      totalCitationsLabel: "1,850 citations",
    },
    scores: {
      citations: 0.72,
      works: 0.7,
      recency: 0.88,
      fieldRelevance: 0.85,
      location: 0.8,
    },
    currentPosition: "Assistant Professor, School of Population Health",
    researchInterests: ["Hypertension", "Epidemiology", "Salt sensitivity", "Population health"],
  },
];
