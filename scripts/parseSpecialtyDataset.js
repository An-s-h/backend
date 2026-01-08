import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read the CSV file
const csvPath = path.join(__dirname, '../data/nucc_taxonomy_251.csv');
const csv = fs.readFileSync(csvPath, 'utf-8');
const lines = csv.split('\n');

// Parse CSV (handling quoted fields)
function parseCSVLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

const data = [];
const seen = new Set(); // To avoid duplicates

// Skip header row
for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;
  
  const values = parseCSVLine(line);
  
  if (values.length >= 5) {
    const classification = values[2]?.trim() || '';
    const specialization = values[3]?.trim() || '';
    const definition = values[4]?.trim() || '';
    
    // Only include entries with classification and definition
    if (classification && definition) {
      // Create a unique key to avoid duplicates
      const key = `${classification}|${specialization}`;
      
      if (!seen.has(key)) {
        seen.add(key);
        
        // Format display text: "Specialization - Classification" or just "Classification"
        const displayText = specialization 
          ? `${specialization} - ${classification}`
          : classification;
        
        data.push({
          classification,
          specialization,
          definition,
          displayText
        });
      }
    }
  }
}

// Write to frontend data directory
const outputPath = path.join(__dirname, '../../frontend/src/data/specialtyDataset.json');
const outputDir = path.dirname(outputPath);

// Create directory if it doesn't exist
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
console.log(`✅ Dataset created with ${data.length} entries`);
console.log(`📁 Saved to: ${outputPath}`);

