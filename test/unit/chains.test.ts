/**
 * Chain wiring tests: prove every network is consistently configured end-to-end —
 * registry ⇄ contract addresses ⇄ display helpers ⇄ Safe tx-service. Catches the
 * classic "added a chain in one place, forgot another" bug.
 *
 * Run: bun test test/unit
 */
import { describe, test, expect } from 'bun:test'
import { isAddress } from 'viem'
import { mainnet } from 'viem/chains'
import { getSmartAccountsEnvironment } from '@metamask/smart-accounts-kit'
import { NETWORKS, LIVE_NETWORKS, CREATE2_MODULE_FACTORY, anvilLocal, findNetwork } from '../../src/config/networks'
import { SUPPORTED_CHAINS, SELECTABLE_CHAINS, findChain, chainName, explorerTx, rpcUrl } from '../../src/config/supported-chains'
import { getAddresses, unavailableReason, HOURGLASS_SUITE } from '../../src/config/addresses'
import { txServiceUrl } from '../../src/lib/safe-messages'
import initcode from '../../scripts/deployments/hourglass-initcode.json'

describe('networks registry', () => {
  test('chain ids are unique', () => {
    const ids = NETWORKS.map((n) => n.chain.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('every network is served by the Delegation Framework v1.3.0 SDK', () => {
    for (const n of NETWORKS) {
      expect(() => getSmartAccountsEnvironment(n.chain.id), `${n.name} missing from the SDK`).not.toThrow()
    }
  })

  test('every network has an https RPC, explorer and Safe tx-service', () => {
    for (const n of NETWORKS) {
      expect(n.rpcUrl).toStartWith('https://')
      expect(n.explorer).toStartWith('https://')
      expect(n.txService).toStartWith('https://api.safe.global/tx-service/')
      expect(n.txService.endsWith('/')).toBe(false)
    }
  })

  test('networks deployed by the script use the CREATE2 factory from the initcode file', () => {
    expect(initcode.contracts.delegatorModuleFactory.address).toBe(CREATE2_MODULE_FACTORY)
  })
})

describe('supported chains are exactly the live networks + anvil', () => {
  test('findChain resolves every live id and rejects pending and unknown ones', () => {
    for (const n of LIVE_NETWORKS) expect(findChain(n.chain.id)?.id).toBe(n.chain.id)
    for (const n of NETWORKS.filter((x) => x.deployment.status === 'pending')) expect(findChain(n.chain.id)).toBeUndefined()
    expect(findChain(999_999)).toBeUndefined()
  })

  test('supported chains use the registry RPC', () => {
    for (const c of SUPPORTED_CHAINS) expect(c.rpcUrls.default.http[0]).toBe(rpcUrl(c.id)!)
  })

  test('selectable chains exclude anvil and cover all live networks', () => {
    const ids = SELECTABLE_CHAINS.map((c) => c.id)
    expect(ids).not.toContain(anvilLocal.id)
    expect([...ids].sort()).toEqual(LIVE_NETWORKS.map((n) => n.chain.id).sort())
  })

  test('chainName names every known network and falls back for unknown ones', () => {
    for (const n of NETWORKS) expect(chainName(n.chain.id)).toBe(n.name)
    expect(chainName(999_999)).toBe('Chain 999999')
  })

  test('explorerTx builds the chain-specific explorer URL', () => {
    expect(explorerTx(mainnet.id, '0xabc')).toBe('https://etherscan.io/tx/0xabc')
    for (const c of SELECTABLE_CHAINS) expect(explorerTx(c.id, '0xhash')).toBe(`${c.explorer}/tx/0xhash`)
  })

  test('txServiceUrl comes from the registry', () => {
    for (const n of NETWORKS) expect(txServiceUrl(n.chain.id)).toBe(n.txService)
    expect(txServiceUrl(999_999)).toBeNull()
  })
})

describe('registry ⇄ contract addresses are in sync', () => {
  test('every live network has valid contract addresses', () => {
    for (const n of LIVE_NETWORKS) {
      const a = getAddresses(n.chain.id)
      for (const [field, value] of Object.entries(a)) {
        // `hourglass` is a nested group of addresses — validate its members instead.
        if (typeof value === 'object' && value !== null) {
          for (const [sub, addr] of Object.entries(value)) {
            expect(isAddress(addr), `${n.name}.${field}.${sub} is not a valid address`).toBe(true)
          }
          continue
        }
        expect(isAddress(value), `${n.name}.${field} is not a valid address`).toBe(true)
      }
    }
  })

  test('the module factory and HourGlass enforcers follow the deployment status', () => {
    for (const n of NETWORKS) {
      if (n.deployment.status === 'pending') {
        expect(() => getAddresses(n.chain.id)).toThrow(`HourGlass is not deployed on ${n.name} yet.`)
        continue
      }
      const a = getAddresses(n.chain.id)
      expect(a.delegatorModuleFactory).toBe(n.deployment.moduleFactory)
      if (n.deployment.enforcers === 'canonical') expect(a.hourglass).toBeUndefined()
      else expect(a.hourglass?.erc20PeriodTransferEnforcer).toBe(HOURGLASS_SUITE.erc20PeriodTransferEnforcer)
    }
  })

  test('the deploy script deploys exactly the payment enforcers the app signs against', () => {
    const c = initcode.contracts
    expect(c.erc20PeriodTransferEnforcer.address).toBe(HOURGLASS_SUITE.erc20PeriodTransferEnforcer)
    expect(c.timestampEnforcer.address).toBe(HOURGLASS_SUITE.timestampEnforcer)
    expect(c.erc20StreamingEnforcer.address).toBe(HOURGLASS_SUITE.erc20StreamingEnforcer)
    expect(c.valueLteEnforcer.address).toBe(HOURGLASS_SUITE.valueLteEnforcer)
  })

  test('unavailableReason names pending networks and flags unknown ones', () => {
    const pending = NETWORKS.find((n) => n.deployment.status === 'pending')
    if (pending) expect(unavailableReason(pending.chain.id)).toBe(`HourGlass is not deployed on ${pending.name} yet.`)
    expect(unavailableReason(999_999)).toBe('Unsupported chain: 999999')
    expect(findNetwork(999_999)).toBeUndefined()
  })
})
