# Full Architecture Pipeline and Walkthrough

Here's the full approach broken into each stage for the Interactive Seatmap & Booking System AI Pipeline (Hermes).

## Stage 1: Pre-process the input
Before Claude Vision touches anything, normalize the input to a high-resolution PNG (even from a PDF). Playwright's screenshot quality is 1:1 pixel-matched, so your input should be too.

```javascript
// preprocess.js
import { chromium } from 'playwright';
import sharp from 'sharp';
import { exec } from 'child_process';

async function pdfToImage(pdfPath) {
  // pdftoppm (poppler) gives clean rasterization
  exec(`pdftoppm -r 200 -png ${pdfPath} /tmp/seatmap`);
  return '/tmp/seatmap-1.png'; // first page
}

async function normalizeImage(imagePath) {
  return sharp(imagePath)
    .resize({ width: 2400, withoutEnlargement: true })
    .png()
    .toFile('/tmp/seatmap-normalized.png');
}
```

## Stage 2: Extraction prompt (the most critical stage)
This is where accuracy lives or dies. You need to send the image to Claude with a very structured prompt and get back JSON you can reliably render.

```javascript
// extract.js
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';

const client = new Anthropic();

const EXTRACTION_PROMPT = `
You are analyzing a theater/venue seating chart image.

Extract the complete seating layout as JSON with this exact schema:

{
  "venue": {
    "totalSections": number,
    "layout": "fan" | "rectangular" | "curved" | "multi-level"
  },
  "sections": [
    {
      "id": "center" | "left" | "right" | "balcony" | "mezzanine" | string,
      "label": "display name from image",
      "angle": number (degrees from center, 0 = straight, negative = left, positive = right),
      "rows": [
        {
          "rowId": "A",
          "seats": [1, 2, 3, ...],    // actual seat numbers visible
          "gaps": [4],                  // seat numbers that are MISSING (aisles)
          "special": {
            "wheelchair": [1, 2],
            "companion": [],
            "restricted": [],
            "unlabeled": ["U"]          // any U or similar non-number seats
          }
        }
      ]
    }
  ]
}

IMPORTANT RULES:
- Capture EVERY visible seat number, do not skip any
- Rows run alphabetically A-Z, then AA, BB etc — note the exact letters shown
- If a row has numbers like [7,8,9,10...20], list them all explicitly
- Note any seats labeled U, W, or with wheelchair icons
- If left and right sections mirror each other, still list both separately
- Note the curvature direction (rows curving toward stage = concave)
- List gaps/aisles as missing seat numbers within a row range

Return ONLY the JSON, no markdown, no explanation.
`;

export async function extractSeatLayout(imagePath) {
  const imageData = fs.readFileSync(imagePath).toString('base64');
  
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: imageData }
        },
        { type: 'text', text: EXTRACTION_PROMPT }
      ]
    }]
  });

  return JSON.parse(response.content[0].text);
}
```

## Stage 3: HTML generator from JSON
This converts the structured JSON into an HTML seatmap. The key here is replicating the curvature and angle of the original, not just the seat labels.

