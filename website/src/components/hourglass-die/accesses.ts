import type { AxisIndex } from './scene';

/**
 * The three accesses HourGlass opens to a Safe signer, one per axis of the die.
 * Copy lives here and nowhere else — the hero list and the floating chips both
 * read from it.
 */

export interface Advantage {
  lead: string;
  rest: string;
  /** Protocol this claim rests on, shown as a mark on the chip. */
  brand?: string;
  /** Its logo under /brands. Absent when we have no asset — the name shows instead. */
  logo?: string;
}

export interface Access {
  id: string;
  axis: AxisIndex;
  name: string;
  descriptor: string;
  /** Absent when there is nothing to link to yet — the item is a button instead. */
  href?: string;
  /** This axis's sand, lifted where the deepest value would fail as text. */
  tone: string;
  advantages: Advantage[];
}

export const ACCESSES: Access[] = [
  {
    id: 'payroll',
    axis: 1,
    name: 'Pay contributors',
    descriptor: 'payroll that accrues by the second',
    href: '/docs',
    tone: '#c4ffe9',
    advantages: [
      {
        lead: 'Sign once',
        rest: 'one audited delegation, no monthly signing burden',
        brand: 'MetaMask',
        logo: '/brands/metamask.png',
      },
      { lead: 'Accrues continuously', rest: 'nothing is lost if the receiver waits to claim' },
      {
        lead: 'Non-custodial',
        rest: 'funds stay in your Safe until the moment of claim',
        brand: 'Safe',
        logo: '/brands/safe.svg',
      },
    ],
  },
  {
    id: 'subscriptions',
    axis: 0,
    name: 'Pay for services',
    descriptor: 'a capped amount per period, nothing more',
    href: '/docs',
    tone: '#3fd0a2',
    advantages: [
      { lead: 'Capped on-chain', rest: 'never above the agreed amount, never twice a period' },
      { lead: 'No debt piles up', rest: 'an unclaimed period is gone, the next one resets' },
      { lead: 'Revocable', rest: 'cancel any agreement on-chain, at any time' },
    ],
  },
  {
    id: 'charge',
    axis: 2,
    name: 'Get paid',
    descriptor: 'the receiver charges, no Safe signers in the loop',
    href: '/redeem',
    tone: '#2f9e78',
    advantages: [
      { lead: 'Pulled by the receiver', rest: 'charged each period or claimed as it accrues' },
      { lead: 'Any wallet', rest: 'redeem from a plain EOA with the signed delegation' },
      { lead: 'Verifiable', rest: 'every agreement is a public, signed record' },
    ],
  },
];

export const accessByAxis = (axis: AxisIndex): Access =>
  ACCESSES.find((a) => a.axis === axis) ?? ACCESSES[0];
