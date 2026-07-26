import { useState, useEffect } from 'react'
import { useSafeAppsSDK } from '@safe-global/safe-apps-react-sdk'
import { createPublicClient, http, isAddress, parseUnits, parseEther, type Address, type Hex } from 'viem'
import { readErc20Meta } from '../lib/erc20'
import { useSafeTokens } from '../hooks/useSafeTokens'
import { useWhitelistedTokens } from '../hooks/useWhitelistedTokens'
import type { HeldToken } from '../lib/safe-balances'
import type { WhitelistedToken } from '../lib/token-list'
import { buildLimitOrderMandate } from '../lib/limitOrderMandate'
import { buildDelegationTypedData, computeDelegationHash } from '../lib/delegations'
import { getEnvironment } from '../lib/environment'
import { getAddresses } from '../config/addresses'
import { DeleGatorModuleFactoryABI } from '../config/abis'
import { DEFAULT_SALT } from '../lib/module'
import { UNIVERSAL_ROUTER } from '../config/uniswap'
import { checkPermit2, buildPermit2Setup } from '../lib/permit2'
import { findChain, rpcUrl } from '../config/supported-chains'
import { saveDelegation } from '../lib/storage'
import { Card, Btn, Mono, CopyChip } from '../ui/components'
import { useAgentRun } from '../hooks/useAgentRun'
import { finalizePending } from '../hooks/useFinalizePending'
import type { AgentInstruction } from '../lib/agent-service'
import { Block, Field, Segmented, PreviewRow } from '../ui/form'
import { IconLock, IconCheck, IconAlert } from '../ui/icons'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const dec = (v: string) => v.replace(',', '.').replace(/[^\d.]/g, '')

/** One redeem costs ~440k gas on Base; this covers it with room, and it is the loss
 *  ceiling if the order never fills (ADR 0007 — the residue has no return path yet). */
const AGENT_GAS_ETH = '0.0006'

type SignStep = 'idle' | 'preparing' | 'signing' | 'done'

