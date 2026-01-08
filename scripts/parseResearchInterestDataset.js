import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createReadStream } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read the XML file
const xmlPath = path.join(__dirname, '../../frontend/public/desc2024.xml');
console.log('Reading XML file...');

// For very large files, read the entire file (Node.js can handle it)
// If memory is an issue, we can switch to streaming later
let xmlContent;
try {
  xmlContent = fs.readFileSync(xmlPath, 'utf-8');
  console.log(`File size: ${(xmlContent.length / 1024 / 1024).toFixed(2)} MB`);
} catch (error) {
  console.error('Error reading file:', error);
  process.exit(1);
}

console.log('Parsing XML...');

// Parse XML using regex (more efficient for large files than full DOM parsing)
const data = [];
const descriptorPattern = /<DescriptorRecord[^>]*>([\s\S]*?)<\/DescriptorRecord>/g;
let match;
let count = 0;

while ((match = descriptorPattern.exec(xmlContent)) !== null) {
  const descriptorContent = match[1];
  
  // Extract DescriptorUI
  const uiMatch = descriptorContent.match(/<DescriptorUI>([^<]+)<\/DescriptorUI>/);
  if (!uiMatch) continue;
  const id = uiMatch[1].trim();
  
  // Extract DescriptorName
  const nameMatch = descriptorContent.match(/<DescriptorName>\s*<String>([^<]+)<\/String>\s*<\/DescriptorName>/);
  if (!nameMatch) continue;
  const term = nameMatch[1].trim();
  
  // Extract TreeNumbers
  const treeNumbers = [];
  const treeNumberPattern = /<TreeNumber>([^<]+)<\/TreeNumber>/g;
  let treeMatch;
  while ((treeMatch = treeNumberPattern.exec(descriptorContent)) !== null) {
    treeNumbers.push(treeMatch[1].trim());
  }
  
  // Extract ScopeNote from ConceptList (preferred concept)
  let scopeNote = '';
  const scopeNoteMatch = descriptorContent.match(/<ScopeNote>([\s\S]*?)<\/ScopeNote>/);
  if (scopeNoteMatch) {
    scopeNote = scopeNoteMatch[1].trim().replace(/\s+/g, ' ');
  }
  
  // Extract Synonyms (Terms that are not the preferred term)
  const synonyms = [];
  const termPattern = /<Term[^>]*>\s*<TermUI>[^<]+<\/TermUI>\s*<String>([^<]+)<\/String>[\s\S]*?<\/Term>/g;
  let termMatch;
  const preferredTermMatch = descriptorContent.match(/<Concept[^>]*PreferredConceptYN="Y"[^>]*>[\s\S]*?<ConceptName>\s*<String>([^<]+)<\/String>\s*<\/ConceptName>/);
  const preferredTerm = preferredTermMatch ? preferredTermMatch[1].trim() : term;
  
  while ((termMatch = termPattern.exec(descriptorContent)) !== null) {
    const synonym = termMatch[1].trim();
    // Only add if it's different from the preferred term and not too long (avoid chemical formulas)
    if (synonym !== preferredTerm && 
        synonym !== term && 
        synonym.length < 100 && 
        !synonym.includes('(') || synonym.includes(' ')) {
      // Avoid duplicates
      if (!synonyms.includes(synonym)) {
        synonyms.push(synonym);
      }
    }
  }
  
  // Extract Research Focus (AllowableQualifiers) - limit to first 10 most relevant
  const researchFocus = [];
  const qualifierPattern = /<AllowableQualifier>\s*<QualifierReferredTo>\s*<QualifierUI>([^<]+)<\/QualifierUI>\s*<QualifierName>\s*<String>([^<]+)<\/String>\s*<\/QualifierName>\s*<\/QualifierReferredTo>\s*<Abbreviation>([^<]+)<\/Abbreviation>\s*<\/AllowableQualifier>/g;
  let qualifierMatch;
  let qualifierCount = 0;
  
  while ((qualifierMatch = qualifierPattern.exec(descriptorContent)) !== null && qualifierCount < 10) {
    const qualifierId = qualifierMatch[1].trim();
    const label = qualifierMatch[2].trim();
    const abbreviation = qualifierMatch[3].trim();
    
    // Create UI label: "Term — label"
    const uiLabel = `${term} — ${label}`;
    
    researchFocus.push({
      qualifierId,
      label,
      abbreviation,
      uiLabel
    });
    qualifierCount++;
  }
  
  // Only include entries with at least a term and scope note
  if (term && scopeNote) {
    data.push({
      id,
      term,
      type: "mesh_descriptor",
      treeNumbers: treeNumbers.length > 0 ? treeNumbers : [],
      scopeNote,
      synonyms: synonyms.slice(0, 10), // Limit to 10 synonyms
      researchFocus: researchFocus.length > 0 ? researchFocus : []
    });
    
    count++;
    if (count % 1000 === 0) {
      console.log(`Processed ${count} descriptors...`);
    }
  }
}

console.log(`✅ Parsed ${data.length} descriptors`);

// Write to frontend data directory
const outputPath = path.join(__dirname, '../../frontend/src/data/researchInterestDataset.json');
const outputDir = path.dirname(outputPath);

// Create directory if it doesn't exist
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
console.log(`📁 Saved to: ${outputPath}`);
console.log(`📊 Total entries: ${data.length}`);

