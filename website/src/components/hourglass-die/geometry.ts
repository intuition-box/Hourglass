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
/** Each piece stands off its neighbours, so the cube reads as six things stacked
    together rather than one painted block. This is the groove you see along
    every edge of the paper model. */
export const PIECE = 0.93;
/** Sand fills the pyramid itself, held off the glass by a hair so the coincident
    faces don't fight. There are six volumes here, not twelve. */
export const SAND_INSET = 0.995;
/** A charge is exactly one pyramid of sand: a full piece, or empty glass. */
export const CAPACITY = 1;

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** How far out the sand reaches: onto its pyramid's base, never through it. */
export const SAND_SPAN = S * PIECE;

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