export default function LimitOrder() {
  const { sdk, safe } = useSafeAppsSDK()
  const safeTokens = useSafeTokens(safe.safeAddress as Address, safe.chainId)
  const buyTokens = useWhitelistedTokens(safe.chainId)

  const [tokenMode, setTokenMode] = useState<'whitelist' | 'custom'>('whitelist')
  const [selectedToken, setSelectedToken] = useState<HeldToken | null>(null)
  const [customToken, setCustomToken] = useState('')
  const [customFundingDecimals, setCustomFundingDecimals] = useState<number | null>(null)
  const [buyMode, setBuyMode] = useState<'whitelist' | 'custom'>('whitelist')
  const [selectedBuy, setSelectedBuy] = useState<WhitelistedToken | null>(null)
  const [customBuy, setCustomBuy] = useState('')
  const [customBuyDecimals, setCustomBuyDecimals] = useState<number | null>(null)
  const [spend, setSpend] = useState('')
  const [triggerPrice, setTriggerPrice] = useState('')
  const [agent, setAgent] = useState('')
  const [step, setStep] = useState<SignStep>('idle')
  const [error, setError] = useState<string | null>(null)
  const [recap, setRecap] = useState<string | null>(null)
  // Permit2 setup: null = unknown/checking, true = the Safe can trade, false = needs setup.
  const [agentMode, setAgentMode] = useState<'self' | 'hosted'>('self')
  const agentSvc = useAgentRun()
  const [permit2Ready, setPermit2Ready] = useState<boolean | null>(null)
  const [permit2Busy, setPermit2Busy] = useState(false)
  const [fundingAgent, setFundingAgent] = useState(false)
  const [publishing, setPublishing] = useState(false)

  const useCustom = tokenMode === 'custom'
  const fundingAddress = useCustom ? customToken : (selectedToken?.address ?? '')
  const fundingSymbol = useCustom ? 'tokens' : (selectedToken?.symbol ?? 'token')
  const useCustomBuy = buyMode === 'custom'
  const targetToken = useCustomBuy ? customBuy : (selectedBuy?.address ?? '')
  const targetSymbol = useCustomBuy ? 'token' : (selectedBuy?.symbol ?? 'token')

  useEffect(() => {
    if (!useCustom || !isAddress(customToken)) { setCustomFundingDecimals(null); return }
    const chain = findChain(safe.chainId); if (!chain) return
    const client = createPublicClient({ chain, transport: http(rpcUrl(safe.chainId)) })
    let cancelled = false
    readErc20Meta(client, customToken as Address).then((m) => { if (!cancelled) setCustomFundingDecimals(m.decimals) }).catch(() => { if (!cancelled) setCustomFundingDecimals(null) })
    return () => { cancelled = true }
  }, [useCustom, customToken, safe.chainId])

  useEffect(() => {
    if (!useCustomBuy || !isAddress(customBuy)) { setCustomBuyDecimals(null); return }
    const chain = findChain(safe.chainId); if (!chain) return
    const client = createPublicClient({ chain, transport: http(rpcUrl(safe.chainId)) })
    let cancelled = false
    readErc20Meta(client, customBuy as Address).then((m) => { if (!cancelled) setCustomBuyDecimals(m.decimals) }).catch(() => { if (!cancelled) setCustomBuyDecimals(null) })
    return () => { cancelled = true }
  }, [useCustomBuy, customBuy, safe.chainId])

  const decimals = useCustom ? customFundingDecimals : (selectedToken?.decimals ?? null)
  const targetDecimals = useCustomBuy ? customBuyDecimals : (selectedBuy?.decimals ?? null)

  const spendRaw = (() => { try { return spend && decimals !== null ? parseUnits(spend, decimals) : 0n } catch { return 0n } })()

  // Min received (raw, target units) = spend / triggerPrice. Buying only clears
  // when the market returns at least this much — i.e. the price is at or below the
  // trigger. A lower (cheaper) price returns more, so it clears; a higher one reverts.
  const minReceivedRaw = (() => {
    const s = parseFloat(spend); const p = parseFloat(triggerPrice)
    if (!(s > 0) || !(p > 0) || targetDecimals === null) return 0n
    try { return parseUnits((s / p).toFixed(targetDecimals), targetDecimals) } catch { return 0n }
  })()

  const fundingValid = isAddress(fundingAddress)
  const targetValid = isAddress(targetToken)
  // In hosted mode the address is the one the service provisioned, not a typed field.
  const effectiveAgent = agentMode === 'hosted' ? (agentSvc.agentAddress ?? '') : agent
  const agentValid = isAddress(effectiveAgent)
  const router = UNIVERSAL_ROUTER[safe.chainId]
  const canSign = Boolean(fundingValid && targetValid && spendRaw > 0n && minReceivedRaw > 0n && agentValid && router && step === 'idle')

  // Does the Safe already hold the Permit2 allowances the router needs to pull the
  // funding token? Re-check whenever the token or spend changes. The swap redeem
  // reverts (Permit2 AllowanceExpired) without this one-time setup.
  useEffect(() => {
    if (!fundingValid || spendRaw <= 0n || !router) { setPermit2Ready(null); return }
    const chain = findChain(safe.chainId); if (!chain) return
    const client = createPublicClient({ chain, transport: http(rpcUrl(safe.chainId)) })
    let cancelled = false
    checkPermit2(client, { safe: safe.safeAddress as Address, token: fundingAddress as Address, router, amount: spendRaw, now: Math.floor(Date.now() / 1000) })
      .then((s) => { if (!cancelled) setPermit2Ready(s.ready) })
      .catch(() => { if (!cancelled) setPermit2Ready(null) })
    return () => { cancelled = true }
  }, [fundingValid, fundingAddress, spendRaw, router, safe.chainId, safe.safeAddress, permit2Busy])

  async function handleEnableTrading() {
    setError(null)
    if (!router || !fundingValid) return
    setPermit2Busy(true)
    try {
      const chain = findChain(safe.chainId)
      if (!chain) throw new Error('Unsupported chain')
      const client = createPublicClient({ chain, transport: http(rpcUrl(safe.chainId)) })
      const status = await checkPermit2(client, { safe: safe.safeAddress as Address, token: fundingAddress as Address, router, amount: spendRaw, now: Math.floor(Date.now() / 1000) })
      const txs = buildPermit2Setup(fundingAddress as Address, router, status)
      if (txs.length === 0) { setPermit2Ready(true); return }
      // One batched Safe transaction (both approvals) — a single signing action.
      await sdk.txs.send({ txs })
      // The Safe tx is async (multisig); flip the flag to re-check once mined.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to enable trading')
    } finally {
      setPermit2Busy(false)
    }
  }


  /** Gas for the agent, as its own Safe transaction — never bundled with the Permit2
   *  setup: two unrelated consents in one approval is not something a signer can read. */
  async function handleFundAgent() {
    setError(null)
    if (!agentValid) return
    setFundingAgent(true)
    try {
      await sdk.txs.send({ txs: [{ to: effectiveAgent, value: parseEther(AGENT_GAS_ETH).toString(), data: '0x' }] })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fund the agent')
    } finally {
      setFundingAgent(false)
    }
  }

  async function handleStartAgent() {
    setError(null)
    if (!recap) return
    setPublishing(true)
    try {
      // Publish before starting. The agent discovers its mandate on Intuition, and
      // until this runs the mandate is signed but unindexed — the run would exit on
      // "not found on Intuition yet" and read as a failure. This is the same pass the
      // app does on open; doing it here means the operator never has to reload.
      await finalizePending(safe.chainId, safe.safeAddress as Address)
    } catch {
      // Already-published is the common case and it is a no-op; a real failure
      // surfaces as the agent not finding the mandate, which says more than we could.
    } finally {
      setPublishing(false)
    }
    await agentSvc.start(JSON.parse(recap) as AgentInstruction)
  }

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

      const mandate = buildLimitOrderMandate({
        moduleAddress,
        agentAddress: effectiveAgent as Address,
        environment: getEnvironment(safe.chainId),
        swapRouter: router,
        // The balance-change bounds watch the Safe, not the module: the module
        // executes via safe.execTransactionFromModule, so the swap runs with
        // msg.sender == the Safe — the Safe spends the funding token and receives
        // the bought token. Watching the module (which holds nothing) makes the
        // Increase bound see no gain → ERC20BalanceChangeEnforcer reverts.
        recipient: safe.safeAddress as Address,
        fundingToken: fundingAddress as Address,
        targetToken: targetToken as Address,
        maxSpend: spendRaw,
        minReceived: minReceivedRaw,
      })

      setStep('signing')
      const typedData = buildDelegationTypedData(mandate, safe.chainId)
      const result = (await sdk.txs.signTypedMessage(typedData as never)) as { signature?: Hex; safeTxHash?: Hex }
      const signed = { ...mandate, signature: (result?.signature || result?.safeTxHash || '0x') as Hex }
      const delegationHash = computeDelegationHash(signed)

      saveDelegation({
        delegation: signed,
        meta: {
          label: 'Limit order',
          scopeType: 'strategyMandate',
          createdAt: new Date().toISOString(),
          chainId: safe.chainId,
          safeAddress: safe.safeAddress as Address,
          moduleAddress,
          status: 'signed',
          delegationHash,
          safeMessageHash: result?.safeTxHash,
          recipient: effectiveAgent as Address,
          strategyKind: 'limitOrder',
          tokenAddress: fundingAddress as Address,
          targetToken: targetToken as Address,
          amount: spend,
          capPerSwap: spend,
          enforceDecrease: true,
        },
      })

      setRecap(JSON.stringify({
        hourglassStrategy: 'limitOrder',
        chainId: safe.chainId,
        safe: safe.safeAddress,
        agent: effectiveAgent,
        delegationHash,
        fundingToken: fundingAddress,
        targetToken,
        maxSpend: spend,
        triggerPrice,
      }, null, 2))
      setStep('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sign the order')
      setStep('idle')
    }
  }

  return (
    <div className="rise">
      <div className="mb-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Limit order</h1>
        <p className="text-dim text-sm mt-1">
          A single buy an agent fires once the price drops to your trigger — spend and price both enforced on-chain. The
          agent watches the market; it can never overspend or overpay.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-pending text-sm mb-6">
          <IconAlert size={16} /> {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_minmax(300px,360px)] gap-6 items-stretch">
        <div className="space-y-5">
          <Block
            title="Agent"
            action={
              agentSvc.available ? (
                <Segmented
                  value={agentMode}
                  onChange={setAgentMode}
                  options={[{ key: 'self', label: 'I run it' }, { key: 'hosted', label: 'Run it for me' }]}
                />
              ) : undefined
            }
          >
            {agentMode === 'self' ? (
              <>
                <p className="text-xs text-dim -mt-1 leading-relaxed">
                  You run the agent (via the{' '}
                  <a href="https://github.com/intuition-box/Hourglass/tree/main/skills/hourglass-agent" target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2" style={{ color: '#34D399' }}>Hourglass skill</a>
                  ). Paste its address; the rest stays locked until you do.
                </p>
                <Field label="Agent address" required missing={agent !== '' && !agentValid}>
                  <input type="text" placeholder="0x…" value={agent} onChange={(e) => setAgent(e.target.value)} className={`font-mono ${agent && !agentValid ? 'ring-1 ring-danger' : ''}`} />
                </Field>
              </>
            ) : (
              <>
                <p className="text-xs text-dim -mt-1 leading-relaxed">
                  Hourglass runs the agent and holds its key. The key only ever pays gas — your spend and your price stay
                  bounded on-chain, so a misbehaving agent still cannot overspend or overpay.
                </p>
                {agentSvc.agentAddress ? (
                  <div className="flex items-center gap-2 mt-1">
                    <IconCheck size={14} />
                    <Mono className="text-xs text-dim">{short(agentSvc.agentAddress)}</Mono>
                    <CopyChip value={agentSvc.agentAddress} label="Copy" />
                  </div>
                ) : (
                  <Btn kind="secondary" onClick={() => void agentSvc.provision()} disabled={agentSvc.provisioning} className="mt-1">
                    {agentSvc.provisioning ? 'Creating the agent…' : 'Execute with an agent'}
                  </Btn>
                )}
                {agentSvc.error && <p className="text-xs text-pending mt-2">{agentSvc.error}</p>}
              </>
            )}
          </Block>

          <div className={agentValid ? 'space-y-5' : 'space-y-5 opacity-40 pointer-events-none select-none'} aria-disabled={!agentValid}>
            <Block
              title="Pay with"
              action={<Segmented value={tokenMode} onChange={setTokenMode} options={[{ key: 'whitelist', label: 'Available tokens' }, { key: 'custom', label: 'Custom ERC-20' }]} />}
            >
              {useCustom ? (
                <input type="text" placeholder="Token 0x…" value={customToken} onChange={(e) => setCustomToken(e.target.value)} />
              ) : safeTokens.loading ? (
                <p className="text-xs text-faint mt-1">Reading tokens held by the Safe…</p>
              ) : safeTokens.tokens.length > 0 ? (
                <select aria-label="Funding token" value={selectedToken?.address ?? ''} onChange={(e) => setSelectedToken(safeTokens.tokens.find((t) => t.address === e.target.value) ?? null)} className="px-2">
                  <option value="" disabled>Select a token…</option>
                  {safeTokens.tokens.map((t) => <option key={t.address} value={t.address}>{t.symbol}</option>)}
                </select>
              ) : (
                <p className="text-xs text-faint mt-1">No vetted tokens held by this Safe. Use a custom ERC-20 address.</p>
              )}
              <Field label="Spend up to" required missing={spend !== '' && spendRaw === 0n}>
                <div className="relative">
                  <input type="text" inputMode="decimal" placeholder="500" value={spend} onChange={(e) => setSpend(dec(e.target.value))} className="pr-12" />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-faint">{fundingSymbol}</span>
                </div>
              </Field>
            </Block>

            <Block
              title="Buy"
              action={<Segmented value={buyMode} onChange={setBuyMode} options={[{ key: 'whitelist', label: 'Available tokens' }, { key: 'custom', label: 'Custom ERC-20' }]} />}
            >
              {useCustomBuy ? (
                <input type="text" placeholder="Token 0x…" value={customBuy} onChange={(e) => setCustomBuy(e.target.value)} className="font-mono" />
              ) : buyTokens.loading ? (
                <p className="text-xs text-faint mt-1">Loading vetted tokens…</p>
              ) : buyTokens.tokens.length > 0 ? (
                <select aria-label="Buy token" value={selectedBuy?.address ?? ''} onChange={(e) => setSelectedBuy(buyTokens.tokens.find((t) => t.address === e.target.value) ?? null)} className="px-2">
                  <option value="" disabled>Select a token…</option>
                  {buyTokens.tokens.map((t) => <option key={t.address} value={t.address}>{t.symbol}</option>)}
                </select>
              ) : (
                <p className="text-xs text-faint mt-1">No vetted tokens on this chain. Use a custom ERC-20 address.</p>
              )}
              <Field label="Trigger price" required missing={triggerPrice !== '' && minReceivedRaw === 0n} hint="Buys only when the price is at or below this.">
                <div className="relative">
                  <input type="text" inputMode="decimal" placeholder="3000" value={triggerPrice} onChange={(e) => setTriggerPrice(dec(e.target.value))} className="pr-24" />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-faint">{fundingSymbol} / {targetSymbol}</span>
                </div>
              </Field>
            </Block>
          </div>
        </div>

        <Card className="p-5 flex flex-col">
          <div className="flex items-center gap-2 text-xs font-semibold text-faint uppercase tracking-wide"><IconLock size={15} /> Enforced on-chain</div>

          <div className="mt-4 space-y-3 text-sm">
            <div className="rounded-xl bg-raised ring-1 ring-line p-3">
              <div className="text-faint text-xs">Buy once, at or below</div>
              {triggerPrice && targetValid ? (
                <div className="font-mono font-bold text-ink tnum mt-0.5" style={{ fontSize: 18 }}>{triggerPrice} <span className="text-dim text-sm font-semibold">{fundingSymbol} / {targetSymbol}</span></div>
              ) : (
                <div className="text-sm font-semibold text-faint mt-0.5">set a trigger price</div>
              )}
            </div>
            <PreviewRow label="Spend up to">
              <span className="text-ink text-xs">{spendRaw > 0n ? `${spend} ${fundingSymbol}` : '—'}</span>
            </PreviewRow>
            <PreviewRow label="Buy">
              <span className="text-ink text-xs">{selectedBuy ? selectedBuy.symbol : targetValid ? short(targetToken) : '—'}</span>
            </PreviewRow>
            <PreviewRow label="Agent">
              {agentValid ? <Mono className="text-xs text-dim">{short(effectiveAgent)}</Mono> : <span className="text-[11px] text-faint">not set</span>}
            </PreviewRow>
          </div>

          <div className="mt-auto pt-4 border-t border-line space-y-3">
            {step === 'done' ? (
              <div className="rounded-xl glass-soft ring-1 ring-line p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium text-active"><IconCheck size={16} /> Order signed.</div>
                {agentMode === 'self' ? (
                  <>
                    <p className="text-xs text-dim leading-relaxed">Hand this instruction to your agent — it fires the buy once the price hits your trigger.</p>
                    {recap && <CopyChip value={recap} label="Copy agent instruction" />}
                  </>
                ) : (
                  <div className="space-y-3">
                    {/* Gas first, then start. The agent sends the redeem itself, so an
                        unfunded agent cannot fill — the service refuses to start on one. */}
                    <p className="text-xs text-dim leading-relaxed">
                      Send the agent gas, then start it. It only ever spends this on the redeem transaction.
                    </p>
                    <Btn kind="ghost" size="sm" onClick={handleFundAgent} disabled={fundingAgent} className="w-full">
                      {fundingAgent ? 'Submitting…' : `Send ${AGENT_GAS_ETH} ETH for gas`}
                    </Btn>
                    <Btn
                      kind="primary"
                      size="sm"
                      onClick={handleStartAgent}
                      disabled={publishing || agentSvc.starting || agentSvc.run?.state === 'running'}
                      className="w-full"
                    >
                      {publishing ? 'Publishing the mandate…' : agentSvc.starting ? 'Starting…' : agentSvc.run ? 'Restart agent' : 'Start agent'}
                    </Btn>
                    {agentSvc.run && (
                      <div className="rounded-lg bg-raised ring-1 ring-line p-3 space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] text-faint">Agent</span>
                          <span className="text-[11px] font-medium text-ink">{agentSvc.run.state}</span>
                        </div>
                        {agentSvc.run.detail && <p className="text-[11px] text-dim leading-relaxed">{agentSvc.run.detail}</p>}
                      </div>
                    )}
                    {agentSvc.error && <p className="text-[11px] text-pending leading-relaxed">{agentSvc.error}</p>}
                  </div>
                )}
              </div>
            ) : (
              <>
                {/* Permit2 is a one-time setup per funding token: the router pulls the
                    token through it, so without it the swap redeem reverts. */}
                {permit2Ready === false && (
                  <div className="rounded-xl bg-raised ring-1 ring-line p-3 space-y-2">
                    <div className="flex items-center gap-2 text-xs font-medium text-pending"><IconAlert size={14} /> One-time setup needed</div>
                    <p className="text-[11px] text-dim leading-relaxed">Allow the router to trade {fundingSymbol} from this Safe (Permit2). Signed once, reused by every order.</p>
                    <Btn kind="ghost" size="sm" onClick={handleEnableTrading} disabled={permit2Busy} className="w-full">
                      {permit2Busy ? 'Submitting…' : `Enable ${fundingSymbol} trading`}
                    </Btn>
                  </div>
                )}
                <Btn kind="primary" size="lg" onClick={handleSign} disabled={!canSign || permit2Ready === false} className="w-full">
                  {step === 'preparing' ? 'Preparing…' : step === 'signing' ? 'Signing…' : 'Sign order'}
                </Btn>
              </>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}
