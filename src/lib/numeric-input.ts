/** Strips a numeric input down to digits + one decimal point, normalizing a
 * comma to a dot — blocks letters and other stray characters as the user types. */
export const dec = (v: string) => v.replace(',', '.').replace(/[^\d.]/g, '')
