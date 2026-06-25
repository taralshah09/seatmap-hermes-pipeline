import 'dotenv/config';
import { chromium } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

const client = new Anthropic();

const MAX_ORIENT_ITERATIONS = 4;
const ORIENT_THRESHOLD = 0.9;

// Canvas the sections are absolutely positioned within (px).
// Matches the 1400-wide Playwright viewport used for screenshots.
// Tall enough to stack: stage (top) → orchestras → balconies (bottom).
const CANVAS = { w: 1360, h: 960 };

async function screenshotHTML(htmlPath) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });
  const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');
  await page.goto(fileUrl);
  await page.waitForLoadState('networkidle');
  const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
  await browser.close();
  return screenshot;
}

const ORIENT_PROMPT = `
You are producing a CANONICAL 2D layout of a seating chart.

Image 1: the ORIGINAL reference (source of truth for the spatial RELATIONSHIPS
         between sections — which are near the stage, which are far, left vs right)
Image 2: the CURRENT HTML render (what we generated)

Ignore seat numbers, row labels and seat-level accuracy entirely — those are
already handled. Decide ONLY the 2D position of each element.

Output a CANONICAL layout with these rules:
- The STAGE is ALWAYS at the TOP-CENTRE: x≈0.5, y≈0.04 (regardless of where the
  stage appears in Image 1).
- Sections CLOSEST to the stage in Image 1 (the main orchestra / floor sections)
  sit just BELOW the stage (small y, around 0.30–0.40).
- Sections FARTHEST from the stage in Image 1 (balconies / mezzanine / rear)
  sit LOWER DOWN (larger y, around 0.60–0.75).
- Preserve LEFT/RIGHT order from Image 1: the central/largest section stays
  centred (x≈0.5); left-side sections x<0.4; right-side sections x>0.6.
- "scale" (0.4–1.3): make small sections (balconies) ~0.8 and the large central
  section ~1.0 to match the reference proportions.

Coordinate frame for the OUTPUT:
  x: 0.0 = far left, 1.0 = far right
  y: 0.0 = top (stage), 1.0 = bottom

Return JSON only:
{
  "score": 0.0 to 1.0,          // how well Image 2 ALREADY matches this canonical target
  "done": true | false,          // true if arrangement already matches (no change needed)
  "placements": [
    { "id": "stage",         "x": 0.50, "y": 0.04, "scale": 1.0 },
    { "id": "center",        "x": 0.50, "y": 0.34, "scale": 1.0 },
    { "id": "left-balcony",  "x": 0.12, "y": 0.66, "scale": 0.8 }
  ],
  "notes": "short reasoning about what moved"
}

Every id from the provided list (INCLUDING "stage") MUST appear exactly once.
Return ONLY the JSON, no markdown.
`;

function parseJSON(raw) {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(text);
  } catch {
    const scoreMatch = text.match(/"score"\s*:\s*([\d.]+)/);
    const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0.5;
    console.warn('  Warning: orient JSON truncated, using partial fallback');
    return { score, done: false, placements: [], notes: 'parse-failed' };
  }
}

async function diffOrientation(originalImagePath, screenshotBuffer, sections) {
  const originalData = fs.readFileSync(originalImagePath).toString('base64');
  const currentData = screenshotBuffer.toString('base64');
  const sectionList = sections.map(s => `- ${s.id}: "${s.label}"`).join('\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: originalData } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: currentData } },
        { type: 'text', text: ORIENT_PROMPT + '\nSections:\n' + sectionList }
      ]
    }]
  });

  return parseJSON(response.content[0].text);
}

// Base CSS that turns .map into the absolute-positioning canvas. Shared by the
// renderer-time build and the in-browser editor's save() so a saved file
// reproduces the exact same layout system.
const ORIENT_BASE_CSS =
`.map{position:relative;display:block;width:${CANVAS.w}px;height:${CANVAS.h}px;margin:0 auto 20px;flex-wrap:nowrap;}
.map [data-sec]{position:absolute;}
.map .stage{margin:0;}`;

