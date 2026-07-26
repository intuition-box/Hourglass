import { useState, useEffect } from 'react'
import { useSafeAppsSDK } from '@safe-global/safe-apps-react-sdk'
import { createPublicClient, http, isAddress, parseUnits, type Address, type Hex } from 'viem'
import { readErc20Meta } from '../lib/erc20'
import { useSafeTokens } from '../hooks/useSafeTokens'
import { useWhitelistedTokens } from '../hooks/useWhitelistedTokens'
import type { HeldToken } from '../lib/safe-balances'
import type { WhitelistedToken } from '../lib/token-list'
import { buildStrategyMandate } from '../lib/strategyMandate'
import { buildDelegationTypedData, computeDelegationHash } from '../lib/delegations'
import { getEnvironment } from '../lib/environment'
import { getAddresses } from '../config/addresses'
import { DeleGatorModuleFactoryABI } from '../config/abis'
import { DEFAULT_SALT } from '../lib/module'
import { UNIVERSAL_ROUTER } from '../config/uniswap'
import { findChain, rpcUrl } from '../config/supported-chains'
import { saveDelegation } from '../lib/storage'
import { Card, Btn, Mono, CopyChip } from '../ui/components'
import { Block, Field, Segmented, PreviewRow } from '../ui/form'
import { IconLock, IconCheck, IconAlert } from '../ui/icons'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const dec = (v: string) => v.replace(',', '.').replace(/[^\d.]/g, '')

type SignStep = 'idle' | 'preparing' | 'signing' | 'done'
type Frequency = 'daily' | 'weekly' | 'monthly'

const FREQUENCIES: { key: Frequency; label: string }[] = [
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
]

