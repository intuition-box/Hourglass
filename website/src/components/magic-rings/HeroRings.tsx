'use client';

import { useEffect, useRef } from 'react';
import MagicRings from './MagicRings';

/**
 * The hero's ring backdrop, and the one thing that can set it off.
 *
 * MagicRings fires its burst from a `click` on its own container, so rather than
 * patching the vendored component we hand it the same event it already listens
 * for. The die announces a roll on `window`; this turns that into a click on the
 * rings, and the two animations land together.
 */
export const ROLL_EVENT = 'hourglass:roll';

export function HeroRings() {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const burst = () => {
      wrapRef.current
        ?.querySelector('.magic-rings-container')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: false }));
    };
    window.addEventListener(ROLL_EVENT, burst);
    return () => window.removeEventListener(ROLL_EVENT, burst);
  }, []);

  return (
    <div ref={wrapRef} className="pointer-events-none absolute inset-0 z-0 opacity-70" aria-hidden="true">
      <MagicRings
        ringCount={7}
        speed={0.3}
        color="#10B981"
        colorTwo="#06B6D4"
        baseRadius={0.23}
        mouseInfluence={0}
        parallax={0}
        hoverScale={1.05}
        clickBurst
      />
    </div>
  );
}