// Build the CSS that absolutely-positions each element (sections + stage) by
// its centre within the canvas.
function buildOrientCSS(placements) {
  const rules = placements.map(p => {
    const x = (Math.max(0, Math.min(1, p.x)) * 100).toFixed(2);
    const y = (Math.max(0, Math.min(1, p.y)) * 100).toFixed(2);
    const scale = p.scale ? Math.max(0.3, Math.min(1.5, p.scale)) : 1;
    return `[data-sec="${p.id}"]{left:${x}%;top:${y}%;transform:translate(-50%,-50%) scale(${scale});}`;
  }).join('\n');

  return `${ORIENT_BASE_CSS}\n${rules}`;
}

// Move the stage into the .map canvas (once) and tag it so the orientation CSS
// can position it like any other element. The stage starts outside .map in the
// renderer output; here it becomes a positionable child sharing the canvas.
function prepareCanvas(html) {
  if (html.includes('data-sec="stage"')) return html;
  const stage = '<div class="stage" data-sec="stage">STAGE</div>';
  return html
    .replace(/<div class="stage">\s*STAGE\s*<\/div>/i, '')
    .replace('<div class="map">', `<div class="map">${stage}`);
}

// Inject the interactive editor into the output. Two modes:
//  - Arrange (default): every [data-sec] element (sections + stage) is
//    free-draggable; the auto-orientation is the starting arrangement.
//  - Delete: tap seats (or a row/section label) to mark them, then
//    "Delete selected" removes them; empty rows/sections are dropped and the
//    remaining seats reflow automatically.
// "Save layout" bakes positions back into #orient-style and downloads the HTML
// (with any deletions already reflected in the DOM).
export function injectEditor(html) {
  const editorCSS = `<style id="editor-style">
#editor-bar{position:fixed;top:12px;left:12px;z-index:9999;display:flex;gap:8px;align-items:center;background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:8px 12px;box-shadow:0 2px 8px rgba(0,0,0,.12);font:12px sans-serif;}
#editor-bar button{font:600 12px sans-serif;padding:6px 12px;border-radius:6px;border:1px solid #1f6feb;background:#1f6feb;color:#fff;cursor:pointer;}
#editor-bar button.ghost{background:#fff;color:#1f6feb;}
#editor-bar button.danger{background:#ef4444;border-color:#ef4444;}
#editor-bar button:disabled{opacity:.45;cursor:not-allowed;}
#editor-bar .hint{color:#666;max-width:320px;}
.map [data-sec]{cursor:move;}
.map [data-sec].dragging{outline:2px dashed #1f6feb;outline-offset:3px;opacity:.92;}
body.dragging-active{user-select:none;}
body.delete-mode .map [data-sec]{cursor:default;}
body.delete-mode .map .seat,body.delete-mode .map .rl,body.delete-mode .map .sl{cursor:pointer;}
.map .seat.to-delete{background:#ef4444 !important;border-color:#b91c1c !important;color:#fff !important;opacity:1 !important;}
</style>`;

  const editorJS = `<script>
(function(){
  var BASE_CSS=${JSON.stringify(ORIENT_BASE_CSS)};
  var map=document.querySelector('.map'); if(!map) return;
  var mode='arrange';
  var active=null,gx=0,gy=0,moved=false,suppress=false;
  function center(el){var r=el.getBoundingClientRect(),m=map.getBoundingClientRect();return {x:r.left+r.width/2-m.left,y:r.top+r.height/2-m.top};}
  function scaleOf(el){try{return (new DOMMatrixReadOnly(getComputedStyle(el).transform)).a||1;}catch(e){return 1;}}
  function marks(){return map.querySelectorAll('.seat.to-delete');}
  function setMark(seats,on){[].forEach.call(seats,function(s){s.classList.toggle('to-delete',on);});}
  function anyUnmarked(seats){return [].some.call(seats,function(s){return !s.classList.contains('to-delete');});}

  // ---- drag (arrange mode) ----
  map.addEventListener('pointerdown',function(e){
    if(mode!=='arrange') return;
    var el=e.target.closest('[data-sec]'); if(!el) return;
    active=el; moved=false;
    var m=map.getBoundingClientRect(),c=center(el);
    gx=e.clientX-(m.left+c.x); gy=e.clientY-(m.top+c.y);
    el.style.left=c.x+'px'; el.style.top=c.y+'px';
    el.classList.add('dragging'); document.body.classList.add('dragging-active');
    e.preventDefault();
  });
  window.addEventListener('pointermove',function(e){
    if(!active) return;
    var m=map.getBoundingClientRect();
    var x=Math.max(0,Math.min(m.width,e.clientX-m.left-gx));
    var y=Math.max(0,Math.min(m.height,e.clientY-m.top-gy));
    active.style.left=x+'px'; active.style.top=y+'px'; moved=true;
  });
  window.addEventListener('pointerup',function(){
    if(!active) return;
    active.classList.remove('dragging'); document.body.classList.remove('dragging-active');
    if(moved) suppress=true; active=null;
  });

  // ---- selection (delete mode) + drag-click suppression ----
  map.addEventListener('click',function(e){
    if(suppress){e.stopPropagation();e.preventDefault();suppress=false;return;}
    if(mode!=='delete') return;
    var seat=e.target.closest('.seat'), rl=e.target.closest('.rl'), sl=e.target.closest('.sl');
    if(seat){e.stopPropagation();e.preventDefault();seat.classList.toggle('to-delete');}
    else if(rl){e.stopPropagation();e.preventDefault();var rs=rl.closest('.row').querySelectorAll('.seat');setMark(rs,anyUnmarked(rs));}
    else if(sl){e.stopPropagation();e.preventDefault();var ss=sl.closest('[data-sec]').querySelectorAll('.seat');setMark(ss,anyUnmarked(ss));}
    updateCount();
  },true);

  function applyDelete(){
    [].forEach.call(marks(),function(s){s.remove();});
    map.querySelectorAll('.row').forEach(function(row){var sw=row.querySelector('.sw');if(!sw||sw.querySelectorAll('.seat').length===0)row.remove();});
    map.querySelectorAll('[data-sec]').forEach(function(sec){if(sec.classList.contains('stage'))return;if(sec.querySelectorAll('.seat').length===0)sec.remove();});
    updateCount();
  }

  // ---- save ----
  function save(){
    var m=map.getBoundingClientRect(),rules='';
    map.querySelectorAll('[data-sec]').forEach(function(el){
      var c=center(el),x=(c.x/m.width*100).toFixed(2),y=(c.y/m.height*100).toFixed(2),s=scaleOf(el);
      rules+='[data-sec="'+el.dataset.sec+'"]{left:'+x+'%;top:'+y+'%;transform:translate(-50%,-50%) scale('+s+');}\\n';
    });
    var os=document.getElementById('orient-style');
    if(!os){os=document.createElement('style');os.id='orient-style';document.head.appendChild(os);}
    os.textContent='\\n'+BASE_CSS+'\\n'+rules;
    map.querySelectorAll('[data-sec]').forEach(function(el){el.style.left='';el.style.top='';});
    var out='<!DOCTYPE html>\\n'+document.documentElement.outerHTML;
    var a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([out],{type:'text/html'}));
    a.download='seatmap-final.html'; a.click();
  }

  // ---- toolbar ----
  var bar=document.createElement('div'); bar.id='editor-bar';
  var hint=document.createElement('span'); hint.className='hint'; hint.textContent='Drag sections to rearrange';
  var delToggle=document.createElement('button'); delToggle.className='ghost'; delToggle.textContent='Delete mode';
  var delApply=document.createElement('button'); delApply.className='danger'; delApply.textContent='Delete selected'; delApply.disabled=true;
  var saveBtn=document.createElement('button'); saveBtn.textContent='Save layout';
  function updateCount(){var n=marks().length; delApply.disabled=(mode!=='delete'||n===0); delApply.textContent='Delete selected'+(n?' ('+n+')':'');}
  delToggle.addEventListener('click',function(){
    if(mode==='delete'){mode='arrange';document.body.classList.remove('delete-mode');delToggle.className='ghost';hint.textContent='Drag sections to rearrange';setMark(marks(),false);}
    else{mode='delete';document.body.classList.add('delete-mode');delToggle.className='danger';hint.textContent='Tap seats, or a row/section label, to mark — then Delete selected';}
    updateCount();
  });
  delApply.addEventListener('click',applyDelete);
  saveBtn.addEventListener('click',save);
  bar.appendChild(hint); bar.appendChild(delToggle); bar.appendChild(delApply); bar.appendChild(saveBtn);
  document.body.appendChild(bar);
})();
</` + `script>`;

  return html
    .replace('</head>', `${editorCSS}\n</head>`)
    .replace('</body>', `${editorJS}\n</body>`);
}

