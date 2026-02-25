import axios from "axios";
import { findResearchersWithGemini } from "./geminiExperts.service.js";
import { searchClinicalTrials } from "./clinicalTrials.service.js";

const OPENALEX_BASE = "https://api.openalex.org";
const SEMSCH_BASE = "https://api.semanticscholar.org/graph/v1";

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function normalizeName(name = "") {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

function simpleNameScore(a = "", b = "") {
  // Very lightweight similarity: exact -> 1, substring -> 0.7, shared tokens -> 0.4+
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.7;
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return clamp01(inter / Math.max(ta.size, tb.size));
}

function lastNameOf(name = "") {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function isLastAuthor(paper, expertName) {
  const authors = paper?.authors || [];
  if (!Array.isArray(authors) || authors.length === 0) return false;
  const last = authors[authors.length - 1];
  const lastName = normalizeName(last?.name || "");
  return lastName && lastName.includes(normalizeName(expertName));
}

async function openAlexFindAuthorByName(name) {
  const url = `${OPENALEX_BASE}/authors`;
  const params = { search: name, "per-page": 5 };
  const resp = await axios.get(url, { params, timeout: 12000 });
  const results = resp.data?.results || [];
  if (!results.length) return null;

  let best = null;
  let bestScore = 0;
  for (const a of results) {
    const score = simpleNameScore(a?.display_name || "", name);
    // Prefer authors with meaningful work history
    const works = a?.works_count || 0;
    const boosted = score + Math.min(0.2, works / 500); // tiny boost
    if (boosted > bestScore) {
      bestScore = boosted;
      best = a;
    }
  }

  // Require at least weak name match + some works
  if (!best || bestScore < 0.45 || (best.works_count || 0) < 10) return null;
  return best;
}

async function openAlexFetchRecentWorks(authorOpenAlexId, perPage = 50) {
  // authorOpenAlexId is a full URL like https://openalex.org/Axxxx
  const authorId = String(authorOpenAlexId || "").split("/").pop();
  if (!authorId) return [];
  const url = `${OPENALEX_BASE}/works`;
  const params = {
    filter: `author.id:${authorId}`,
    sort: "publication_date:desc",
    "per-page": Math.min(100, Math.max(10, perPage)),
  };
  // OpenAlex recommends identifying requests; mailto improves reliability.
  if (process.env.OPENALEX_MAILTO) {
    params.mailto = process.env.OPENALEX_MAILTO;
  }
  const resp = await axios.get(url, {
    params,
    timeout: 15000,
    headers: { "User-Agent": "CuraLink/1.0 (expert verification)" },
  });
  return resp.data?.results || [];
}

async function semanticScholarFindAuthorByName(name) {
  const url = `${SEMSCH_BASE}/author/search`;
  const headers = {};
  if (process.env.SEMANTIC_SCHOLAR_API_KEY) {
    headers["x-api-key"] = process.env.SEMANTIC_SCHOLAR_API_KEY;
  }
  const params = {
    query: name,
    limit: 5,
    fields: "name,affiliations,paperCount,citationCount,hIndex,url",
  };
  const resp = await axios.get(url, { params, headers, timeout: 12000 });
  const data = resp.data?.data || [];
  if (!data.length) return null;

  let best = null;
  let bestScore = 0;
  for (const a of data) {
    const score = simpleNameScore(a?.name || "", name);
    const paperCount = a?.paperCount || 0;
    const boosted = score + Math.min(0.2, paperCount / 300);
    if (boosted > bestScore) {
      bestScore = boosted;
      best = a;
    }
  }
  if (!best || bestScore < 0.45 || (best.paperCount || 0) < 10) return null;
  return best;
}

async function semanticScholarFetchRecentPapers(authorId, limit = 40) {
  const headers = {};
  if (process.env.SEMANTIC_SCHOLAR_API_KEY) {
    headers["x-api-key"] = process.env.SEMANTIC_SCHOLAR_API_KEY;
  }
  const url = `${SEMSCH_BASE}/author/${encodeURIComponent(authorId)}/papers`;
  const params = {
    limit,
    fields:
      "title,year,venue,citationCount,isInfluential,publicationDate,authors",
  };
  const resp = await axios.get(url, { params, headers, timeout: 15000 });
  return resp.data?.data || [];
}

async function estimateTrialLeadershipScore(expertName) {
  // Heuristic: trials matching name; count those where PI name appears in principalInvestigator
  try {
    const res = await searchClinicalTrials({
      q: expertName,
      page: 1,
      pageSize: 50,
    });
    const items = res?.items || [];
    const ln = lastNameOf(expertName).toLowerCase();
    let leadershipCount = 0;
    for (const t of items) {
      const pi = (t.principalInvestigator || "").toLowerCase();
      if (ln && pi.includes(ln)) leadershipCount++;
    }
    return { leadershipCount, totalMatchedTrials: items.length };
  } catch {
    return { leadershipCount: 0, totalMatchedTrials: 0 };
  }
}

function computeMetricsFromPapers(papers, expertName) {
  const nowYear = new Date().getFullYear();
  const recent = papers.filter((p) => (p.year || 0) >= nowYear - 2);
  const last5y = papers.filter((p) => (p.year || 0) >= nowYear - 5);

  const lastAuthorCount = last5y.filter((p) => isLastAuthor(p, expertName))
    .length;

  const avgCitations =
    last5y.length > 0
      ? last5y.reduce((s, p) => s + (p.citationCount || 0), 0) / last5y.length
      : 0;

  const influentialCount = last5y.filter((p) => p.isInfluential).length;

  return {
    recentPapers2y: recent.length,
    papers5y: last5y.length,
    lastAuthor5y: lastAuthorCount,
    avgCitations5y: avgCitations,
    influential5y: influentialCount,
  };
}

function computeMetricsFromOpenAlexWorks(works, expertName) {
  const nowYear = new Date().getFullYear();
  const last2y = works.filter((w) => {
    const year = w?.publication_year || 0;
    return year >= nowYear - 2;
  });
  const last5y = works.filter((w) => {
    const year = w?.publication_year || 0;
    return year >= nowYear - 5;
  });

  const expertNorm = normalizeName(expertName);
  const lastAuthor5y = last5y.filter((w) => {
    const authorships = w?.authorships || [];
    if (!Array.isArray(authorships) || authorships.length === 0) return false;
    // OpenAlex provides author_position: first|middle|last
    return authorships.some((a) => {
      const nm = normalizeName(a?.author?.display_name || "");
      const pos = a?.author_position;
      return pos === "last" && nm && (nm === expertNorm || nm.includes(expertNorm) || expertNorm.includes(nm));
    });
  }).length;

  const avgCitations5y =
    last5y.length > 0
      ? last5y.reduce((s, w) => s + (w?.cited_by_count || 0), 0) / last5y.length
      : 0;

  return {
    recentPapers2y: last2y.length,
    papers5y: last5y.length,
    lastAuthor5y,
    avgCitations5y: avgCitations5y,
    influential5y: 0, // OpenAlex doesn't expose Semantic Scholar "influential" directly
  };
}

function scoreExpert({ papersMetrics, trialMetrics }) {
  // Metric weights:
  // - Citations / impact (via avg citations + influential papers) are now the strongest factor,
  //   so that highly cited global experts are ranked higher.
  // - Recency and trial leadership still matter but slightly less than before.
  const recency = clamp01(papersMetrics.recentPapers2y / 6); // 6+ recent papers => strong
  const trialLeadership = clamp01(trialMetrics.leadershipCount / 3); // 3+ PI trials => strong
  const status = clamp01(papersMetrics.lastAuthor5y / 4); // 4+ last author in 5y => strong

  // Impact proxy: avg citations + influential count (scaled)
  const impactRaw =
    clamp01(papersMetrics.avgCitations5y / 40) * 0.75 +
    clamp01(papersMetrics.influential5y / 5) * 0.25;
  const impact = clamp01(impactRaw);

  const final =
    recency * 0.25 + // was 0.3
    trialLeadership * 0.25 + // was 0.3
    status * 0.2 +
    impact * 0.3; // was 0.2

  return {
    scores: { recency, trialLeadership, status, impact },
    finalScore: clamp01(final),
  };
}

export async function searchVerifiedExpertsV2({
  q = "",
  location,
  limit = 10,
} = {}) {
  if (!q || !q.trim()) return [];

  const expertsQuery = location ? `${q.trim()} in ${location}` : `${q.trim()} global`;

  // Step 1: get candidate names (5–10) (Gemini can return 6; we allow up to 10 if expanded later)
  const candidates = await findResearchersWithGemini(expertsQuery);
  const names = Array.from(
    new Set(
      (candidates || [])
        .map((c) => c?.name)
        .filter(Boolean)
        .slice(0, Math.max(5, Math.min(10, limit)))
    )
  );

  // Step 2: verify via OpenAlex + Semantic Scholar, then score
  const verified = [];
  for (const name of names) {
    try {
      const [oaAuthor, ssAuthor] = await Promise.all([
        openAlexFindAuthorByName(name),
        semanticScholarFindAuthorByName(name),
      ]);

      // Must pass at least one verification source strongly; prefer both.
      if (!oaAuthor && !ssAuthor) continue;

      // Papers/works: prefer Semantic Scholar papers; fallback to OpenAlex works.
      let papersMetrics = {
        recentPapers2y: 0,
        papers5y: 0,
        lastAuthor5y: 0,
        avgCitations5y: 0,
        influential5y: 0,
      };

      const authorId = ssAuthor?.authorId;
      if (authorId) {
        const papers = await semanticScholarFetchRecentPapers(authorId, 40);
        papersMetrics = computeMetricsFromPapers(papers, name);
      } else if (oaAuthor?.id) {
        const works = await openAlexFetchRecentWorks(oaAuthor.id, 60);
        papersMetrics = computeMetricsFromOpenAlexWorks(works, name);
      }

      const trialMetrics = await estimateTrialLeadershipScore(name);
      const scored = scoreExpert({ papersMetrics, trialMetrics });

      verified.push({
        name,
        affiliation:
          ssAuthor?.affiliations?.[0] ||
          oaAuthor?.last_known_institution?.display_name ||
          null,
        location: candidates.find((c) => c?.name === name)?.location || null,
        verification: {
          openAlex: oaAuthor
            ? {
                id: oaAuthor.id,
                displayName: oaAuthor.display_name,
                worksCount: oaAuthor.works_count,
                citedByCount: oaAuthor.cited_by_count,
              }
            : null,
          semanticScholar: ssAuthor
            ? {
                authorId: ssAuthor.authorId,
                name: ssAuthor.name,
                paperCount: ssAuthor.paperCount,
                citationCount: ssAuthor.citationCount,
                hIndex: ssAuthor.hIndex,
                url: ssAuthor.url,
              }
            : null,
        },
        metrics: {
          recency: papersMetrics.recentPapers2y,
          trialLeadership: trialMetrics.leadershipCount,
          lastAuthor: papersMetrics.lastAuthor5y,
          journalImpactProxy: {
            avgCitations5y: Math.round(papersMetrics.avgCitations5y * 10) / 10,
            influential5y: papersMetrics.influential5y,
          },
        },
        weights: {
          recency: 0.3,
          trialLeadership: 0.3,
          statusLastAuthor: 0.2,
          journalImpact: 0.2,
        },
        scoreBreakdown: {
          ...scored.scores,
          finalScore: scored.finalScore,
        },
      });
    } catch {
      // skip candidate on any unexpected error
    }
  }

  // Step 3: sort by final score (desc), return top N
  verified.sort((a, b) => (b.scoreBreakdown?.finalScore || 0) - (a.scoreBreakdown?.finalScore || 0));
  return verified.slice(0, Math.max(5, Math.min(10, limit)));
}


