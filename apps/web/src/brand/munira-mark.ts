/**
 * MuniraMarket logo geometry and rendering: the single source of truth for the mark. A flat 2D
 * redraw of the shop sign: a shopping cart (grip, frame, three thick basket slats, base rail, two
 * wheels) with two leaves growing out of the basket. The right leaf is about twice the size of
 * the left one (1.5x as long, so roughly 2.25x the area) and lies out to the right; the left one
 * stands up and leans left.
 *
 * The React component (`components/wordmark.tsx`) and the exported files in `public/brand/`
 * (`scripts/export-brand.mts`) both render `markSvgBody`; nothing is traced from a photo or
 * shipped as a raster crop. One flat colour; the leaf midribs are cut out so the background
 * shows through.
 */

/** Square canvas with room above the cart for the leaves. */
export const MARK_VIEWBOX = '0 -10 58 58';

type Point = readonly [number, number];

const n = (value: number) => String(Math.round(value * 100) / 100);

/**
 * A leaf from `base` to `tip`: two cubic curves bulging either side of the axis, the upper side a
 * little fuller, a pointed tip and a narrow base. The midrib is a gentle curve, as on the sign.
 */
function leaf(base: Point, tip: Point, width: number): { shape: string; midrib: string } {
  const [bx, by] = base;
  const vx = tip[0] - bx;
  const vy = tip[1] - by;
  const length = Math.hypot(vx, vy);
  // Unit normal, pointing to the left of the base->tip direction.
  const nx = -vy / length;
  const ny = vx / length;
  const at = (t: number, side: number) =>
    `${n(bx + vx * t + nx * side)} ${n(by + vy * t + ny * side)}`;
  const shape =
    `M${n(bx)} ${n(by)}` +
    `C${at(0.18, width * 0.66)} ${at(0.68, width * 0.6)} ${n(tip[0])} ${n(tip[1])}` +
    `C${at(0.66, -width * 0.52)} ${at(0.2, -width * 0.5)} ${n(bx)} ${n(by)}z`;
  const midrib = `M${at(0.16, 0)}Q${at(0.5, width * 0.16)} ${at(0.84, width * 0.04)}`;
  return { shape, midrib };
}

// Left leaf: smaller, standing up and leaning left. Right leaf: about twice its size, lying out
// to the right. Their bases meet in a V just above the middle of the rim.
const LEFT_LEAF = leaf([27.4, 14.6], [18.6, -1.6], 10);
const RIGHT_LEAF = leaf([30, 14.6], [52.2, -3], 15);

/** Bar with round ends (basket slat) as a path. */
const slat = (x: number, y: number, w: number, h: number) => {
  const r = h / 2;
  return `M${n(x + r)} ${n(y)}H${n(x + w - r)}a${n(r)} ${n(r)} 0 0 1 0 ${n(h)}H${n(x + r)}a${n(r)} ${n(r)} 0 0 1 0-${n(h)}z`;
};

const circle = (cx: number, cy: number, r: number) =>
  `M${n(cx - r)} ${n(cy)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0-${n(2 * r)} 0z`;

/** Line weight of the cart: one weight everywhere, like the sign's routed letters. */
const W = 3.4;

/** Frame: from the end of the grip (9, 10) down the diagonal; x at height y. */
const frameX = (y: number) => 9 + (y - 10) * 0.26;
/** Right wall of the basket: from (46, 15.6) down to (42, 33.4); x at height y. */
const wallX = (y: number) => 46 - (y - 15.6) * (4 / 17.8);

/**
 * The three slats: thick bars filling the basket, each running into the right wall; their left
 * ends are rounded and step right with the diagonal frame, leaving a gap to it.
 */
const SLAT_H = 3.2;
const SLATS = [20.1, 24.5, 28.9].map((centre) => {
  const left = frameX(centre) + W / 2 + 2.3;
  return slat(left, centre - SLAT_H / 2, wallX(centre) - left, SLAT_H);
});

/** Stroked parts (round caps and joins). */
export const MARK_STROKES: ReadonlyArray<{ d: string; width: number }> = [
  // Grip with its downturned end, then the frame running down to the base rail.
  { d: `M2.6 13.2V10H9L${n(frameX(37.6))} 37.6`, width: W },
  // Basket: rim, slanted right wall and bottom, back to the frame.
  { d: `M${n(frameX(15.6))} 15.6H46L42 33.4H${n(frameX(33.4))}`, width: W },
  // Base rail the wheels hang from.
  { d: `M${n(frameX(37.6))} 37.6H43.6`, width: W },
];

/** Filled parts: the slats, two wheels and the two leaves. */
export const MARK_FILLS: ReadonlyArray<string> = [
  ...SLATS,
  circle(21.2, 43.4, 3.3),
  circle(38.8, 43.4, 3.3),
  LEFT_LEAF.shape,
  RIGHT_LEAF.shape,
];

/** Leaf midribs, cut out of the leaves. */
export const MARK_CUTS: ReadonlyArray<{ d: string; width: number }> = [
  { d: LEFT_LEAF.midrib, width: 1.3 },
  { d: RIGHT_LEAF.midrib, width: 1.6 },
];

/** Brand colours for files exported outside the app (inside the app the CSS tokens apply). */
export const BRAND_HEX = {
  /** The sign's deep red. */
  red: '#a8121b',
  charcoal: '#2b2b2e',
  nearBlack: '#141416',
  offWhite: '#faf8f5',
  white: '#ffffff',
} as const;

export const TAGLINE = 'SIFATLI MAHSULOT HAR KUN SIZ BILAN';

/**
 * The mark's SVG content (no outer `<svg>`), in one flat colour. `id` must be unique in the
 * document: it names the midrib mask.
 */
export function markSvgBody(color: string = BRAND_HEX.red, id = 'mm'): string {
  const cuts = MARK_CUTS.map(
    (cut) =>
      `<path d="${cut.d}" fill="none" stroke="#000" stroke-width="${n(cut.width)}" stroke-linecap="round"/>`,
  ).join('');
  const strokes = MARK_STROKES.map((s) => `<path d="${s.d}" stroke-width="${n(s.width)}"/>`).join(
    '',
  );
  const fills = MARK_FILLS.map((d) => `<path d="${d}"/>`).join('');
  return (
    `<mask id="${id}-cut" maskUnits="userSpaceOnUse" x="0" y="-10" width="58" height="58">` +
    `<rect x="0" y="-10" width="58" height="58" fill="#fff"/>${cuts}</mask>` +
    `<g mask="url(#${id}-cut)">` +
    `<g fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round">${strokes}</g>` +
    `<g fill="${color}">${fills}</g></g>`
  );
}
