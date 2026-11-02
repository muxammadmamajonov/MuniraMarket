/**
 * MuniraMarket logo geometry and rendering: the single source of truth for the mark. A flat 2D
 * cart built from the owner's reference drawing: five horizontal bars (the grip, the basket rim,
 * three slats and the base rail) with square ends and sharp corners, a diagonal frame, and a
 * slanted right wall that the three slats run into. The slats share one left edge, leaving an
 * open gap to the frame. From the shop sign come the two wheels and the two leaves growing out
 * of the rim: the right leaf is about twice the size of the left one.
 *
 * The React component (`components/wordmark.tsx`) and the exported files in `public/brand/`
 * (`scripts/export-brand.mts`) both render `markSvgBody`; nothing is traced from a photo or
 * shipped as a raster crop. One flat colour; the leaf midribs are cut out so the background
 * shows through.
 */

/** Square canvas: x and y of its top-left corner and its side, in grid units. */
export const MARK_BOX = { x: -1, y: -2.5, size: 56 } as const;
export const MARK_VIEWBOX = `${String(MARK_BOX.x)} ${String(MARK_BOX.y)} ${String(MARK_BOX.size)} ${String(MARK_BOX.size)}`;

type Point = readonly [number, number];

const n = (value: number) => String(Math.round(value * 100) / 100);

const polygon = (points: ReadonlyArray<Point>) =>
  `M${points.map(([x, y]) => `${n(x)} ${n(y)}`).join('L')}z`;

const rect = (x0: number, y0: number, x1: number, y1: number) =>
  polygon([
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]);

const circle = (cx: number, cy: number, r: number) =>
  `M${n(cx - r)} ${n(cy)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0-${n(2 * r)} 0z`;

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

/*
 * The cart, in grid units. Bar thicknesses follow the reference: the grip, frame and slats are
 * 2.75 thick, the rim and base rail a little heavier.
 */
const BAR = 2.75;
const RIM = { top: 18, bottom: 21.5, left: 11.9, right: 46.1 };
const BASE = { top: 43.2, bottom: 46.8, right: 42 };

/** Frame: the diagonal bar from the grip down to the base rail; its left edge at height y. */
const FRAME = { x0: 7.7, y0: 8, x1: 13.8, y1: BASE.bottom };
const frameLeft = (y: number) =>
  FRAME.x0 + ((y - FRAME.y0) * (FRAME.x1 - FRAME.x0)) / (FRAME.y1 - FRAME.y0);

/** Right wall: from under the rim's right end down to the bottom of the last slat. */
const WALL = { top: RIM.bottom, bottom: 40.45, outerTop: 45.7, outerBottom: 42.4, thick: 2.9 };
const wallOuter = (y: number) =>
  WALL.outerTop + ((y - WALL.top) * (WALL.outerBottom - WALL.outerTop)) / (WALL.bottom - WALL.top);

/** The three slats: one shared left edge, each running into the wall. */
const SLAT_LEFT = 21.7;
const SLAT_ROWS: ReadonlyArray<readonly [number, number]> = [
  [24.06, 26.81],
  [31.1, 33.85],
  [37.7, WALL.bottom],
];

const GRIP = rect(2, FRAME.y0, FRAME.x0 + BAR, FRAME.y0 + BAR);
const FRAME_BAR = polygon([
  [FRAME.x0, FRAME.y0],
  [FRAME.x0 + BAR, FRAME.y0],
  [FRAME.x1 + BAR, FRAME.y1],
  [FRAME.x1, FRAME.y1],
]);
const RIM_BAR = rect(frameLeft(RIM.top), RIM.top, RIM.right, RIM.bottom);
const WALL_BAR = polygon([
  [WALL.outerTop - WALL.thick, WALL.top],
  [WALL.outerTop, WALL.top],
  [WALL.outerBottom, WALL.bottom],
  [WALL.outerBottom - WALL.thick, WALL.bottom],
]);
const SLATS = SLAT_ROWS.map(([top, bottom]) =>
  polygon([
    [SLAT_LEFT, top],
    [wallOuter(top) - 0.2, top],
    [wallOuter(bottom) - 0.2, bottom],
    [SLAT_LEFT, bottom],
  ]),
);
const BASE_BAR = rect(frameLeft(BASE.top), BASE.top, BASE.right, BASE.bottom);

// Left leaf: smaller, standing up and leaning left. Right leaf: about twice its size, lying out
// to the right. Their bases meet in a V on top of the rim.
const LEFT_LEAF = leaf([28, RIM.top + 0.6], [20, 2.6], 10);
const RIGHT_LEAF = leaf([30.4, RIM.top + 0.6], [51.4, 0.8], 15);

/** Filled parts: the cart bars, two wheels and the two leaves. */
export const MARK_FILLS: ReadonlyArray<string> = [
  GRIP,
  FRAME_BAR,
  RIM_BAR,
  WALL_BAR,
  ...SLATS,
  BASE_BAR,
  circle(19.4, 50, 2.5),
  circle(37.2, 50, 2.5),
  LEFT_LEAF.shape,
  RIGHT_LEAF.shape,
];

/** Leaf midribs, cut out of the leaves. */
export const MARK_CUTS: ReadonlyArray<{ d: string; width: number }> = [
  { d: LEFT_LEAF.midrib, width: 1.2 },
  { d: RIGHT_LEAF.midrib, width: 1.5 },
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
  const { x, y, size } = MARK_BOX;
  const cuts = MARK_CUTS.map(
    (cut) =>
      `<path d="${cut.d}" fill="none" stroke="#000" stroke-width="${n(cut.width)}" stroke-linecap="round"/>`,
  ).join('');
  const fills = MARK_FILLS.map((d) => `<path d="${d}"/>`).join('');
  return (
    `<mask id="${id}-cut" maskUnits="userSpaceOnUse" x="${String(x)}" y="${String(y)}" width="${String(size)}" height="${String(size)}">` +
    `<rect x="${String(x)}" y="${String(y)}" width="${String(size)}" height="${String(size)}" fill="#fff"/>${cuts}</mask>` +
    `<g mask="url(#${id}-cut)" fill="${color}">${fills}</g>`
  );
}
