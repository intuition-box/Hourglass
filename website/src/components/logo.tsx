/**
 * The Hourglass mark: the die reduced to its silhouette. A cube seen down its
 * (1,1,1) diagonal projects to a regular hexagon, and splitting that hexagon the
 * way the cube splits — six triangles around the centre — makes every opposite
 * pair a bowtie. Three bowties, three axes, necks meeting at the centre.
 *
 * Shared with the Safe App's `LogoMark` so the two read as one product.
 */
export function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="28 28 200 200"
      fill="none"
      aria-hidden="true"
      className="block shrink-0"
    >
      <path d="M128 128L128 28L214.6 78ZM128 128L128 228L41.4 178Z" fill="#7ff2cd" />
      <path d="M128 128L214.6 78L214.6 178ZM128 128L41.4 178L41.4 78Z" fill="#35c396" />
      <path d="M128 128L214.6 178L128 228ZM128 128L41.4 78L128 28Z" fill="#126b51" />
    </svg>
  );
}

export function Logo({ size = 24, withWordmark = true }: { size?: number; withWordmark?: boolean }) {
  return (
    <span className="flex items-center gap-2 select-none">
      <LogoMark size={size} />
      {withWordmark && (
        <span className="font-extrabold tracking-tight" style={{ fontSize: size * 0.82 }}>
          <span style={{ color: 'var(--accent)' }}>Hour</span>Glass
        </span>
      )}
    </span>
  );
}
