import type { AxisIndex } from './scene';

/**
 * The three accesses HourGlass opens to a Safe signer, one per axis of the die.
 * Copy lives here and nowhere else — the hero list and the floating chips both
 * read from it.
 */

export interface Advantage {
  lead: string;
  rest: string;
}

export interface Access {
  id: string;
  axis: AxisIndex;
  name: string;
  descriptor: string;
  /** Absent when there is nothing to link to yet — the item is a button instead. */
  href?: string;
  /** Matches the sand colour of this axis in the scene. */
  tone: string;
  advantages: Advantage[];
}

export const ACCESSES: Access[] = [
  {
    id: 'payroll',
    axis: 1,
    name: 'Pay contributors',
    descriptor: 'payroll by the second, subscriptions by the period',
    href: '/docs',
    tone: '#1fff9f',
    advantages: [
      { lead: 'Sign once', rest: 'remove the monthly signing burden from your signers' },
      { lead: 'Capped on-chain', rest: 'never above the agreed amount, never twice' },
      { lead: 'Non-custodial', rest: 'funds stay in your Safe until the moment of charge' },
      { lead: 'Charged every period', rest: 'by the receiver, no subsequent signers needed' },
      { lead: 'Revocable', rest: 'cancel any agreement on-chain, at any time' },
    ],
  },
  {
    id: 'agentic',
    axis: 0,
    name: 'Agentic DeFi',
    descriptor: 'an agent trades inside bounds it cannot exceed',
    href: '/docs/agent-investment',
    tone: '#00c8ff',
    advantages: [
      { lead: 'Scoped permissions', rest: 'the mandate bounds every swap, on-chain' },
      { lead: 'Decentralized agent', rest: 'runs via 0g, not a server you have to trust' },
      { lead: 'Uniswap routing', rest: 'strategies execute against real liquidity' },
    ],
  },
  {
    id: 'aqua',
    axis: 2,
    name: '1inch Aqua',
    descriptor: 'your treasury becomes a liquidity pool without leaving the Safe',
    tone: '#a855ff',
    advantages: [
      { lead: 'Your treasury is the pool', rest: 'grant permission for your funds to provide liquidity' },
      { lead: 'Earn fees', rest: 'the spread accrues to you, not to a protocol' },
      { lead: 'Keep custody', rest: 'your funds and your voting power never leave the Safe' },
    ],
  },
];

export const accessByAxis = (axis: AxisIndex): Access =>
  ACCESSES.find((a) => a.axis === axis) ?? ACCESSES[0];