// Inject (or replace) the orientation style block. Placed last in <head> so it
// overrides the renderer's flex layout without touching any seat-level markup.
function applyOrientation(html, placements) {
  const block = `<style id="orient-style">\n${buildOrientCSS(placements)}\n</style>`;
  if (html.includes('id="orient-style"')) {
    return html.replace(/<style id="orient-style">[\s\S]*?<\/style>/, block);
  }
  return html.replace('</head>', `${block}\n</head>`);
}

/**
 * Re-orientation step: looks at the final render vs the original image and
 * repositions the sections into their true 2D arrangement.
 *
 * @param {string} originalImagePath  reference image (the input seatmap)
 * @param {string} finalHtmlPath      HTML produced by the playwright loop
 * @param {Array}  sections           [{id,label}] from layout.json
 * @param {string} outputDir          where to write screenshots + result
 * @returns {string} path to the oriented HTML
 */
export async function orientSections(originalImagePath, finalHtmlPath, sections, outputDir) {
  let currentHTML = prepareCanvas(fs.readFileSync(finalHtmlPath, 'utf8'));
  let bestHTML = currentHTML;
  let bestScore = -1;
  let iteration = 0;

  // The stage is positioned alongside the sections in the canonical layout.
  const placeable = [...sections, { id: 'stage', label: 'STAGE (the performance area)' }];

  fs.mkdirSync(outputDir, { recursive: true });

  while (iteration < MAX_ORIENT_ITERATIONS) {
    iteration++;
    console.log(`\n── Orient iteration ${iteration} ──`);

    const htmlPath = path.join(outputDir, `orient-v${iteration}.html`);
    fs.writeFileSync(htmlPath, currentHTML, 'utf8');

    const screenshot = await screenshotHTML(path.resolve(htmlPath));
    fs.writeFileSync(path.join(outputDir, `orient-screenshot-v${iteration}.png`), screenshot);

    const diff = await diffOrientation(originalImagePath, screenshot, placeable);
    console.log(`  Orientation score: ${diff.score}${diff.notes ? ` | ${diff.notes}` : ''}`);

    // >= so that on tied scores the more-refined later iteration wins (the
    // canonical target never literally matches the raw input, so scores plateau).
    if (diff.score >= bestScore) {
      bestScore = diff.score;
      bestHTML = currentHTML;
    }

    if (diff.done || diff.score >= ORIENT_THRESHOLD) {
      console.log('  Orientation matches reference, stopping.');
      break;
    }

    if (!diff.placements || diff.placements.length === 0) {
      console.log('  No placements returned, stopping.');
      break;
    }

    currentHTML = applyOrientation(currentHTML, diff.placements);
  }

  const orientedPath = path.join(outputDir, 'seatmap-oriented.html');
  fs.writeFileSync(orientedPath, injectEditor(bestHTML), 'utf8');
  console.log(`\nOrientation done. Best score: ${bestScore}. Output: ${orientedPath}`);
  return orientedPath;
}

// CLI: node orient.js <originalImage> <finalHtmlPath> <outputDir> [layoutJson]
const args = process.argv.slice(2);
if (args.length >= 3) {
  const [originalImage, finalHtmlPath, outputDir] = args;
  const layoutJson = args[3] || path.join(outputDir, 'layout.json');
  const layout = JSON.parse(fs.readFileSync(layoutJson, 'utf8'));
  const sections = layout.sections.map(s => ({ id: s.id, label: s.label }));
  orientSections(originalImage, finalHtmlPath, sections, outputDir)
    .then(p => console.log(`\nOriented seatmap: ${p}`))
    .catch(err => { console.error(err); process.exit(1); });
}
