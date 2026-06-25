import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';

const client = new Anthropic();

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
      "id": "center" | "left" | "right" | "balcony" | "mezzanine" | string,
      "label": "display name from image",
      "angle": number (degrees from center, 0 = straight, negative = left, positive = right),
      "rows": [
        {
          "rowId": "A",
          "seats": [1, 2, 3, ...],
          "gaps": [4],
          "special": {
            "wheelchair": [1, 2],
            "companion": [],
            "restricted": [],
            "unlabeled": ["U"]
          }
        }
      ]
    }
  ]
}

Also capture per-seat pricing tier/color if seats are color-coded (e.g. red, blue, orange zones):
- Add "tier": "premium" | "standard" | "economy" | string to each seat entry when color zones are visible
- If all seats are the same color, omit the tier field

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
    max_tokens: 8192,
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

  console.log(`  stop_reason: ${response.stop_reason}, tokens used: ${response.usage?.output_tokens}`);
  const raw = response.content[0].text.trim();
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(text);
}

// Targeted re-extraction for a specific section when initial score is low
export async function reExtractSection(imagePath, sectionHint, cropOptions) {
  const sharp = (await import('sharp')).default;
  const cropped = await sharp(imagePath)
    .extract(cropOptions)
    .toBuffer();

  const imageData = cropped.toString('base64');
  const focusedPrompt = EXTRACTION_PROMPT + `\nFocus only on the "${sectionHint}" section.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } },
        { type: 'text', text: focusedPrompt }
      ]
    }]
  });

  return JSON.parse(response.content[0].text.trim());
}
