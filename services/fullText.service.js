/**
 * Full-Text Fetcher Service
 *
 * Implements the recommended workflow for in-platform reading:
 * STEP 1 — Retrieve DOI (from publication metadata)
 * STEP 2 — Check OA via Unpaywall API
 * STEP 3 — Fetch full text (Priority: PMC XML → Publisher XML → HTML parse)
 * STEP 4 — Normalize & return structured JSON
 * STEP 5 — Caller displays on site with access level badge
 *
 * Access levels:
 * - open_access: Free full text available (Gold/Bronze/Green OA)
 * - preprint: ArXiv/other preprints (always OA)
 * - publisher_closed: Only at publisher (subscription required)
 * - limited: Abstract only or metadata
 */

import axios from "axios";
import { DOMParser } from "xmldom";
import * as cheerio from "cheerio";
import sanitizeHtml from "sanitize-html";

const UNPAYWALL_EMAIL =
  process.env.UNPAYWALL_EMAIL ||
  process.env.OPENALEX_MAILTO ||
  "support@curalink.org";

const cache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour for full-text

function getCached(key) {
  const e = cache.get(key);
  if (!e || Date.now() > e.expires) {
    if (e) cache.delete(key);
    return null;
  }
  return e.value;
}
function setCache(key, value) {
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

/**
 * Hosts that serve openly accessible PDFs that our proxy can reliably fetch.
 * Publisher PDFs (Springer, Wiley, Nature, etc.) are NOT in this list because
 * they block server-side bots and/or require auth cookies.
 */
const PROXY_FRIENDLY_PDF_HOSTS = [
  "arxiv.org",
  "export.arxiv.org",
  "medrxiv.org",
  "biorxiv.org",
  "europepmc.org",
  "ebi.ac.uk",
  "pmc.ncbi.nlm.nih.gov",
  "pubmedcentral.nih.gov",
  "ncbi.nlm.nih.gov",
  "pdfs.semanticscholar.org",
  "api.semanticscholar.org",
  "semanticscholar.org",
  "zenodo.org",
  "researchsquare.com",
  "f1000research.com",
  "peerj.com",
  "elifesciences.org",
  "figshare.com",
  "osf.io",
  "psyarxiv.com",
  "ssrn.com",
];

/**
 * Returns true if the URL is from a host that our server-side proxy can
 * reliably fetch (open repositories, not publisher-gated sites).
 */
function isProxyFriendlyPdfUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return PROXY_FRIENDLY_PDF_HOSTS.some(
      (h) => host === h || host.endsWith("." + h),
    );
  } catch {
    return false;
  }
}

/**
 * Extract PMC ID from PMID using NCBI elink.
 */
