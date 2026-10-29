/**
 * Regression lock on the two core payment shapes. Builds the subscription (with and
 * without an end date) and the stream delegation exactly as CreateDelegation /
 * CreateStream do, and checks them against hashes captured from the shipped app.
 * Any change to what a Safe signs — an enforcer address, a caveat, the EIP-712
 * domain — fails here. If the change is intended, regenerate the golden file and
 * say why in the commit.
 *
 * Run: bun test test/unit
 */
import { describe, test, expect } from 'bun:test'
import { createDelegation } from '@metamask/smart-accounts-kit'
import { hashTypedData, type Address, type Hex } from 'viem'
import { getEnvironment } from '../../src/lib/environment'
import { buildDelegationTypedData, computeDelegationHash, type DelegationStruct } from '../../src/lib/delegations'
import golden from './payment-delegations.golden.json'

const to: Address = '0x1111111111111111111111111111111111111111'
const from: Address = '0x2222222222222222222222222222222222222222'
const token: Address = '0x3333333333333333333333333333333333333333'
const salt: Hex = `0x${'ab'.repeat(32)}`
const now = 1_760_000_000

const CASES = {
  subscription: {
    scope: { type: 'erc20PeriodTransfer', tokenAddress: token, periodAmount: 10_000_000n, periodDuration: 2_592_000, startDate: now },
  },
  subscriptionEndDate: {
    scope: { type: 'erc20PeriodTransfer', tokenAddress: token, periodAmount: 10_000_000n, periodDuration: 2_592_000, startDate: now },
    caveats: [{ type: 'timestamp', afterThreshold: now, beforeThreshold: now + 31_536_000 }],
  },
  stream: {
    scope: { type: 'erc20Streaming', tokenAddress: token, initialAmount: 5_000_000n, maxAmount: 1_000_000_000n, amountPerSecond: 385n, startTime: now },
  },
}

type Golden = Record<string, { delegationHash: Hex; typedDataHash: Hex; enforcers: Address[] }>

function build(chainId: number, c: (typeof CASES)[keyof typeof CASES]): DelegationStruct {
  // Same call shape as the Create pages, which also pass the environment and scope untyped.
  const d = createDelegation({ to, from, environment: getEnvironment(chainId), salt, ...c } as never) as Omit<DelegationStruct, 'signature'>
  return {
    delegate: d.delegate,
    delegator: d.delegator,
    authority: d.authority,
    caveats: d.caveats.map((x) => ({ enforcer: x.enforcer, terms: x.terms })),
    salt: d.salt,
    signature: '0x',
  }
}

describe('payment delegations match the shipped payload', () => {
  for (const [key, expected] of Object.entries(golden as Golden)) {
    const [chain, name] = key.split('/')
    test(key, () => {
      const chainId = Number(chain)
      const del = build(chainId, CASES[name as keyof typeof CASES])
      expect(del.caveats.map((c) => c.enforcer)).toEqual(expected.enforcers)
      expect(computeDelegationHash(del)).toBe(expected.delegationHash)
      // Typed-data cast: buildDelegationTypedData returns the Safe SDK shape, which viem accepts as-is.
      expect(hashTypedData(buildDelegationTypedData(del, chainId) as never)).toBe(expected.typedDataHash)
    })
  }
})
