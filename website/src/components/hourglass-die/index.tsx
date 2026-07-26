'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import ElectricBorder from '../electric-border/ElectricBorder';
import { ROLL_EVENT } from '../magic-rings/HeroRings';
import { ACCESSES, accessByAxis, type Access } from './accesses';
import type { AxisIndex, HourglassDie } from './scene';

/**
 * The hero: three accesses on the left, the die on the right, and the active
 * access's advantages floating around it.
 *
 * The scene is a plain module — this component owns lifecycle only, plus the
 * rule that the highlight leads and the die follows. Pointing at an access
 * repaints the list and the chips on the same frame; the die tips over after a
 * short debounce and confirms it on landing.
 */

/** three.js is ~150 KB gzipped; not worth it on a phone. */
const DESKTOP = '(min-width: 768px)';

export function AccessShowcase({ children }: { children: ReactNode }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const dieRef = useRef<HourglassDie | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rollingRef = useRef(false);

  /* Two sources of truth, deliberately: `settled` is the face the die is on,
     `aimed` is what the visitor is pointing at. The highlight follows `aimed`
     the instant it changes so it never waits on the animation. */
  const [settled, setSettled] = useState<string>(ACCESSES[0].id);
  const [aimed, setAimed] = useState<string | null>(null);
  const aimedRef = useRef<string | null>(null);
  const [chipsIn, setChipsIn] = useState(true);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!window.matchMedia(DESKTOP).matches) return;

    let die: HourglassDie | null = null;
    let observer: IntersectionObserver | null = null;
    let cancelled = false;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    void import('./scene').then(({ HourglassDie: Die }) => {
      if (cancelled) return;
      die = new Die(host, {
        reducedMotion,
        onSettle: (axis: AxisIndex) => {
          rollingRef.current = false;
          setSettled(accessByAxis(axis).id);
          setAimed(null);
          aimedRef.current = null;
          setChipsIn(true);
        },
        // Only fade the chips out when the die moved on its own. A visitor who
        // pointed at an access is already looking at the answer.
        onRollStart: () => {
          rollingRef.current = true;
          window.dispatchEvent(new Event(ROLL_EVENT)); // the rings burst with it
          if (!aimedRef.current) setChipsIn(false);
        },
      });
      dieRef.current = die;
      setLive(true);

      // A landing page scrolls. Stop the loop the moment the hero leaves.
      observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) die?.start();
          else die?.stop();
        },
        { threshold: 0.05 },
      );
      observer.observe(host);
    });

    return () => {
      cancelled = true;
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      observer?.disconnect();
      die?.dispose();
      dieRef.current = null;
    };
  }, []);

  const rollTo = useCallback((access: Access) => {
    dieRef.current?.setActive(access.axis);
  }, []);

  const aim = useCallback((access: Access) => {
    setAimed(access.id);
    aimedRef.current = access.id;
    setChipsIn(true);
  }, []);

  const preview = useCallback(
    (access: Access) => {
      aim(access);
      // debounced so sweeping down the list doesn't send the die chasing
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      hoverTimer.current = setTimeout(() => {
        hoverTimer.current = null;
        rollTo(access);
      }, 120);
    },
    [aim, rollTo],
  );

  const choose = useCallback(
    (access: Access) => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
      aim(access);
      rollTo(access);
    },
    [aim, rollTo],
  );

  /* Pointer left before the die was sent anywhere — take the highlight back.
     If the roll already started, the highlight stays and `onSettle` clears it. */
  const cancelPreview = useCallback(() => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    // Mid-roll the highlight has to stand until the die lands, or it snaps back
    // to the face being left behind. Otherwise take it back — including when
    // the pointed-at access was already the live one and no roll happened.
    if (!rollingRef.current) {
      setAimed(null);
      aimedRef.current = null;
    }
  }, []);

  const active = aimed ?? settled;
  const current = ACCESSES.find((a) => a.id === active) ?? ACCESSES[0];

  /* Chips flank the die in two columns and never sit above it — a card over the
     cube pushes the whole composition down the page. Alternating keeps the two
     sides even however many advantages an access has. */
  const chipSlots = (() => {
    const columns: Record<'1' | '-1', typeof current.advantages> = { '1': [], '-1': [] };
    // deal left first, so an odd count leaves the extra card on the side the eye
    // reads from rather than stacking the right column three deep
    current.advantages.forEach((adv, i) => columns[i % 2 === 0 ? '-1' : '1'].push(adv));
    // one step for both columns: different spacings made the taller column look
    // top-heavy even though each was centred on its own
    const STEP = 30;
    return ([-1, 1] as const).flatMap((side) => {
      const column = columns[side > 0 ? '1' : '-1'];
      return column.map((adv, j) => ({
        adv,
        side,
        y: 50 + (j - (column.length - 1) / 2) * STEP,
        order: current.advantages.indexOf(adv),
      }));
    });
  })();

  return (
    <div className="relative z-10 flex min-w-0 flex-col">
      {children}

      {/* Centred: the die sits on the axis the rings radiate from. The headline
          and the CTA stack above it, so the block needs a nudge down to land on
          that axis rather than above it. */}
      <div className="relative mx-auto mt-3 hidden w-full max-w-[1120px] min-h-[380px] md:block lg:mt-6 lg:min-h-[470px]">
        {/* the scene mounts its canvas here; the chips inherit its --die-* vars */}
        <div ref={hostRef} className="absolute inset-0">
          {!live && (
            <div
              aria-hidden="true"
              className="absolute inset-0 bg-[radial-gradient(circle_at_50%_45%,rgba(88,230,184,0.10),transparent_62%)]"
            />
          )}

          <button
            type="button"
            aria-label="Roll the die to the next access"
            className="absolute inset-0 z-20 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-line)]"
            onClick={() => dieRef.current?.rollNext()}
          />

          {/* z-10: the scene appends its canvas last, so without it the glass
              paints over the copy */}
          <ul className="pointer-events-none absolute inset-0 z-10 hidden md:block">
            {chipSlots.map(({ adv, side, y, order }) => (
                <li
                  key={adv.lead}
                  className="die-chip absolute w-[220px]"
                  style={{
                    left: `${50 + side * 24}%`,
                    top: `${y}%`,
                    ['--chip-tx' as string]: side > 0 ? '0%' : '-100%',
                    opacity: chipsIn ? 1 : 0,
                    transitionDelay: chipsIn ? `${250 + order * 70}ms` : '0ms',
                  }}
                >
                  <span
                    className="die-chip-bob block rounded-xl border border-fd-border bg-[color:var(--color-panel)]/80 px-4 py-3 backdrop-blur-sm"
                    style={{ animationDelay: `${order * -1.3}s` }}
                  >
                    {adv.brand &&
                      (adv.logo ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={adv.logo}
                          alt={adv.brand}
                          className="mb-2 block h-[18px] w-auto max-w-[64px] object-contain object-left"
                        />
                      ) : (
                        <span className="mb-2 block text-[10px] uppercase tracking-[0.16em] text-fd-muted-foreground">
                          {adv.brand}
                        </span>
                      ))}
                    <b className="text-[15px] font-semibold leading-tight" style={{ color: current.tone }}>
                      {adv.lead}
                    </b>
                    <span className="mt-1 block text-[13.5px] leading-snug text-fd-muted-foreground">
                      {adv.rest}
                    </span>
                  </span>
                </li>
            ))}
          </ul>
        </div>
      </div>

      {/* The three accesses, in a row under the die. */}
      <ul className="mt-6 grid gap-2 md:mt-2 md:grid-cols-3 md:gap-5">
        {ACCESSES.map((access) => {
          const isActive = access.id === active;
          /* No colour dot: the live access wears the border in its own colour, so
             a second marker of the same thing is noise. */
          const inner = (
            <span className="flex flex-col">
              <span
                className="text-[17px] font-semibold transition-colors"
                style={{ color: isActive ? access.tone : 'var(--color-fd-foreground)' }}
              >
                {access.name}
              </span>
              <span className="text-[15px] text-fd-muted-foreground">{access.descriptor}</span>
            </span>
          );
          const className = [
            'flex h-full w-full items-start rounded-lg px-3.5 py-3 text-left transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-line)]',
            isActive ? '' : 'hover:bg-fd-accent/20',
          ].join(' ');

          const item = (
            <>
              {access.href ? (
                <Link
                  href={access.href}
                  className={className}
                  onMouseEnter={() => preview(access)}
                  onMouseLeave={cancelPreview}
                  onFocus={() => preview(access)}
                  onClick={() => choose(access)}
                >
                  {inner}
                </Link>
              ) : (
                <button
                  type="button"
                  className={className}
                  aria-pressed={isActive}
                  onMouseEnter={() => preview(access)}
                  onMouseLeave={cancelPreview}
                  onFocus={() => preview(access)}
                  onClick={() => choose(access)}
                >
                  {inner}
                </button>
              )}
            </>
          );

          /* The live access wears the border rather than a tinted panel: the
             die's colour, drawn round the one it belongs to. */
          return (
            <li key={access.id}>
              {isActive ? (
                <ElectricBorder color={access.tone} chaos={0.1} speed={0.1} borderRadius={10}>
                  {item}
                </ElectricBorder>
              ) : (
                item
              )}
            </li>
          );
        })}
      </ul>

      {/* No canvas on a phone, so the advantages read as a plain list instead. */}
      <ul className="mt-8 flex flex-col gap-2 md:hidden">
        {current.advantages.map((adv) => (
          <li key={adv.lead} className="text-[15px]">
            <b className="font-semibold" style={{ color: current.tone }}>
              {adv.lead}
            </b>{' '}
            <span className="text-fd-muted-foreground">{adv.rest}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