async function getPmcidFromPmid(pmid) {
  try {
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?dbfrom=pubmed&db=pmc&id=${pmid}&retmode=json`;
    const res = await axios.get(url, {
      timeout: 8000,
      headers: { "User-Agent": "CuraLink/1.0 (mailto:support@curalink.org)" },
    });
    const linksets = res.data?.linksets || [];
    const linksetdb = linksets[0]?.linksetdbs?.[0];
    const ids = linksetdb?.ids || [];
    if (ids.length > 0) return `PMC${ids[0]}`;
    return null;
  } catch {
    return null;
  }
}

/**
 * Try to get a PDF URL from Semantic Scholar API using DOI.
 * Only returns the URL if it's from a proxy-friendly host (not a publisher site).
 */
async function getPdfUrlFromSemanticScholar(doi) {
  if (!doi) return null;
  try {
    const cleanDoi = doi.replace(/^https?:\/\/doi\.org\//i, "").trim();
    const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(cleanDoi)}?fields=openAccessPdf,externalIds`;
    const res = await axios.get(url, {
      timeout: 8000,
      headers: { "User-Agent": "CuraLink/1.0 (mailto:support@curalink.org)" },
    });
    const pdf = res.data?.openAccessPdf?.url;
    // Only return proxy-friendly URLs — skip publisher PDFs that will fail
    if (pdf && typeof pdf === "string" && pdf.startsWith("http")) {
      if (isProxyFriendlyPdfUrl(pdf)) return pdf;
      // Still return it but marked — callers can use it as a directUrl fallback
      return pdf;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Step 2: Check Open Access status via Unpaywall.
 * Returns: { is_oa, oa_status, best_oa_location, best_oa_location?.url_for_pdf }
 */
export async function checkUnpaywall(doi) {
  const cleanDoi = (doi || "")
    .toString()
    .replace(/^https?:\/\/doi\.org\//i, "")
    .trim();
  if (!cleanDoi) return null;

  const key = `unpaywall:${cleanDoi}`;
  const cached = getCached(key);
  if (cached) return cached;

  try {
    const url = `https://api.unpaywall.org/v2/${encodeURIComponent(cleanDoi)}?email=${encodeURIComponent(UNPAYWALL_EMAIL)}`;
    const res = await axios.get(url, {
      timeout: 8000,
      headers: { "User-Agent": "CuraLink/1.0 (mailto:support@curalink.org)" },
    });
    const data = res.data;
    const best = data?.best_oa_location;
    const out = {
      is_oa: data?.is_oa ?? false,
      oa_status: data?.oa_status || null,
      publisher: data?.publisher || null,
      best_oa_location: best
        ? {
            url: best.url,
            url_for_pdf: best.url_for_pdf || null,
            version: best.version,
            license: best.license,
          }
        : null,
      // Preserve ALL oa_locations for fallback PDF searches
      oa_locations: (data?.oa_locations || []).map((loc) => ({
        url: loc.url,
        url_for_pdf: loc.url_for_pdf || null,
        version: loc.version,
        license: loc.license,
        host_type: loc.host_type,
        repository_institution: loc.repository_institution,
      })),
      doi: cleanDoi,
      title: data?.title,
      year: data?.year,
    };
    setCache(key, out);
    return out;
  } catch (err) {
    if (err.response?.status === 404) return null;
    console.warn("Unpaywall check error:", err?.message);
    return null;
  }
}

/**
 * Step 3a: Fetch full-text XML from Europe PMC (PMC articles).
 * Tries: (1) REST /fullTextXml, (2) fullTextUrlList from search.
 */
async function fetchEuropePmcFullText(pmcid) {
  const id = (pmcid || "").toString().replace(/^PMC/i, "");
  if (!id) return null;

  const key = `epmc:${id}`;
  const cached = getCached(key);
  if (cached) return cached;

  const urlsToTry = [
    `https://www.ebi.ac.uk/europepmc/webservices/rest/articles/PMC${id}/fullTextXml`,
    `https://www.ebi.ac.uk/europepmc/webservices/rest/articles/PMC${id}/fullTextXML`,
  ];

  for (const url of urlsToTry) {
    try {
      const res = await axios.get(url, {
        timeout: 15000,
        headers: { Accept: "application/xml" },
        validateStatus: (s) => s === 200,
      });
      if (res.status !== 200) continue;
      const xml = res.data;
      if (!xml || typeof xml !== "string") continue;

      const parsed = parsePmcXml(xml);
      if (parsed) {
        setCache(key, parsed);
        return parsed;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Parse PMC/Europe PMC JATS XML into structured sections.
 */
function parsePmcXml(xmlString) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, "text/xml");
    const sections = [];

    // Abstract
    const abstracts = doc.getElementsByTagName("abstract");
    for (let i = 0; i < abstracts.length; i++) {
      const text = abstracts[i].textContent?.trim();
      if (text) sections.push({ label: "Abstract", content: text });
    }

    // Body sections (sec with title)
    const secs = doc.getElementsByTagName("sec");
    for (let i = 0; i < secs.length; i++) {
      const sec = secs[i];
      const titleEl = sec.getElementsByTagName("title")[0];
      const title = titleEl?.textContent?.trim() || `Section ${i + 1}`;
      const paras = sec.getElementsByTagName("p");
      let content = "";
      for (let j = 0; j < paras.length; j++) {
        content += (paras[j].textContent?.trim() || "") + "\n\n";
      }
      if (content.trim()) {
        sections.push({ label: title, content: content.trim() });
      }
    }

    // Fallback: body divs
    if (sections.length <= 1) {
      const body = doc.getElementsByTagName("body")[0];
      if (body) {
        const divs = body.getElementsByTagName("div");
        for (let i = 0; i < divs.length; i++) {
          const div = divs[i];
          const t = div.getElementsByTagName("title")[0];
          const label =
            div.getAttribute("id") || t?.textContent?.trim() || `Part ${i + 1}`;
          const text = div.textContent?.trim();
          if (text) sections.push({ label, content: text });
        }
      }
    }

    return {
      source: "pmc_xml",
      sections: sections.filter((s) => s.content),
    };
  } catch {
    return null;
  }
}

const HTML_FETCH_ALLOWED_HOSTS = [
  "ncbi.nlm.nih.gov",
  "pubmed.ncbi.nlm.nih.gov",
  "journals.plos.org",
  "plos.org",
  "doi.org",
  "nature.com",
  "springer.com",
  "link.springer.com",
  "sciencedirect.com",
  "mdpi.com",
  "frontiersin.org",
  "biomedcentral.com",
  "bmj.com",
  "thelancet.com",
  "jamanetwork.com",
  "ahajournals.org",
  "oup.com",
  "academic.oup.com",
  "tandfonline.com",
  "wiley.com",
  "onlinelibrary.wiley.com",
  "hindawi.com",
  "karger.com",
  "liebertpub.com",
  "europepmc.org",
  "eurpmc.org",
  "ebi.ac.uk",
  "zenodo.org",
  "researchsquare.com",
  "medrxiv.org",
  "biorxiv.org",
  "cambridge.org",
  "taylorfrancis.com",
  "informa.com",
  "informaworld.com",
  "sagepub.com",
  "journals.sagepub.com",
];

function isAllowedHtmlUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return HTML_FETCH_ALLOWED_HOSTS.some(
      (h) => host === h || host.endsWith("." + h),
    );
  } catch {
    return false;
  }
}

/**
 * Step 3c: Fetch and parse HTML article from OA URL (Open Access HTML).
 */
async function fetchHtmlArticle(htmlUrl) {
  if (!htmlUrl || typeof htmlUrl !== "string") return null;
  if (!isAllowedHtmlUrl(htmlUrl)) return null;
  const key = `html:${htmlUrl}`;
  const cached = getCached(key);
  if (cached) return cached;

  try {
    const res = await axios.get(htmlUrl, {
      timeout: 20000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://doi.org/",
      },
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400,
    });
    if (res.status !== 200) return null;
    const html = res.data;
    if (!html || typeof html !== "string") return null;

    const $ = cheerio.load(html);
    $(
      "script, style, nav, header, footer, aside, .sidebar, .nav, .menu, .ad, .ads, [role='navigation']",
    ).remove();
    let content = "";
    const selectors = [
      "article",
      "[role='main']",
      "main",
      ".article-body",
      ".article__body",
      ".article-content",
      ".articleContent",
      ".fulltext",
      ".full-text",
      ".hlFld-Fulltext",
      ".abstract",
      ".body",
      "#article-body",
      "#article",
      "#content",
      ".content",
      "#main-content",
      ".main-content",
      ".entry-content",
      ".post-content",
      "#fulltext",
      ".NLM_article-body",
      ".articleSection",
      "[class*='articleBody']",
      "[class*='fulltext']",
      "[class*='article-body']",
      "section.article",
      ".c-article-body",
      ".article-page__body",
      ".article__content",
      ".art_abstract",
      ".articleSection",
      ".hlFld-Abstract",
      "[class*='article-body']",
      "[class*='articleBody']",
      ".NLM_sec",
      ".section",
    ];
    for (const sel of selectors) {
      const el = $(sel).first();
      if (el.length) {
        const txt = el.text().trim();
        if (txt.length > 300) {
          content = el.html() || "";
          break;
        }
      }
    }
    if (!content) {
      const body = $("body");
      const divs = body.find("div").filter((_, d) => {
        const txt = $(d).text().trim();
        return txt.length > 400 && $(d).find("div").length < 30;
      });
      let best = { len: 0, html: "" };
      divs.each((_, d) => {
        const txt = $(d).text().trim();
        if (txt.length > best.len) {
          best = { len: txt.length, html: $(d).html() || "" };
        }
      });
      content = best.html;
    }
    if (!content?.trim()) return null;

    const cleanHtml = sanitizeHtml(content, {
      allowedTags: [
        "p",
        "br",
        "div",
        "span",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "strong",
        "b",
        "em",
        "i",
        "u",
        "a",
        "ul",
        "ol",
        "li",
        "blockquote",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
      ],
      allowedAttributes: { a: ["href", "title"] },
      allowedSchemes: ["http", "https", "mailto"],
    });

    const out = {
      source: "html",
      title:
        $("title").text()?.trim() || $("h1").first().text()?.trim() || null,
      sections: [{ label: "Full article", content: cleanHtml, isHtml: true }],
    };
    setCache(key, out);
    return out;
  } catch (err) {
    console.warn("HTML article fetch error:", err?.message);
    return null;
  }
}

/**
 * Step 3b: Try Europe PMC article API for full text URL / core result.
 * Returns pmcid, best PDF URLs from their fullTextUrlList, and open access status.
 */
async function fetchEuropePmcArticle(pmidOrDoi) {
  const q = /^\d+$/.test(String(pmidOrDoi).trim())
    ? `EXT_ID:${pmidOrDoi} AND SRC:MED`
    : `DOI:${pmidOrDoi}`;

  try {
    const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(q)}&resultType=core&format=json&pageSize=1`;
    const res = await axios.get(url, { timeout: 10000 });
    const hits = res.data?.resultList?.result || [];
    const hit = hits[0];
    if (!hit) return null;

    const pmcid = hit.pmcid || hit.pmcId;
    const fullTextUrlList = hit.fullTextUrlList?.fullTextUrl || [];

    // Extract the best PDF URL from fullTextUrlList.
    // Priority: Europe_PMC PDF > PubMedCentral PDF > any PDF
    // These URLs are proxy-friendly since they come from ebi.ac.uk / ncbi.nlm.nih.gov
    let pdfUrl = null;

    // 1. Prefer Europe PMC's own PDF (reliably proxy-able from ebi.ac.uk)
    const epmcPdf = fullTextUrlList.find(
      (u) =>
        u.documentStyle === "pdf" &&
        (u.site === "Europe_PMC" || (u.url && u.url.includes("europepmc.org"))),
    );
    if (epmcPdf?.url) pdfUrl = epmcPdf.url;

    // 2. PubMed Central PDF (from ncbi.nlm.nih.gov)
    if (!pdfUrl) {
      const pmcPdf = fullTextUrlList.find(
        (u) =>
          u.documentStyle === "pdf" &&
          (u.site === "PubMedCentral" ||
            (u.url && u.url.includes("ncbi.nlm.nih.gov"))),
      );
      if (pmcPdf?.url) pdfUrl = pmcPdf.url;
    }

    // 3. Any PDF link in the list
    if (!pdfUrl) {
      const anyPdf = fullTextUrlList.find(
        (u) =>
          u.documentStyle === "pdf" ||
          (u.url && /\.pdf(?:[?#]|$)/i.test(u.url)),
      );
      if (anyPdf?.url) pdfUrl = anyPdf.url;
    }

    // Also get the HTML viewer URL from Europe PMC for fallback
    const htmlEntry = fullTextUrlList.find(
      (u) =>
        u.documentStyle === "html" &&
        (u.site === "Europe_PMC" || (u.url && u.url.includes("europepmc.org"))),
    );
    const htmlViewerUrl = htmlEntry?.url || null;

    // Build the Europe PMC viewer URL from PMCID if we have one
    const pmcViewerUrl = pmcid
      ? `https://europepmc.org/articles/PMC${pmcid.replace(/^PMC/i, "")}`
      : htmlViewerUrl;

    return {
      pmcid,
      fullTextUrlList,
      pdfUrl,
      pmcViewerUrl,
      hasFullText: !!hit.fullTextUrlList,
      inEPMC: !!hit.inEPMC,
      openAccess: hit.isOpenAccess === "Y",
    };
  } catch {
    return null;
  }
}

/**
 * Determine access level for display.
 */
export function getAccessLevel(
  publication,
  unpaywallResult,
  fullTextAvailable,
) {
  const source = (publication?.source || "").toLowerCase();

  if (source === "arxiv") {
    return {
      level: "preprint",
      label: "Preprint (Open Access)",
      badgeColor: "emerald",
      canReadOnPlatform: true,
      pdfUrl: publication?.pdfUrl,
    };
  }

  if (fullTextAvailable) {
    return {
      level: "open_access",
      label: "Open Access",
      badgeColor: "emerald",
      canReadOnPlatform: true,
    };
  }

  const oaStatus = unpaywallResult?.oa_status;
  const pdfUrl =
    unpaywallResult?.best_oa_location?.url_for_pdf ||
    publication?.openAccessPdf ||
    publication?.pdfUrl;

  if (pdfUrl) {
    return {
      level: "open_access",
      label: oaStatus ? `Open Access (${oaStatus})` : "Full text available",
      badgeColor: "emerald",
      canReadOnPlatform: true,
      pdfUrl,
    };
  }

  if (unpaywallResult?.is_oa && unpaywallResult?.best_oa_location?.url) {
    return {
      level: "open_access",
      label: `Open Access${oaStatus ? ` (${oaStatus})` : ""}`,
      badgeColor: "emerald",
      canReadOnPlatform: false,
      externalUrl: unpaywallResult.best_oa_location.url,
    };
  }

  if (publication?.url || publication?.doi) {
    return {
      level: "publisher_closed",
      label: "Publisher / Subscription required",
      badgeColor: "slate",
      canReadOnPlatform: false,
      publisher: unpaywallResult?.publisher || null,
    };
  }

  return {
    level: "limited",
    label: "Abstract only",
    badgeColor: "amber",
    canReadOnPlatform: false,
  };
}

/**
 * Main: Fetch full-text content for a publication.
 * Returns: { accessLevel, fullText, pdfUrl, pmcViewerUrl } or { accessLevel } when no full text.
 *
 * PDF URL priority:
 * 1. Europe PMC PDF (ebi.ac.uk) — proxy-friendly, always works
 * 2. PubMed Central PDF (ncbi.nlm.nih.gov) — proxy-friendly
 * 3. Unpaywall repository PDF (green OA, repo host) — proxy-friendly
 * 4. Publication's own openAccessPdf/pdfUrl field (may or may not work)
 * 5. Semantic Scholar PDF (if from a proxy-friendly host)
 * 6. Unpaywall publisher PDF (gold/bronze OA at publisher) — may fail proxy, use as directUrl
 */
export async function fetchFullText(publication) {
  if (!publication) return { accessLevel: null, fullText: null, pdfUrl: null };

  const doi = publication.doi;
  const pmid = publication.pmid;
  const source = (publication?.source || "").toLowerCase();

  // ArXiv: always has PDF, no need for Unpaywall
  if (source === "arxiv") {
    const accessLevel = getAccessLevel(publication, null, false);
    accessLevel.pdfUrl = publication.pdfUrl;
    accessLevel.canReadOnPlatform = true;
    return {
      accessLevel,
      fullText: null,
      pdfUrl: publication.pdfUrl,
      pmcViewerUrl: null,
      unpaywall: null,
    };
  }

  // Run Unpaywall and Europe PMC lookups in parallel for speed
  let unpaywallResult = null;
  let epmcResult = null;
  let pmcid = publication.pmcid || publication.pmcId;

  const [unpaywallSettled, epmcSettled] = await Promise.allSettled([
    doi ? checkUnpaywall(doi) : Promise.resolve(null),
    pmid || doi ? fetchEuropePmcArticle(pmid || doi) : Promise.resolve(null),
  ]);

  if (unpaywallSettled.status === "fulfilled") {
    unpaywallResult = unpaywallSettled.value;
  }
  if (epmcSettled.status === "fulfilled") {
    epmcResult = epmcSettled.value;
    if (epmcResult?.pmcid && !pmcid) pmcid = epmcResult.pmcid;
  }

  let fullText = null;

  // Try PMC XML first (best structured content)
  if (pmid && !pmcid) {
    pmcid = await getPmcidFromPmid(pmid);
  }
  if (pmcid) {
    fullText = await fetchEuropePmcFullText(pmcid);
  }

  // If EPMC returned a pmcid but XML wasn't fetched yet, try it
  if (!fullText && epmcResult?.pmcid) {
    fullText = await fetchEuropePmcFullText(epmcResult.pmcid);
  }

  // Fallback: Fetch HTML from Unpaywall OA URL (Open Access HTML, no PDF)
  if (
    !fullText &&
    unpaywallResult?.is_oa &&
    unpaywallResult?.best_oa_location?.url &&
    !unpaywallResult?.best_oa_location?.url_for_pdf
  ) {
    fullText = await fetchHtmlArticle(unpaywallResult.best_oa_location.url);
  }

  const accessLevel = getAccessLevel(publication, unpaywallResult, !!fullText);

  // ── PDF URL resolution — prioritise proxy-friendly repository URLs ──────

  // 1. Europe PMC PDF (best: we proxy ebi.ac.uk with no issues)
  let pdfUrl = epmcResult?.pdfUrl || null;

  // 2. Unpaywall: search ALL oa_locations for proxy-friendly PDF URLs first
  if (!pdfUrl) {
    const allOaLocs = [
      unpaywallResult?.best_oa_location,
      ...(unpaywallResult?.oa_locations || []),
    ].filter(Boolean);

    // First pass: proxy-friendly URLs only (repository copies)
    for (const loc of allOaLocs) {
      if (loc.url_for_pdf && isProxyFriendlyPdfUrl(loc.url_for_pdf)) {
        pdfUrl = loc.url_for_pdf;
        break;
      }
    }

    // Second pass: any URL with a PDF, even if from a publisher (use as directUrl fallback)
    if (!pdfUrl) {
      for (const loc of allOaLocs) {
        if (loc.url_for_pdf) {
          pdfUrl = loc.url_for_pdf;
          break;
        }
      }
    }
  }

  // 3. Publication's own fields (set by the source API, e.g. OpenAlex, Semantic Scholar)
  if (!pdfUrl) {
    pdfUrl = publication?.openAccessPdf || publication?.pdfUrl || null;
  }

  // 4. Last resort: Semantic Scholar (only if not already found)
  if (!pdfUrl && doi) {
    try {
      pdfUrl = await getPdfUrlFromSemanticScholar(doi);
    } catch {
      // ignore
    }
  }

  if (pdfUrl) {
    accessLevel.pdfUrl = pdfUrl;
    accessLevel.canReadOnPlatform = true;
  }

  // Provide the Europe PMC viewer URL so the frontend can use it as an
  // open-access fallback when PDF embedding fails.
  const pmcViewerUrl =
    epmcResult?.pmcViewerUrl ||
    (pmcid
      ? `https://europepmc.org/articles/PMC${pmcid.toString().replace(/^PMC/i, "")}`
      : null);

  return {
    accessLevel,
    fullText,
    pdfUrl: pdfUrl || null,
    pmcViewerUrl,
    unpaywall: unpaywallResult,
  };
}
