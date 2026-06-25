import 'dotenv/config';
import { pdfToImage, normalizeImage } from './preprocess.js';
import { extractSeatLayout } from './extract.js';
import { generateSeatmapHTML } from './generate.js';
import { runPlaywrightLoop } from './playwright-loop.js';
import path from 'path';
import fs from 'fs';

export async function hermesAgent(inputPath, outputDir = './output') {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const ext = path.extname(inputPath).toLowerCase();

  // Step 1: normalize to PNG
  console.log('Step 1: Normalizing input...');
  let imagePath = inputPath;
  if (ext === '.pdf') {
    imagePath = await pdfToImage(inputPath);
  }
  imagePath = await normalizeImage(imagePath);
  console.log(`Normalized image: ${imagePath}`);

  // Step 2: extract seat layout JSON via Claude Vision
  console.log('\nStep 2: Extracting seat layout...');
  const layout = await extractSeatLayout(imagePath);
  console.log(`Found ${layout.sections.length} sections, layout type: ${layout.venue?.layout}`);

  // Save extracted JSON for inspection
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, 'layout.json');
  fs.writeFileSync(jsonPath, JSON.stringify(layout, null, 2), 'utf8');
  console.log(`Layout JSON saved: ${jsonPath}`);

  // Step 3: generate initial HTML from JSON
  console.log('\nStep 3: Generating initial HTML...');
  const initialHTML = generateSeatmapHTML(layout);

  // Step 4: run the Playwright visual feedback loop
  console.log('\nStep 4: Running Playwright feedback loop...');
  const finalPath = await runPlaywrightLoop(imagePath, initialHTML, outputDir);

  return finalPath;
}

// CLI entry point: node hermes-agent.js <input> [outputDir]
const args = process.argv.slice(2);
if (args.length > 0) {
  const inputPath = args[0];
  const outputDir = args[1] || './output';
  hermesAgent(inputPath, outputDir)
    .then(p => console.log(`\nFinal seatmap: ${p}`))
    .catch(err => { console.error(err); process.exit(1); });
}