export default function Strategy() {
  const { sdk, safe } = useSafeAppsSDK()
  const safeTokens = useSafeTokens(safe.safeAddress as Address, safe.chainId)
  const buyTokens = useWhitelistedTokens(safe.chainId)

  // Funding token (what the Safe spends — must be held, so filtered by balance).
  const [tokenMode, setTokenMode] = useState<'whitelist' | 'custom'>('whitelist')
  const [selectedToken, setSelectedToken] = useState<HeldToken | null>(null)
  const [customToken, setCustomToken] = useState('')
  // Resolved decimals for a custom funding token (read on-chain — never assumed).
  const [customFundingDecimals, setCustomFundingDecimals] = useState<number | null>(null)
  // Buy token (the swap output — from the full whitelist, not held yet).
  const [buyMode, setBuyMode] = useState<'whitelist' | 'custom'>('whitelist')
  const [selectedBuy, setSelectedBuy] = useState<WhitelistedToken | null>(null)
  const [customBuy, setCustomBuy] = useState('')
  const [customBuyDecimals, setCustomBuyDecimals] = useState<number | null>(null)
  const [buyAmount, setBuyAmount] = useState('')
  const [frequency, setFrequency] = useState<Frequency>('weekly')
  // Guardrail (the on-chain guarantees — the caveats enforce these).
  const [cap, setCap] = useState('')
  // Max price to pay (funding per target, e.g. USDC per WETH). Derives the
  // min-received bound: a swap only clears if the price is at or below this.
  const [maxPrice, setMaxPrice] = useState('')
  const [agent, setAgent] = useState('')
  const [step, setStep] = useState<SignStep>('idle')
  const [error, setError] = useState<string | null>(null)
  // The instruction the operator hands to their agent — the DCA intent (target,
  // amount, cadence) that is NOT published on-chain, keyed to the mandate.
  const [recap, setRecap] = useState<string | null>(null)

  const useCustom = tokenMode === 'custom'
  const fundingAddress = useCustom ? customToken : (selectedToken?.address ?? '')
  const fundingSymbol = useCustom ? 'tokens' : (selectedToken?.symbol ?? 'token')
  const useCustomBuy = buyMode === 'custom'
  const targetToken = useCustomBuy ? customBuy : (selectedBuy?.address ?? '')

  // Resolve a custom token's decimals on-chain — never assume. `null` = not yet
  // resolved (or unreadable), in which case amounts stay unset rather than wrong.
  useEffect(() => {
    if (!useCustom || !isAddress(customToken)) { setCustomFundingDecimals(null); return }
    const chain = findChain(safe.chainId); if (!chain) return
    const client = createPublicClient({ chain, transport: http(rpcUrl(safe.chainId)) })
    let cancelled = false
    readErc20Meta(client, customToken as Address)
      .then((m) => { if (!cancelled) setCustomFundingDecimals(m.decimals) })
      .catch(() => { if (!cancelled) setCustomFundingDecimals(null) })
    return () => { cancelled = true }
  }, [useCustom, customToken, safe.chainId])

  useEffect(() => {
    if (!useCustomBuy || !isAddress(customBuy)) { setCustomBuyDecimals(null); return }
    const chain = findChain(safe.chainId); if (!chain) return
    const client = createPublicClient({ chain, transport: http(rpcUrl(safe.chainId)) })
    let cancelled = false
    readErc20Meta(client, customBuy as Address)
      .then((m) => { if (!cancelled) setCustomBuyDecimals(m.decimals) })
      .catch(() => { if (!cancelled) setCustomBuyDecimals(null) })
    return () => { cancelled = true }
  }, [useCustomBuy, customBuy, safe.chainId])

  // Decimals: known from the whitelist token, or resolved on-chain for a custom
  // one. `null` for an unresolved custom token — amounts then stay 0 (not wrong).
  const decimals = useCustom ? customFundingDecimals : (selectedToken?.decimals ?? null)
  const targetDecimals = useCustomBuy ? customBuyDecimals : (selectedBuy?.decimals ?? null)

  const capRaw = (() => { try { return cap && decimals !== null ? parseUnits(cap, decimals) : 0n } catch { return 0n } })()

  // Min received (raw, target units) = capSpend / maxPrice. The swap must return
  // at least this much of the bought token, so it only clears when the effective
  // price is ≤ maxPrice. Zero when either input is missing (bound then omitted).
  const minReceivedRaw = (() => {
    const spend = parseFloat(cap)
    const price = parseFloat(maxPrice)
    if (!(spend > 0) || !(price > 0) || targetDecimals === null) return 0n
    try { return parseUnits((spend / price).toFixed(targetDecimals), targetDecimals) } catch { return 0n }
  })()

  const fundingValid = isAddress(fundingAddress)
  const targetValid = isAddress(targetToken)
  const agentValid = isAddress(agent)
  const router = UNIVERSAL_ROUTER[safe.chainId]
  const canSign = Boolean(fundingValid && targetValid && buyAmount && capRaw > 0n && agentValid && router && step === 'idle')

  async function handleSign() {
    setError(null)
    if (!router) return setError(`No swap router configured for ${safe.chainId}`)
    setStep('preparing')
    try {
      const chain = findChain(safe.chainId)
      if (!chain) throw new Error('Unsupported chain')
      const client = createPublicClient({ chain, transport: http(rpcUrl(safe.chainId)) })
      const addrs = getAddresses(safe.chainId)
      const moduleAddress = (await client.readContract({
        address: addrs.delegatorModuleFactory,
        abi: DeleGatorModuleFactoryABI,
        functionName: 'predictAddress',
        args: [safe.safeAddress as Address, DEFAULT_SALT],
      })) as Address

      const mandate = buildStrategyMandate({
        moduleAddress,
        agentAddress: agent as Address,
        environment: getEnvironment(safe.chainId),
        swapRouter: router,
        // The bounds watch the Safe, not the module: the module executes via
        // safe.execTransactionFromModule, so the swap runs with msg.sender == the Safe
        // — the Safe is what spends the funding token and receives the bought token.
        // Watching the module (which holds nothing) makes the enforcer revert.
        bounds: [
          // Max spend on the funding token — the anti-drain cap.
          { tokenAddress: fundingAddress as Address, recipient: safe.safeAddress as Address, amount: capRaw, direction: 'decrease' as const },
          // Min received on the bought token — the price floor (only if a max price is set).
          ...(minReceivedRaw > 0n
            ? [{ tokenAddress: targetToken as Address, recipient: safe.safeAddress as Address, amount: minReceivedRaw, direction: 'increase' as const }]
            : []),
        ],
      })

      setStep('signing')
      const typedData = buildDelegationTypedData(mandate, safe.chainId)
      const result = (await sdk.txs.signTypedMessage(typedData as never)) as { signature?: Hex; safeTxHash?: Hex }
      const signed = { ...mandate, signature: (result?.signature || result?.safeTxHash || '0x') as Hex }

      saveDelegation({
        delegation: signed,
        meta: {
          label: 'DCA strategy',
          scopeType: 'strategyMandate',
          createdAt: new Date().toISOString(),
          chainId: safe.chainId,
          safeAddress: safe.safeAddress as Address,
          moduleAddress,
          status: 'signed',
          delegationHash: computeDelegationHash(signed),
          safeMessageHash: result?.safeTxHash,
          recipient: agent as Address,
          strategyKind: 'dca',
          tokenAddress: fundingAddress as Address,
          // The intent the agent carries out (not enforced on-chain).
          amount: buyAmount,
          period: frequency,
          targetToken: targetToken as Address,
          // The on-chain guardrail.
          capPerSwap: cap,
          enforceDecrease: true,
        },
      })

      // The instruction to hand to the agent: the intent that isn't on-chain,
      // keyed to the mandate by delegationHash + agent so the agent can match it
      // to what it discovers on Intuition.
      setRecap(JSON.stringify({
        hourglassStrategy: 'dca',
        chainId: safe.chainId,
        safe: safe.safeAddress,
        agent,
        delegationHash: computeDelegationHash(signed),
        fundingToken: fundingAddress,
        targetToken,
        amountPerBuy: buyAmount,
        frequency,
        capPerSwap: cap,
        maxPrice: maxPrice || null,
      }, null, 2))
      setStep('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sign the strategy')
      setStep('idle')
    }
  }

  return (
    <div className="rise">
      <div className="mb-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Strategy</h1>
        <p className="text-dim text-sm mt-1">
          Set a recurring buy an agent runs for you, bounded by a per-swap cap enforced on-chain. The agent trades on its
          own and can never spend more than the cap you sign.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-pending text-sm mb-6">
          <IconAlert size={16} /> {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_minmax(300px,360px)] gap-6 items-stretch">
        <div className="space-y-5">
          <Block title="Agent">
            <p className="text-xs text-dim -mt-1 leading-relaxed">
              You run the agent, not us — set it up with the{' '}
              <a href="https://github.com/intuition-box/Hourglass/tree/main/skills/hourglass-agent" target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2" style={{ color: '#34D399' }}>Hourglass skill</a>
              {' '}(it creates a wallet, funds a little gas, and redeems this mandate). Paste its address here; everything
              below stays locked until you do.
            </p>
            <Field label="Agent address" required missing={agent !== '' && !agentValid}>
              <input
                type="text" placeholder="0x…" value={agent}
                onChange={(e) => setAgent(e.target.value)}
                className={`font-mono ${agent && !agentValid ? 'ring-1 ring-danger' : ''}`}
              />
            </Field>
          </Block>

          <div className={agentValid ? 'space-y-5' : 'space-y-5 opacity-40 pointer-events-none select-none'} aria-disabled={!agentValid}>
          <Block
            title="Funding token"
            action={
              <Segmented
                value={tokenMode}
                onChange={setTokenMode}
                options={[{ key: 'whitelist', label: 'Available tokens' }, { key: 'custom', label: 'Custom ERC-20' }]}
              />
            }
          >
            {useCustom ? (
              <input type="text" placeholder="Token 0x…" value={customToken} onChange={(e) => setCustomToken(e.target.value)} />
            ) : safeTokens.loading ? (
              <p className="text-xs text-faint mt-1">Reading tokens held by the Safe…</p>
            ) : safeTokens.tokens.length > 0 ? (
              <select
                aria-label="Funding token"
                value={selectedToken?.address ?? ''}
                onChange={(e) => setSelectedToken(safeTokens.tokens.find((t) => t.address === e.target.value) ?? null)}
                className="px-2"
              >
                <option value="" disabled>Select a token…</option>
                {safeTokens.tokens.map((t) => (
                  <option key={t.address} value={t.address}>{t.symbol}</option>
                ))}
              </select>
            ) : (
              <p className="text-xs text-faint mt-1">No vetted tokens held by this Safe. Use a custom ERC-20 address.</p>
            )}
          </Block>

          <Block title="Recurring buy">
            <p className="text-xs text-dim -mt-1 leading-relaxed">The agent carries this out — it is your instruction, not an on-chain guarantee.</p>
            <div className="grid grid-cols-[1fr_140px] gap-2">
              <Field label={`Amount per buy`} required missing={buyAmount !== '' && !parseFloat(buyAmount)}>
                <div className="relative">
                  <input
                    type="text" inputMode="decimal" placeholder="50"
                    value={buyAmount}
                    onChange={(e) => setBuyAmount(dec(e.target.value))}
                    className="pr-12"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-faint">{fundingSymbol}</span>
                </div>
              </Field>
              <Field label="Every">
                <select value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)} className="px-2">
                  {FREQUENCIES.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Buy this token" required missing={targetToken !== '' && !targetValid}>
              <div className="flex items-center justify-end mb-1.5">
                <Segmented
                  value={buyMode}
                  onChange={setBuyMode}
                  options={[{ key: 'whitelist', label: 'Available tokens' }, { key: 'custom', label: 'Custom ERC-20' }]}
                />
              </div>
              {useCustomBuy ? (
                <input
                  type="text" placeholder="Token 0x…" value={customBuy}
                  onChange={(e) => setCustomBuy(e.target.value)}
                  className={`font-mono ${customBuy && !targetValid ? 'ring-1 ring-danger' : ''}`}
                />
              ) : buyTokens.loading ? (
                <p className="text-xs text-faint mt-1">Loading vetted tokens…</p>
              ) : buyTokens.tokens.length > 0 ? (
                <select
                  aria-label="Buy token"
                  value={selectedBuy?.address ?? ''}
                  onChange={(e) => setSelectedBuy(buyTokens.tokens.find((t) => t.address === e.target.value) ?? null)}
                  className="px-2"
                >
                  <option value="" disabled>Select a token…</option>
                  {buyTokens.tokens.map((t) => (
                    <option key={t.address} value={t.address}>{t.symbol}</option>
                  ))}
                </select>
              ) : (
                <p className="text-xs text-faint mt-1">No vetted tokens on this chain. Use a custom ERC-20 address.</p>
              )}
            </Field>
          </Block>

          <Block title="Guardrail">
            <p className="text-xs text-dim -mt-1 leading-relaxed">Enforced on-chain — the agent can never exceed the spend or pay above the price, whatever it does.</p>
            <Field label="Max per swap" required missing={cap !== '' && capRaw === 0n}>
              <div className="relative">
                <input
                  type="text" inputMode="decimal" placeholder="55"
                  value={cap}
                  onChange={(e) => setCap(dec(e.target.value))}
                  className="pr-12"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-faint">{fundingSymbol}</span>
              </div>
            </Field>
            <Field label="Max price" hint="The swap only clears at or below this price. Leave empty to skip the price floor.">
              <div className="relative">
                <input
                  type="text" inputMode="decimal" placeholder="3000"
                  value={maxPrice}
                  onChange={(e) => setMaxPrice(dec(e.target.value))}
                  className="pr-24"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-faint">{fundingSymbol} / {selectedBuy?.symbol ?? 'token'}</span>
              </div>
            </Field>
          </Block>
          </div>
        </div>

        <Card className="p-5 flex flex-col">
          <div className="flex items-center gap-2 text-xs font-semibold text-faint uppercase tracking-wide"><IconLock size={15} /> Summary</div>

          <div className="mt-4 space-y-3 text-sm">
            <div className="rounded-xl bg-raised ring-1 ring-line p-3">
              <div className="text-faint text-xs">Strategy · agent-run</div>
              {buyAmount ? (
                <div className="font-mono font-bold text-ink tnum mt-0.5" style={{ fontSize: 18 }}>{buyAmount} <span className="text-dim text-sm font-semibold">{fundingSymbol} / {frequency}</span></div>
              ) : (
                <div className="text-sm font-semibold text-faint mt-0.5">set a recurring buy</div>
              )}
            </div>

            <div className="rounded-xl bg-raised ring-1 ring-line p-3">
              <div className="text-faint text-xs">Guardrail · on-chain</div>
              {capRaw > 0n ? (
                <div className="font-mono font-bold text-ink tnum mt-0.5" style={{ fontSize: 18 }}>≤ {cap} <span className="text-dim text-sm font-semibold">{fundingSymbol} / swap</span></div>
              ) : (
                <div className="text-sm font-semibold text-faint mt-0.5">set a cap</div>
              )}
            </div>

            <PreviewRow label="Buy">
              <span className="text-ink text-xs">{selectedBuy ? selectedBuy.symbol : targetValid ? short(targetToken) : '—'}</span>
            </PreviewRow>
            <PreviewRow label="Agent">
              {agentValid ? <Mono className="text-xs text-dim">{short(agent)}</Mono> : <span className="text-[11px] text-faint">not set</span>}
            </PreviewRow>
          </div>

          <div className="mt-auto pt-4 border-t border-line space-y-3">
            {step === 'done' ? (
              <div className="rounded-xl glass-soft ring-1 ring-line p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium text-active">
                  <IconCheck size={16} /> Strategy signed.
                </div>
                <p className="text-xs text-dim leading-relaxed">
                  The cap is on-chain; the recurring buy is not. Hand this instruction to your agent — it pairs it with the
                  mandate it discovers on Intuition.
                </p>
                {recap && <CopyChip value={recap} label="Copy agent instruction" />}
              </div>
            ) : (
              <Btn kind="primary" size="lg" onClick={handleSign} disabled={!canSign} className="w-full">
                {step === 'preparing' ? 'Preparing…' : step === 'signing' ? 'Signing…' : 'Sign strategy'}
              </Btn>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}
