/**
 * The die as six square pyramids.
 *
 * A cube splits exactly into six pyramids: one per face, each with that face as
 * its base and its apex at the centre. Opposite pairs share an apex, so every
 * pair is a bipyramid — an hourglass, with the join at the centre as its neck.
 * Three pairs, three axes, no leftover space.
 *
 * The maths is simpler than a lathed bulb. A pyramid's cross-section at axial
 * distance t from the centre is a square of half-width t, so its volume up to t
 * is (2t)³/3 — and inverting a fill fraction is one cube root, no volume table.
 *
 * Pure maths — no three.js, no DOM.
 */

export const S = 1; // cube half-size, and so each pyramid's height
/** Sand fills the pyramid itself, standing off the glass on every side. There are
    six volumes here, not twelve — but a hair of clearance is not enough: at 0.5%
    the shared base plane was exactly coincident, which made the surface flicker
    as the camera moved. It only needs to be small: a 1% gap left a slit between
    neighbouring volumes wide enough to catch the key light and read as a white
    line down every edge. 0.3% separates the planes and closes the slit — and the
    pyramid's own shell has already faded to nothing by the time its sand reaches
    the base, so there is nothing left for the sand to fight with. */
export const SAND_INSET = 0.997;
/** A charge is exactly one pyramid of sand: a full piece, or empty glass. */
export const CAPACITY = 1;

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** How far out the sand reaches. Short of the pyramid's own base, so the two
    caps never share a plane. The six pieces themselves tile the cube exactly —
    all the clearance in this object comes from the sand being inset, not from
    shrinking the pyramids. */
export const SAND_SPAN = S * 0.99;

/**
 * Where the surface sits in a draining pyramid — the one whose apex points down,
 * so sand pools into the funnel's point. It fills from the apex out: v = (h/S)³.
 */
export const drainLevel = (fill: number) => SAND_SPAN * Math.cbrt(clamp(fill, 0, 1));

/**
 * Where the surface sits in a receiving pyramid — apex up, base down, so sand
 * stacks on the base and climbs toward the neck: v = 1 - (h/S)³.
 */
export const heapLevel = (fill: number) => SAND_SPAN * Math.cbrt(1 - clamp(fill, 0, 1));
