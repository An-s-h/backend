/**
 * Builds a flat JSON array of MeSH terms + synonyms from researchInterestDataset.json
 * for use in Experts page search: suggestions + autocorrect.
 * Run from repo root: node server/scripts/buildMeshSearchTerms.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const inputPath = path.join(__dirname, '../../frontend/src/data/researchInterestDataset.json');
const outputPath = path.join(__dirname, '../../frontend/src/data/meshSearchTerms.json');

const MAX_TERM_LENGTH = 70;
// Skip chemical-style strings; keep terms useful for condition/expertise search
function isReasonableForSearch(s) {
  if (!s || typeof s !== 'string') return false;
  const t = s.trim();
  if (t.length < 3 || t.length > MAX_TERM_LENGTH) return false;
  // Skip formula-like: starts with ( or digit, or "Letter 12345" pattern
  if (/^[\(\d]/.test(t)) return false;
  if (/^[A-Za-z]\s+[\d\.]+$/.test(t)) return false; // e.g. "A 127722"
  if (t.length > 45 && !t.includes(' ')) return false;
  if (/^[0-9\-,\s]+$/.test(t)) return false;
  if (t.length > 35 && !/^[A-Za-z]/.test(t)) return false;
  return true;
}

console.log('Reading', inputPath);
const data = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));

const seen = new Set();
const terms = [];

for (const item of data) {
  if (item.term && isReasonableForSearch(item.term)) {
    const key = item.term.trim().toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      terms.push(item.term.trim());
    }
  }
  if (Array.isArray(item.synonyms)) {
    for (const syn of item.synonyms) {
      if (isReasonableForSearch(syn)) {
        const t = syn.trim();
        const key = t.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          terms.push(t);
        }
      }
    }
  }
}

// Sort for consistent output and slightly better compression
terms.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

fs.writeFileSync(outputPath, JSON.stringify(terms));
console.log('Wrote', outputPath, '—', terms.length, 'terms');
console.log('Sample:', terms.slice(0, 10));
