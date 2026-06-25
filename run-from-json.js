import 'dotenv/config';
import { renderSeatmapHTML } from './render.js';
import { runPlaywrightLoop } from './playwright-loop.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

const [,, layoutPath, outputDir, imagePath] = process.argv;

const layout = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
const initialHTML = renderSeatmapHTML(layout);
const imgPath = imagePath || path.join(os.tmpdir(), 'seatmap-normalized.png');

console.log('Starting Playwright loop with improved layout...');
const finalPath = await runPlaywrightLoop(imgPath, initialHTML, outputDir);
console.log('Final:', finalPath);
