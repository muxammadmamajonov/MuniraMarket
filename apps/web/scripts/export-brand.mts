/**
 * Writes the MuniraMarket logo files to `public/brand/` from the shared geometry in
 * `src/brand/munira-mark.ts`, then renders PNGs of them with Playwright's Chromium.
 *
 *   pnpm --filter @muniramarket/web exec node scripts/export-brand.mts
 *
 * Re-run after changing the mark; commit the output. Flat 2D, the sign's deep red, charcoal and
 * white. Lettering uses a heavy system sans laid out with `textLength`, so its width is fixed
 * wherever it renders; only the letter shapes can differ where those fonts are missing, which is
 * why the PNGs are the reference for print and social use.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { BRAND_HEX, TAGLINE, markSvgBody } from '../src/brand/munira-mark.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'brand');
const FONT = "'Arial Black','Helvetica Neue',Arial,'Segoe UI',system-ui,sans-serif";

/** The mark's canvas is 58 units square, starting at y = -10 (see MARK_VIEWBOX). */
const MARK_SIZE = 58;
const MARK_TOP = -10;

interface Asset {
  name: string;
  width: number;
  height: number;
  svg: string;
  /** PNG pixel widths to render. */
  png: number[];
}

const svg = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(w)} ${String(h)}" width="${String(w)}" height="${String(h)}" role="img" aria-label="MuniraMarket"><title>MuniraMarket</title>${body}</svg>\n`;

const mark = (x: number, y: number, size: number, color: string, id: string) => {
  const scale = size / MARK_SIZE;
  return `<g transform="translate(${String(x)} ${String(y - MARK_TOP * scale)}) scale(${String(scale)})">${markSvgBody(color, id)}</g>`;
};

/** `textLength` fixes the word's width whatever heavy sans the viewer substitutes. */
const word = (
  text: string,
  x: number,
  y: number,
  w: number,
  size: number,
  fill: string,
  weight = 900,
) =>
  `<text x="${String(x)}" y="${String(y)}" textLength="${String(w)}" lengthAdjust="spacingAndGlyphs" font-family="${FONT}" font-weight="${String(weight)}" font-size="${String(size)}" fill="${fill}">${text}</text>`;

const bar = (x: number, y: number, w: number, h = 7) =>
  `<rect x="${String(x)}" y="${String(y)}" width="${String(w)}" height="${String(h)}" rx="${String(h / 2)}" fill="${BRAND_HEX.red}"/>`;

/** Horizontal lockup like the shop sign: mark, MUNIRA MARKET, red bars around the tagline. */
function horizontal(onDark: boolean): string {
  const second = onDark ? BRAND_HEX.white : BRAND_HEX.charcoal;
  return (
    mark(0, 0, 132, BRAND_HEX.red, 'h') +
    word('MUNIRA', 140, 84, 250, 66, BRAND_HEX.red) +
    word('MARKET', 404, 84, 242, 66, second) +
    bar(140, 103, 40) +
    word(TAGLINE, 190, 112, 404, 17, second, 800) +
    bar(604, 103, 42) +
    bar(190, 122, 404, 5)
  );
}

/** Round badge on near-black, like the shop's profile picture: mark over the sign lockup. */
const badge = () =>
  `<circle cx="256" cy="256" r="256" fill="${BRAND_HEX.nearBlack}"/>` +
  mark(166, 84, 184, BRAND_HEX.red, 'b') +
  word('MUNIRA', 52, 322, 200, 54, BRAND_HEX.red) +
  word('MARKET', 264, 322, 196, 54, BRAND_HEX.white) +
  bar(52, 342, 36, 6) +
  word(TAGLINE, 96, 352, 320, 14, BRAND_HEX.white, 800) +
  bar(424, 342, 36, 6) +
  bar(118, 370, 276, 6);

/** App icon: white mark on a deep-red rounded square (home screen, Telegram bot avatar). */
const appIcon = () =>
  `<rect width="512" height="512" rx="112" fill="${BRAND_HEX.red}"/>` +
  mark(72, 72, 368, BRAND_HEX.white, 'i');

const markOnly = (color: string) => `<g transform="translate(0 10)">${markSvgBody(color, 'm')}</g>`;

const assets: Asset[] = [
  {
    name: 'munira-mark',
    width: 58,
    height: 58,
    svg: svg(58, 58, markOnly(BRAND_HEX.red)),
    png: [512, 1024],
  },
  {
    name: 'munira-mark-white',
    width: 58,
    height: 58,
    svg: svg(58, 58, markOnly(BRAND_HEX.white)),
    png: [512, 1024],
  },
  {
    name: 'munira-logo-horizontal',
    width: 660,
    height: 132,
    svg: svg(660, 132, horizontal(false)),
    png: [1320, 2640],
  },
  {
    name: 'munira-logo-horizontal-on-dark',
    width: 660,
    height: 132,
    svg: svg(660, 132, horizontal(true)),
    png: [1320, 2640],
  },
  {
    name: 'munira-logo-badge',
    width: 512,
    height: 512,
    svg: svg(512, 512, badge()),
    png: [512, 1024],
  },
  {
    name: 'munira-app-icon',
    width: 512,
    height: 512,
    svg: svg(512, 512, appIcon()),
    png: [180, 192, 512],
  },
];

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  for (const asset of assets) {
    await writeFile(join(OUT, `${asset.name}.svg`), asset.svg);
    for (const px of asset.png) {
      const page = await browser.newPage({
        viewport: { width: asset.width, height: asset.height },
        deviceScaleFactor: px / asset.width,
      });
      await page.setContent(
        `<html><body style="margin:0;background:transparent">${asset.svg}</body></html>`,
      );
      await page.locator('svg').screenshot({
        path: join(OUT, `${asset.name}-${String(px)}.png`),
        omitBackground: true,
      });
      await page.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`Wrote ${String(assets.length)} logos to ${OUT}`);
