'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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

  return (
    <div
      className="relative z-10 grid gap-10 lg:grid-cols-[minmax(0,480px)_minmax(0,1fr)] lg:gap-12 lg:flex-1 lg:content-center"
    >
      {/* min-w-0: without it the h1's fixed line becomes the column's min-content
          width and pushes the grid past the viewport on a phone */}
      <div className="flex min-w-0 flex-col">
        {children}

        <ul className="mt-10 flex flex-col gap-1">
          {ACCESSES.map((access) => {
            const isActive = access.id === active;
            const inner = (
              <>
                <span
                  aria-hidden="true"
                  className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full transition-opacity"
                  style={{ background: access.tone, opacity: isActive ? 1 : 0.35 }}
                />
                <span className="flex flex-col">
                  <span
                    className="text-[17px] font-semibold transition-colors"
                    style={{ color: isActive ? access.tone : 'var(--color-fd-foreground)' }}
                  >
                    {access.name}
                  </span>
                  <span className="text-[15px] text-fd-muted-foreground">{access.descriptor}</span>
                </span>
              </>
            );
            const className = [
              'flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-line)]',
              isActive ? 'bg-fd-accent/40' : 'hover:bg-fd-accent/20',
            ].join(' ');

            return (
              <li key={access.id}>
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

      <div className="relative hidden min-h-[380px] md:block lg:min-h-[560px]">
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
            {current.advantages.map((adv, i) => {
              const angle = (-90 + (i * 360) / current.advantages.length) * (Math.PI / 180);
              const cos = Math.cos(angle);
              /* Anchored just outside the cube's footprint rather than on a true
                 ellipse: the cube is ~48% of the column, so a chip centred on the
                 ring would sit on its edges and become unreadable. */
              const side = cos > 0.25 ? 1 : cos < -0.25 ? -1 : 0;
              const x = 50 + side * 22;
              const y = 50 + Math.sin(angle) * 41;
              return (
                <li
                  key={adv.lead}
                  className="die-chip absolute w-[220px]"
                  style={{
                    left: `${x}%`,
                    top: `${y}%`,
                    ['--chip-tx' as string]: side > 0 ? '0%' : side < 0 ? '-100%' : '-50%',
                    opacity: chipsIn ? 1 : 0,
                    transitionDelay: chipsIn ? `${250 + i * 70}ms` : '0ms',
                  }}
                >
                  <span
                    className="die-chip-bob block rounded-xl border border-fd-border bg-[color:var(--color-panel)]/80 px-4 py-3 backdrop-blur-sm"
                    style={{ animationDelay: `${i * -1.3}s` }}
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
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
