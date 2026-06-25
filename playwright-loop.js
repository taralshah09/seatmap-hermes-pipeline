import { chromium } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

const client = new Anthropic();
const MAX_ITERATIONS = 6;
const SCORE_THRESHOLD = 0.85;

async function screenshotHTML(htmlPath) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });
  // file:// URLs need forward slashes even on Windows
  const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');
  await page.goto(fileUrl);
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
  "score": 0.0 to 1.0,
  "issues": [
    {
      "type": "missing_row" | "wrong_seat_range" | "wrong_row_label" | "missing_section" | "layout_angle" | "seat_count_mismatch",
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
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: originalData } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: currentData } },
        { type: 'text', text: DIFF_PROMPT }
      ]
    }]
  });

  const text = response.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(text);
  } catch {
    // Truncated response — extract score if present, treat rest as unknown issues
    const scoreMatch = text.match(/"score"\s*:\s*([\d.]+)/);
    const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0.5;
    console.warn('  Warning: diff JSON truncated, using partial parse fallback');
    return { score, issues: [], cssHints: [] };
  }
}

const PATCH_PROMPT = `
You are fixing specific issues in an HTML seating chart. Make SURGICAL changes only.

STRICT RULES:
- Do NOT change the overall layout structure (tier/column grid system)
- Do NOT add, remove, or rename CSS classes on .tier, .cell, .section divs
- Do NOT add transform/rotate/skew to .tier or .cell elements
- ONLY fix: seat number ranges, row labels, missing seats, CSS spacing/sizing values

Issues to fix:
ISSUES_PLACEHOLDER

CSS hints (spacing/sizing only):
CSS_HINTS_PLACEHOLDER

Return the COMPLETE corrected HTML. No markdown fences.

Current HTML:
HTML_PLACEHOLDER
`;

async function patchHTML(currentHTML, issues, cssHints = []) {
  const prompt = PATCH_PROMPT
    .replace('ISSUES_PLACEHOLDER', JSON.stringify(issues, null, 2))
    .replace('CSS_HINTS_PLACEHOLDER', cssHints.join('\n'))
    .replace('HTML_PLACEHOLDER', currentHTML);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0].text.trim().replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/, '');
}

export async function runPlaywrightLoop(originalImagePath, initialHTML, outputDir) {
  let currentHTML = initialHTML;
  let iteration = 0;
  let bestScore = 0;
  let bestHTML = initialHTML;
  let regressionCount = 0;

  fs.mkdirSync(outputDir, { recursive: true });

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    console.log(`\n── Iteration ${iteration} ──`);

    const htmlPath = path.join(outputDir, `seatmap-v${iteration}.html`);
    fs.writeFileSync(htmlPath, currentHTML, 'utf8');

    const screenshot = await screenshotHTML(path.resolve(htmlPath));
    const screenshotPath = path.join(outputDir, `screenshot-v${iteration}.png`);
    fs.writeFileSync(screenshotPath, screenshot);
    console.log(`Screenshot saved: ${screenshotPath}`);

    const diff = await diffWithClaude(originalImagePath, screenshot);
    console.log(`Score: ${diff.score} | Issues: ${diff.issues.length}`);

    // Track best iteration
    if (diff.score > bestScore) {
      bestScore = diff.score;
      bestHTML = currentHTML;
      regressionCount = 0;
    } else {
      regressionCount++;
      console.log(`  (regression #${regressionCount})`);
    }

    if (diff.score >= SCORE_THRESHOLD || diff.issues.length === 0) {
      console.log('Threshold met, stopping loop.');
      break;
    }

    // Stop if score has regressed 2 iterations in a row
    if (regressionCount >= 2) {
      console.log('Score regressing — stopping early, using best iteration.');
      break;
    }

    currentHTML = await patchHTML(currentHTML, diff.issues, diff.cssHints);
  }

  const finalPath = path.join(outputDir, 'seatmap-final.html');
  fs.writeFileSync(finalPath, bestHTML, 'utf8');
  console.log(`\nDone. Best score: ${bestScore}. Output: ${finalPath}`);
  return finalPath;
}
