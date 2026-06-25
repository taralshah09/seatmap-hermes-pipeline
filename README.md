# Seatmap Hermes Agent

AI-powered pipeline that turns a seating-chart **image or PDF** into an
**interactive, editable HTML seatmap** — using Claude Vision to read the chart, a
headless-browser visual feedback loop to self-correct the render, and a final
in-browser editor for human polish.

---

## Overview

Venues (theaters, stadiums, arenas) usually publish their seatmaps only as
images or PDFs — not as structured, bookable data. Re-digitizing each chart into
HTML by hand is slow and error-prone.

**Hermes** automates this. Point it at a seatmap image and it produces a
pixel-faithful, interactive seatmap where every seat is a clickable element, with
correct seat numbers, special-seat types (wheelchair / companion / restricted),
and the true 2D spatial arrangement of sections.

The deliverable is a **single self-contained HTML file** — all interactivity
(booking, drag-to-arrange, rotate, add/delete seats, undo/redo) is embedded at
generation time. No backend or framework is needed to use the output.

Because the vision steps are non-deterministic, the agent runs the full pipeline
**N independent times** and lays the results side by side for comparison.

---

## Approach

The agent runs a **5-stage pipeline**, with two self-correcting feedback loops
(a visual-accuracy loop and a spatial-orientation loop) that use Claude Vision to
compare renders against the original image and iteratively fix discrepancies.

<img width="663" height="688" alt="image" src="https://github.com/user-attachments/assets/73a72e12-19dd-4a4d-8008-f3b9c27c1a29" />

--- 

**Stage breakdown**

1. **Preprocess** — Rasterize PDFs (`pdftoppm`, 200 DPI) and normalize to a
   2400px-wide PNG so the render screenshot is 1:1 pixel-comparable.
2. **Extract** — Send the image to Claude Vision with a strict prompt; get back a
   structured JSON layout (sections → rows → seats + special types). Seats use a
   compact range encoding (`"1-20"`) to cut output tokens ~10x; truncated
   responses retry at a higher token budget.
3. **Render** — Pure JSON→HTML conversion into a clickable seatmap with
   colour-coded seat types.
4. **Visual feedback loop** — Screenshot the render with headless Chromium, have
   Claude diff it against the original (returning a similarity score + concrete
   issues), then apply surgical patches. Repeats up to 6 times or until the score
   crosses the threshold; keeps the **best** iteration and stops early on
   regression.
5. **Orient** — A second loop repositions sections into a canonical 2D
   arrangement (stage at top-center, near-stage sections high, balconies lower,
   left/right order preserved), then injects the interactive editor and writes the
   final HTML.

---

## Important files

| File | Purpose |
|---|---|
| `hermes-agent.js` | **Orchestrator & CLI entry point.** Runs the full 5-stage pipeline, supports single-run and multi-run modes. |
| `preprocess.js` | Stage 1 — PDF→PNG conversion (`pdftoppm`) and image normalization (`sharp`). |
| `extract.js` | Stage 2 — Claude Vision extraction of the layout JSON, with compact-range expansion, token-limit retry, and targeted per-section re-extraction. |
| `render.js` | Stage 3 — Pure function converting the layout JSON into the initial interactive HTML seatmap. |
| `playwright-loop.js` | Stage 4 — The visual feedback loop: screenshot → Claude diff → patch, with best-of-N tracking and regression/truncation guards. |
| `orient.js` | Stage 5 — Canonical 2D re-orientation of sections **plus** the injected in-browser editor (drag, rotate, add/delete rows & seats, undo/redo, save). |
| `run-from-json.js` | Utility — re-render + run the visual loop from an existing `layout.json`, skipping extraction (useful for debugging Stages 3–4). |
| `PLAN.md` | Original design narrative (predates the code in places — trust the source for current behaviour). |
| `input/` | Sample seating-chart images/PDFs for testing. |
| `output/` | Generated artifacts per input: `layout.json`, per-iteration HTML + screenshots, and the final `seatmap-oriented.html`. |

---

## Running the pipeline

### Prerequisites

- Node.js (ESM)
- An Anthropic API key
- `pdftoppm` (poppler) on your PATH — only required for PDF inputs

### Setup

```bash
npm install
npm run install-browsers          # installs Playwright's Chromium
```

Create a `.env` file with your API key:

```
ANTHROPIC_API_KEY=sk-ant-...
```

### Run

```bash
# Full pipeline:  node hermes-agent.js <input> [outputDir] [runs]
node hermes-agent.js ./input/input-1.png ./output 3
```

- `<input>` — path to a seatmap `.png` or `.pdf`
- `[outputDir]` — output directory (default: `./output`)
- `[runs]` — number of independent pipeline passes (default: `3`)

**Single run** (writes straight into `outputDir`):

```bash
node hermes-agent.js ./input/input-1.png ./output 1
```

**Re-run from an existing layout** (skip extraction):

```bash
node run-from-json.js <layout.json> <outputDir> [normalizedImage.png]
```

**Run the orientation + editor stage standalone:**

```bash
node orient.js <originalImage> <finalHtml> <outputDir> [layoutJson]
```

### Output

Each run produces, under `output/<input>/run-N/`:

```
layout.json                 # extracted seat structure
seatmap-v1..v6.html         # each visual-loop iteration
screenshot-v1..v6.png       # what Claude diffed each pass
seatmap-final.html          # best visual-loop result
orient-v1..v4.html          # orientation iterations
seatmap-oriented.html       # FINAL deliverable — interactive + editor
```

Open `seatmap-oriented.html` in a browser, arrange/edit as needed, and use
**Save layout** to download the polished standalone file. With multi-run mode,
compare the `seatmap-oriented.html` from each `run-N/` and keep the best.
