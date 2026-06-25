import 'dotenv/config';
import { pdfToImage, normalizeImage } from './preprocess.js';
import { extractSeatLayout } from './extract.js';
import { renderSeatmapHTML } from './render.js';
import { runPlaywrightLoop } from './playwright-loop.js';
import { orientSections } from './orient.js';
import path from 'path';
import fs from 'fs';

// One full pass of the vision pipeline (extract -> render -> loop -> orient)
// into `runDir`. Steps 2, 4 and 5 are non-deterministic vision calls, so each
// pass lands differently — running several and comparing yields better results.
async function runPipelineOnce(imagePath, runDir, label) {
  fs.mkdirSync(runDir, { recursive: true });

  // Step 2: extract seat layout JSON via Claude Vision
  console.log(`\n[${label}] Step 2: Extracting seat layout...`);
  const layout = await extractSeatLayout(imagePath);
  console.log(`[${label}] Found ${layout.sections.length} sections, layout type: ${layout.venue?.layout}`);

  const jsonPath = path.join(runDir, 'layout.json');
  fs.writeFileSync(jsonPath, JSON.stringify(layout, null, 2), 'utf8');
  console.log(`[${label}] Layout JSON saved: ${jsonPath}`);

  // Step 3: generate initial HTML from JSON
  console.log(`[${label}] Step 3: Generating initial HTML...`);
  const initialHTML = renderSeatmapHTML(layout);

  // Step 4: run the Playwright visual feedback loop
  console.log(`[${label}] Step 4: Running Playwright feedback loop...`);
  const finalPath = await runPlaywrightLoop(imagePath, initialHTML, runDir);

  // Step 5: re-orient sections into their true 2D arrangement
  console.log(`[${label}] Step 5: Re-orienting sections...`);
  const sections = layout.sections.map(s => ({ id: s.id, label: s.label }));
  const orientedPath = await orientSections(imagePath, finalPath, sections, runDir);

  return { runDir, finalPath, orientedPath };
}

export async function hermesAgent(inputPath, outputDir = './output', runs = 3) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const ext = path.extname(inputPath).toLowerCase();

  // Step 1: normalize to PNG — done once, shared across all runs
  console.log('Step 1: Normalizing input...');
  let imagePath = inputPath;
  if (ext === '.pdf') {
    imagePath = await pdfToImage(inputPath);
  }
  imagePath = await normalizeImage(imagePath);
  console.log(`Normalized image: ${imagePath}`);

  fs.mkdirSync(outputDir, { recursive: true });

  // Single-run mode: write straight into outputDir (original behavior).
  if (runs <= 1) {
    const { orientedPath } = await runPipelineOnce(imagePath, outputDir, 'run-1');
    return orientedPath;
  }

  // Multi-run mode: each pass goes into its own run-N/ subfolder so the
  // results sit side by side for comparison (no auto-pick).
  console.log(`\nMulti-run mode: generating ${runs} independent runs...`);
  const results = [];
  for (let i = 1; i <= runs; i++) {
    const label = `run-${i}`;
    const runDir = path.join(outputDir, label);
    console.log(`\n===== ${label} (${i}/${runs}) =====`);
    try {
      results.push(await runPipelineOnce(imagePath, runDir, label));
    } catch (err) {
      console.error(`[${label}] failed:`, err.message);
      results.push({ runDir, error: err.message });
    }
  }

  console.log('\n===== All runs complete =====');
  for (const r of results) {
    console.log(r.error ? `  ${r.runDir} — FAILED: ${r.error}` : `  ${r.orientedPath}`);
  }
  console.log('\nCompare the run-N/seatmap-oriented.html files and keep the best.');
  return results;
}

// CLI entry point: node hermes-agent.js <input> [outputDir] [runs]
const args = process.argv.slice(2);
if (args.length > 0) {
  const inputPath = args[0];
  const outputDir = args[1] || './output';
  const runs = args[2] ? parseInt(args[2], 10) : 3;
  hermesAgent(inputPath, outputDir, runs)
    .then(result => {
      if (Array.isArray(result)) {
        console.log(`\nDone — ${result.length} runs in ${outputDir}`);
      } else {
        console.log(`\nFinal seatmap: ${result}`);
      }
    })
    .catch(err => { console.error(err); process.exit(1); });
}
