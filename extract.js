import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';

const client = new Anthropic();

// Compact format prompt — uses seat ranges "1-20" instead of [1,2,...,20]
// This cuts output tokens by ~10x for dense seating charts.
const EXTRACTION_PROMPT = `
You are analyzing a theater/venue seating chart image.

Extract the complete seating layout as JSON with this exact schema:

{
  "venue": {
    "totalSections": number,
    "layout": "fan" | "rectangular" | "curved" | "multi-level",
    "stagePosition": "top" | "bottom"
  },
  "sections": [
    {
      "id": string,
      "label": "display name from image",
      "angle": number (degrees from center: 0=straight, negative=left, positive=right),
      "rows": [
        {
          "rowId": "A",
          "seats": "1-20",
          "gaps": "4,8",
          "special": {
            "wheelchair": "1-2",
            "companion": "",
            "restricted": "",
            "unlabeled": "U"
          }
        }
      ]
    }
  ]
}

SEAT FORMAT RULES (critical — saves tokens):
- Use compact range strings for seats: "1-20" means seats 1 through 20
- For non-contiguous ranges use commas: "1-3,6-20" means 1,2,3,6,7,...,20
- For gaps/special fields use same compact format, or "" if empty
- For unlabeled seats use the actual label shown (e.g. "U" or "W")

OTHER RULES:
- Capture EVERY visible seat number, do not skip any
- Rows run alphabetically A-Z, then AA, BB etc — note the exact letters shown
- Note any seats labeled U, W, or with wheelchair icons
- If left and right sections mirror each other, still list both separately
- Note the curvature direction (rows curving toward stage = concave)
- stagePosition: "top" if stage appears at top of image, "bottom" if at bottom

Return ONLY the JSON, no markdown, no explanation.
`;

// Expand compact seat range string to number array
// e.g. "1-5,8,10-15" → [1,2,3,4,5,8,10,11,12,13,14,15]
function expandRange(value) {
  if (!value && value !== 0) return [];
  if (Array.isArray(value)) return value; // already expanded (old format)
  const str = String(value).trim();
  if (!str) return [];
  return str.split(',').flatMap(part => {
    part = part.trim();
    if (!part) return [];
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(s => s.trim());
      const na = Number(a), nb = Number(b);
      if (!isNaN(na) && !isNaN(nb)) {
        return Array.from({ length: nb - na + 1 }, (_, i) => na + i);
      }
    }
    const n = Number(part);
    return [isNaN(n) ? part : n];
  });
}

// Normalise a parsed layout — expand all compact range fields
function normaliseLayout(layout) {
  for (const section of layout.sections ?? []) {
    for (const row of section.rows ?? []) {
      row.seats = expandRange(row.seats);
      row.gaps  = expandRange(row.gaps);
      const sp = row.special ?? {};
      sp.wheelchair = expandRange(sp.wheelchair);
      sp.companion  = expandRange(sp.companion);
      sp.restricted = expandRange(sp.restricted);
      // unlabeled: keep as string or array of strings
      if (typeof sp.unlabeled === 'string') {
        sp.unlabeled = sp.unlabeled ? sp.unlabeled.split(',').map(s => s.trim()).filter(Boolean) : [];
      }
      row.special = sp;
    }
  }
  return layout;
}

function parseJSON(raw) {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(text);
}

export async function extractSeatLayout(imagePath) {
  const imageData = fs.readFileSync(imagePath).toString('base64');

  // First attempt: standard 8192 tokens
  let response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } },
        { type: 'text', text: EXTRACTION_PROMPT }
      ]
    }]
  });

  console.log(`  stop_reason: ${response.stop_reason}, tokens used: ${response.usage?.output_tokens}`);

  // If truncated, retry with extended output via beta header
  if (response.stop_reason === 'max_tokens') {
    console.log('  Output truncated — retrying with extended output (16k tokens)...');
    response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } },
          { type: 'text', text: EXTRACTION_PROMPT }
        ]
      }]
    }, {
      headers: { 'anthropic-beta': 'max-tokens-3-5-sonnet-2024-07-15' }
    });
    console.log(`  Retry stop_reason: ${response.stop_reason}, tokens used: ${response.usage?.output_tokens}`);
  }

  const layout = parseJSON(response.content[0].text);
  return normaliseLayout(layout);
}

// Targeted re-extraction for a single section using a cropped image
export async function reExtractSection(imagePath, sectionHint, cropOptions) {
  const sharp = (await import('sharp')).default;
  const cropped = await sharp(imagePath).extract(cropOptions).toBuffer();
  const imageData = cropped.toString('base64');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } },
        { type: 'text', text: EXTRACTION_PROMPT + '\nFocus only on the "' + sectionHint + '" section.' }
      ]
    }]
  });

  const layout = parseJSON(response.content[0].text);
  return normaliseLayout(layout);
}