```javascript
// generate.js
export function generateSeatmapHTML(layout) {
  const sectionHtml = layout.sections.map(section => {
    const rowsHtml = section.rows.map(row => {
      const seatsHtml = row.seats.map(seatNum => {
        const isWheelchair = row.special?.wheelchair?.includes(seatNum);
        const cls = isWheelchair ? 'seat wheelchair' : 'seat';
        return `<button class="${cls}" data-row="${row.rowId}" data-seat="${seatNum}"
                  title="${row.rowId}${seatNum}">${seatNum}</button>`;
      }).join('');

      return `
        <div class="row" data-row-id="${row.rowId}">
          <span class="row-label">${row.rowId}</span>
          <div class="seats">${seatsHtml}</div>
          <span class="row-label">${row.rowId}</span>
        </div>`;
    }).join('');

    const angleStyle = section.angle 
      ? `transform: rotate(${section.angle}deg); transform-origin: center bottom;` 
      : '';

    return `
      <div class="section" id="section-${section.id}" style="${angleStyle}">
        <div class="section-label">${section.label}</div>
        ${rowsHtml}
      </div>`;
  }).join('');

  return \`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { background: #fff; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; }
  .seatmap { display: flex; gap: 12px; justify-content: center; padding: 40px 20px; position: relative; }
  .stage { width: 300px; height: 40px; background: #222; color: #fff; text-align: center;
           line-height: 40px; border-radius: 4px; margin: 0 auto 24px; font-size: 13px; letter-spacing: 2px; }
  .section { display: flex; flex-direction: column; align-items: center; gap: 3px; }
  .section-label { font-size: 11px; font-weight: 600; color: #555; margin-bottom: 6px; text-transform: uppercase; }
  .row { display: flex; align-items: center; gap: 4px; }
  .row-label { font-size: 10px; font-weight: 600; color: #888; width: 18px; text-align: center; }
  .seats { display: flex; gap: 2px; }
  .seat { width: 20px; height: 20px; border-radius: 4px; border: 1px solid #ccc;
          background: #e8f4fd; font-size: 8px; cursor: pointer; color: #333;
          display: flex; align-items: center; justify-content: center; transition: background 0.15s; }
  .seat:hover { background: #3b82f6; color: #fff; }
  .seat.selected { background: #1d4ed8; color: #fff; border-color: #1d4ed8; }
  .seat.wheelchair { background: #fef3c7; border-color: #f59e0b; }
  .curved-row { /* applied per-row via JS for curvature */ }
</style>
</head>
<body>
  <div class="stage">STAGE</div>
  <div class="seatmap">
    \${sectionHtml}
  </div>
<script>
  document.querySelectorAll('.seat').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('selected');
    });
  });

  // Apply row curvature — rows closer to stage get more curve
  document.querySelectorAll('.section').forEach(section => {
    const rows = section.querySelectorAll('.row');
    rows.forEach((row, i) => {
      const curvePx = (rows.length - i) * 0.4; // front rows curve more
      row.style.marginTop = \\\`-\\\${curvePx}px\\\`;
    });
  });
</script>
</body>
</html>\`;
}
```

## Stage 4: The Playwright feedback loop (the core of Hermes)
This is the iterative loop. Each pass: screenshot → diff with Claude → patch → repeat.

```javascript
// playwright-loop.js
import { chromium } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';

const client = new Anthropic();
const MAX_ITERATIONS = 6;
const SCORE_THRESHOLD = 0.85;

async function screenshotHTML(htmlPath) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(\`file://\${htmlPath}\`);
  await page.waitForLoadState('networkidle');
  const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
  await browser.close();
  return screenshot;
}

const DIFF_PROMPT = `
You are comparing two seating chart images side by side.
Image 1: the ORIGINAL reference (source of truth)
Image 2: the CURRENT HTML render (what we generated)

Identify specific discrepancies and return JSON:

{
  "score": 0.0 to 1.0,   // overall similarity (1.0 = perfect match)
  "issues": [
    {
      "type": "missing_row" | "wrong_seat_range" | "wrong_row_label" |
              "missing_section" | "layout_angle" | "seat_count_mismatch",
      "section": "center",
      "row": "D",
      "detail": "Row D should start at seat 10, currently starts at 8",
      "fix": "In section center, row D, seats should be [10,11,12...20] not [8,9...20]"
    }
  ],
  "cssHints": [
    "center section needs 8deg left rotation",
    "row spacing too wide, reduce gap to 2px"
  ]
}

Be precise about seat numbers. Check row labels carefully.
Return ONLY the JSON.
`;

async function diffWithClaude(originalImagePath, screenshotBuffer) {
  const originalData = fs.readFileSync(originalImagePath).toString('base64');
  const currentData = screenshotBuffer.toString('base64');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: originalData } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: currentData } },
        { type: 'text', text: DIFF_PROMPT }
      ]
    }]
  });

  return JSON.parse(response.content[0].text);
}

const PATCH_PROMPT = `
Given this HTML seatmap and these issues found by visual comparison, 
output ONLY the corrected HTML with all issues fixed.

Issues to fix:
ISSUES_PLACEHOLDER

Current HTML:
HTML_PLACEHOLDER

