import { execSync } from 'child_process';
import sharp from 'sharp';
import os from 'os';
import path from 'path';
import fs from 'fs';

const TMP = os.tmpdir();

export async function pdfToImage(pdfPath) {
  const outPrefix = path.join(TMP, 'seatmap');
  // pdftoppm (poppler) gives clean rasterization at 200 DPI
  execSync(`pdftoppm -r 200 -png "${pdfPath}" "${outPrefix}"`);
  const candidate = `${outPrefix}-1.png`;
  if (!fs.existsSync(candidate)) throw new Error(`pdftoppm did not produce ${candidate}`);
  return candidate;
}

export async function normalizeImage(imagePath) {
  const outPath = path.join(TMP, 'seatmap-normalized.png');
  await sharp(imagePath)
    .resize({ width: 2400, withoutEnlargement: true })
    .png()
    .toFile(outPath);
  return outPath;
}
