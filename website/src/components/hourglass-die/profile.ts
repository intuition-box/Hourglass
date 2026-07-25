/**
 * Geometry of one hourglass bulb, and how sand fills it.
 *
 * The three hourglasses share the cube's centre, so their envelopes must not
 * intersect. Every bulb is kept strictly under the 45° cone r(t) < t, where t is
 * the distance from the centre normalised by the half-length: two solids bounded
 * by such cones on perpendicular axes meet only at the origin, and the sliver of
 * overlap left around the necks is covered by the central node.
 *
 * Pure maths — no three.js, no DOM.
 */

export const L = 0.93; // hourglass half-length
export const NECK = 0.038; // neck radius, in units of L
export const MAX_R = 0.31; // widest bulb radius, in units of L
export const T_MAX = 0.74; // where the bulb is widest; beyond it, an ellipsoid dome
export const FLARE = 4.0; // how long the stem stays thin before the bulb opens
export const WALL = 0.93; // sand surface inset from the glass wall
export const CAPACITY = 0.9; // sand charge, as a fraction of one bulb's volume

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Silhouette of one bulb: t = 0 at the neck, t = 1 at the domed far end. */
export function profileR(t: number): number {
  if (t >= T_MAX) {
    const u = (t - T_MAX) / (1 - T_MAX);
    return MAX_R * Math.sqrt(Math.max(0, 1 - u * u));
  }
  // sin() so the wall meets the dome tangentially, no crease at the widest point
  return NECK + (MAX_R - NECK) * Math.sin((Math.PI / 2) * Math.pow(t / T_MAX, FLARE));
}

/** The sand surface sits just inside the glass. */
export const innerR = (t: number) => profileR(t) * WALL;

/* Cumulative volume of a bulb from the neck outwards, so the sand level drops
   the way it does in a real hourglass — fast through the narrow part. */
const VOL_N = 256;
const volume = new Float32Array(VOL_N + 1);
{
  let acc = 0;
  for (let i = 1; i <= VOL_N; i++) {
    const r0 = innerR((i - 1) / VOL_N);
    const r1 = innerR(i / VOL_N);
    acc += ((r0 * r0 + r1 * r1) / 2) / VOL_N;
    volume[i] = acc;
  }
  for (let i = 0; i <= VOL_N; i++) volume[i] /= acc;
}

/** Fraction of a bulb's volume held below level t. */
export const volumeAt = (t: number) => volume[clamp(Math.round(t * VOL_N), 0, VOL_N)];

/** Inverse of the volume table: fraction of a bulb filled → level t. */
export function levelAt(v: number): number {
  const target = clamp(v, 0, 1);
  let lo = 0;
  let hi = VOL_N;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (volume[mid] < target) lo = mid;
    else hi = mid;
  }
  const span = volume[hi] - volume[lo];
  const f = span > 1e-9 ? (target - volume[lo]) / span : 0;
  return (lo + f) / VOL_N;
}