Apply all fixes precisely. Return only valid HTML, no markdown.
`;

async function patchHTML(currentHTML, issues) {
  const prompt = PATCH_PROMPT
    .replace('ISSUES_PLACEHOLDER', JSON.stringify(issues, null, 2))
    .replace('HTML_PLACEHOLDER', currentHTML);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0].text;
}

export async function runPlaywrightLoop(originalImagePath, initialHTML, outputDir) {
  let currentHTML = initialHTML;
  let iteration = 0;
  let finalScore = 0;

  fs.mkdirSync(outputDir, { recursive: true });

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    console.log(\`\\n── Iteration \${iteration} ──\`);

    // 1. Write current HTML to disk
    const htmlPath = \`\${outputDir}/seatmap-v\${iteration}.html\`;
    fs.writeFileSync(htmlPath, currentHTML);

    // 2. Screenshot it with Playwright
    const screenshot = await screenshotHTML(path.resolve(htmlPath));
    fs.writeFileSync(\`\${outputDir}/screenshot-v\${iteration}.png\`, screenshot);

    // 3. Diff against original
    const diff = await diffWithClaude(originalImagePath, screenshot);
    console.log(\`Score: \${diff.score} | Issues: \${diff.issues.length}\`);
    finalScore = diff.score;

    if (diff.score >= SCORE_THRESHOLD || diff.issues.length === 0) {
      console.log('Threshold met, stopping loop.');
      break;
    }

    // 4. Patch the HTML based on diff
    currentHTML = await patchHTML(currentHTML, diff.issues);
  }

  // Write final output
  const finalPath = \`\${outputDir}/seatmap-final.html\`;
  fs.writeFileSync(finalPath, currentHTML);
  console.log(\`\\nDone. Final score: \${finalScore}. Output: \${finalPath}\`);
  return finalPath;
}
```

## Stage 5: The Hermes agent orchestrator
This ties all four stages together into a single callable pipeline.

```javascript
// hermes-agent.js
import { pdfToImage, normalizeImage } from './preprocess.js';
import { extractSeatLayout } from './extract.js';
import { generateSeatmapHTML } from './generate.js';
import { runPlaywrightLoop } from './playwright-loop.js';
import path from 'path';

export async function hermesAgent(inputPath, outputDir = './output') {
  const ext = path.extname(inputPath).toLowerCase();

  // Step 1: normalize to PNG
  console.log('Step 1: Normalizing input...');
  let imagePath = inputPath;
  if (ext === '.pdf') imagePath = await pdfToImage(inputPath);
  await normalizeImage(imagePath);
  imagePath = '/tmp/seatmap-normalized.png';

  // Step 2: extract seat layout JSON
  console.log('Step 2: Extracting seat layout...');
  const layout = await extractSeatLayout(imagePath);
  console.log(\`Found \${layout.sections.length} sections\`);

  // Step 3: generate initial HTML
  console.log('Step 3: Generating HTML...');
  const initialHTML = generateSeatmapHTML(layout);

  // Step 4: run the Playwright feedback loop
  console.log('Step 4: Playwright loop...');
  const finalPath = await runPlaywrightLoop(imagePath, initialHTML, outputDir);

  return finalPath;
}

// Run it
hermesAgent('./seating-arrangement.pdf', './output');
```

## Key things that make this work well

1. **Extraction accuracy is the biggest lever.** The prompt in Stage 2 should be re-run with a stricter follow-up if you get a low initial score:
```javascript
// If first extraction is incomplete, do a targeted re-extraction
async function reExtractSection(imagePath, sectionHint) {
  // Crop the image to just that section using sharp, then re-run
  // This is 10x more accurate than asking Claude to see the full map again
  const cropped = await sharp(imagePath)
    .extract({ left: 0, top: 200, width: 400, height: 300 })
    .toBuffer();
  // ... send cropped to extraction
}
```

2. **Playwright viewport matters.** Match your screenshot size to roughly what a user would see in a browser, not the full document height, so Claude's diff comparison is meaningful at scale.

3. **Score calibration:** start your threshold at 0.75 for a first pass, then raise to 0.85. Trying to hit 0.95+ in the loop leads to over-patching and regression. Accept the remaining 5-15% as manual polish.

4. **Iteration history:** save every screenshot to disk so you can inspect where the loop diverged. The diff at iteration 2-3 is usually the most revealing.