import { useState, useEffect } from 'react'
import { useSafeAppsSDK } from '@safe-global/safe-apps-react-sdk'
import { createPublicClient, http, type Address } from 'viem'
import { DeleGatorModuleFactoryABI, SafeABI } from '../config/abis'
import { getAddresses } from '../config/addresses'
import { buildModuleInstallTxs, DEFAULT_SALT } from '../lib/module'
import { getDelegations, type StoredDelegation } from '../lib/storage'
import { getLimitOrderExecution } from '../lib/limitOrderStatus'
import { portalAtomUrl } from '../lib/intuition'
import { SubscriptionDetail } from './SubscriptionDetail'
import { Card, Btn, StatusBadge, Payee, STATUS, type Status } from '../ui/components'
import { IconChip, IconCheck, IconPlus, IconRepeat, IconLock, IconCube, IconExt, IconAlert, IconArrowR } from '../ui/icons'
import { findChain, rpcUrl } from '../config/supported-chains'

type Page = 'home' | 'create' | 'redeem'

function tintFor(addr: string): { tint: string; logo: string } {
  const palette = ['#3B82F6', '#22D3EE', '#8B5CF6', '#34D399', '#FB7185', '#FBBF24']
  let h = 0
  for (let i = 2; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) >>> 0
  return { tint: palette[h % palette.length], logo: addr.slice(2, 4).toUpperCase() }
}
function statusOf(s: StoredDelegation['meta']['status'], executed = false): Status {
  if (executed) return 'executed'
  return s === 'signed' ? 'active' : s === 'revoked' ? 'revoked' : 'pending'
}
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

function SubCard({ d, onOpen, executedTx }: { d: StoredDelegation; onOpen: () => void; executedTx?: string }) {
  const status = statusOf(d.meta.status, executedTx !== undefined)
  const stream = d.meta.scopeType === 'erc20Streaming'
  const payeeAddr = d.meta.recipient ?? d.delegation.delegate
  const { tint, logo } = tintFor(payeeAddr)
  const dim = status === 'revoked' || status === 'executed'
  return (
    <Card hover onClick={onOpen} className={`p-5 cursor-pointer relative ${dim ? 'opacity-70' : ''}`}>
      <span className="absolute left-0 top-5 bottom-5 w-[3px] rounded-full" style={{ background: STATUS[status].dot }} />
      <div className="flex items-start justify-between gap-3">
        <Payee logo={logo} tint={tint} name={d.meta.label} addr={short(payeeAddr)} />
        <div className="flex items-center gap-2 shrink-0">
          {stream && <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: '#22D3EE' }}><IconRepeat size={11} /> stream</span>}
          {status === 'executed' && executedTx ? (
            <a href={executedTx} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1" title="View execution tx">
              <StatusBadge status={status} size="sm" />
              <IconExt size={12} className="text-faint" />
            </a>
          ) : (
            <StatusBadge status={status} size="sm" />
          )}
        </div>
      </div>
      <div className="mt-5 flex items-end gap-2">
        <span className="font-mono font-bold text-ink tnum leading-none" style={{ fontSize: 30 }}>{(stream ? d.meta.ratePerPeriod : d.meta.amount) ?? '—'}</span>
        <span className="text-dim text-sm mb-0.5">{d.meta.tokenAddress ? 'USDC' : ''} / {(stream ? d.meta.ratePeriod : d.meta.period) ?? 'period'}</span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <div className="rounded-lg glass-soft ring-1 ring-line px-3 py-2">
          <div className="text-faint">{stream ? 'Accrues' : 'Period'}</div>
          <div className="text-ink font-semibold mt-0.5">{(stream ? d.meta.ratePeriod : d.meta.period) ?? '—'}</div>
        </div>
        <div className="rounded-lg glass-soft ring-1 ring-line px-3 py-2">
          <div className="text-faint flex items-center gap-1">{stream ? <><IconRepeat size={11} /> Rate</> : <><IconLock size={11} /> On-chain cap</>}</div>
          <div className="text-ink font-semibold mt-0.5 font-mono tnum">{(stream ? d.meta.ratePerPeriod : d.meta.amount) ?? '—'}</div>
        </div>
      </div>
      {(() => {
        // Prefer the Intuition portal (the DelegationJson atom); fall back to the
        // real IPFS link. An offline `local-` pin has no working URL → no link.
        const portal = d.meta.intuition
          ? portalAtomUrl(d.meta.intuition.atomId, d.meta.intuition.network)
          : undefined
        const ipfs = d.meta.agreement && !d.meta.agreement.uri.startsWith('ipfs://local-')
          ? `https://gateway.pinata.cloud/ipfs/${d.meta.agreement.cid}`
          : undefined
        const href = portal ?? ipfs
        if (!href) return null
        return (
          <div className="mt-4 pt-4 border-t border-line">
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1.5 text-xs font-mono text-dim hover:text-[color:var(--accent)] transition"
            >
              <IconCube size={13} /> {portal ? 'View on Intuition' : `${d.meta.agreement!.cid.slice(0, 16)}…`} <IconExt size={11} className="opacity-60" />
            </a>
          </div>
        )
      })()}
    </Card>
  )
}

export default function Home({ onNavigate }: { onNavigate: (page: Page) => void }) {
  const { sdk, safe } = useSafeAppsSDK()
  const [moduleStatus, setModuleStatus] = useState<'loading' | 'installed' | 'not-installed' | 'error'>('loading')
  const [moduleAddress, setModuleAddress] = useState<Address | null>(null)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [safeInfo, setSafeInfo] = useState<{ owners: string[]; threshold: number } | null>(null)
  const [subs, setSubs] = useState<StoredDelegation[]>(() => getDelegations())
  const [selected, setSelected] = useState<StoredDelegation | null>(null)
  // Limit orders are one-shot; once fired on-chain, show them as Executed not Active,
  // with a link to the redemption tx. Keyed by delegationHash → explorer URL ('' = no link).
  const [executed, setExecuted] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    const orders = subs.filter((d) => d.meta.strategyKind === 'limitOrder' && d.meta.status === 'signed')
    if (orders.length === 0) return
    let cancelled = false
    Promise.all(orders.map(async (d) => {
      const ex = await getLimitOrderExecution(d.meta.chainId, d.meta.delegationHash, d.meta.createdAt)
      return ex.executed ? ([d.meta.delegationHash.toLowerCase(), ex.txUrl ?? ''] as const) : null
    }))
      .then((hits) => { if (!cancelled) setExecuted(new Map(hits.filter((h): h is readonly [string, string] => h !== null))) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [subs])

  function refresh() {
    const next = getDelegations()
    setSubs(next)
    setSelected((cur) => (cur ? next.find((x) => x.meta.delegationHash === cur.meta.delegationHash) ?? null : null))
  }

  useEffect(() => {
    checkModuleStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safe.safeAddress, safe.chainId])

  async function checkModuleStatus() {
    try {
      setModuleStatus('loading')
      const chain = findChain(safe.chainId)
      if (!chain) {
        setError(`Unsupported chain: ${safe.chainId}`)
        setModuleStatus('error')
        return
      }
      const client = createPublicClient({ chain, transport: http(rpcUrl(safe.chainId)) })
      const addrs = getAddresses(safe.chainId)
      const predicted = (await client.readContract({
        address: addrs.delegatorModuleFactory,
        abi: DeleGatorModuleFactoryABI,
        functionName: 'predictAddress',
        args: [safe.safeAddress as Address, DEFAULT_SALT],
      })) as Address
      setModuleAddress(predicted)
      const isEnabled = await client.readContract({
        address: safe.safeAddress as Address,
        abi: SafeABI,
        functionName: 'isModuleEnabled',
        args: [predicted],
      })
      try {
        const owners = (await client.readContract({ address: safe.safeAddress as Address, abi: SafeABI, functionName: 'getOwners' })) as string[]
        const threshold = (await client.readContract({ address: safe.safeAddress as Address, abi: SafeABI, functionName: 'getThreshold' })) as bigint
        setSafeInfo({ owners, threshold: Number(threshold) })
      } catch {
        // non-critical
      }
      setModuleStatus(isEnabled ? 'installed' : 'not-installed')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to check module status'
      setError(msg)
      setModuleStatus('error')
    }
  }

  async function installModule() {
    if (!moduleAddress) return
    setInstalling(true)
    setError(null)
    try {
      const txs = buildModuleInstallTxs(safe.safeAddress as Address, safe.chainId, moduleAddress)
      await sdk.txs.send({ txs })
      setModuleStatus('installed')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to propose module installation')
    } finally {
      setInstalling(false)
    }
  }

  const active = subs.filter((s) => s.meta.status === 'signed')
  // Total engaged: the plain sum of each active mandate's headline amount — the same
  // figure shown on its card (a stream shows its per-period rate, everything else its
  // amount). No per-period normalisation, so a limit order (period 'swap') or any
  // non-recurring mandate is counted too.
  const committed = active.reduce((sum, s) => {
    const shown = s.meta.scopeType === 'erc20Streaming' ? s.meta.ratePerPeriod : s.meta.amount
    const amount = parseFloat((shown ?? '0').replace(/,/g, ''))
    return Number.isFinite(amount) ? sum + amount : sum
  }, 0)

  return (
    <div className="rise">
      {/* Module status banner */}
      {moduleStatus === 'installed' ? (
        <div className="flex items-center justify-between gap-4 rounded-2xl px-4 py-3 mb-6 glass-soft" style={{ background: 'rgba(52,211,153,.07)', boxShadow: 'inset 0 0 0 1px rgba(52,211,153,.22)' }}>
          <div className="flex items-center gap-3 min-w-0">
            <div className="grid place-items-center w-9 h-9 rounded-xl shrink-0" style={{ background: 'rgba(52,211,153,.14)', color: '#34D399' }}>
              <IconChip size={18} />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-ink flex items-center gap-2">
                HourGlass module enabled
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-active"><IconCheck size={12} /> ready</span>
              </div>
              <div className="text-xs text-dim font-mono truncate">
                Safe {short(safe.safeAddress)}{safeInfo ? ` · ${safeInfo.threshold}/${safeInfo.owners.length} signers` : ''}
              </div>
            </div>
          </div>
        </div>
      ) : moduleStatus === 'not-installed' ? (
        <Card className="p-5 mb-6">
          <div className="flex items-start gap-3">
            <div className="grid place-items-center w-9 h-9 rounded-xl shrink-0 bg-raised text-danger ring-1 ring-line"><IconAlert size={18} /></div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-ink">HourGlass module not installed</div>
              <p className="text-xs text-dim mt-1 leading-relaxed">Enable the DeleGator (ERC-7710) module on your Safe to start creating subscriptions. One-time setup — all signers approve.</p>
              {moduleAddress && <p className="text-[11px] text-faint font-mono mt-2 truncate">module: {moduleAddress}</p>}
              <div className="mt-3">
                <Btn kind="primary" onClick={installModule} disabled={installing}>
                  {installing ? 'Proposing…' : 'Install module'}
                </Btn>
              </div>
            </div>
          </div>
        </Card>
      ) : moduleStatus === 'error' ? (
        <Card className="p-4 mb-6">
          <div className="flex items-center gap-2 text-pending text-sm font-medium"><IconAlert size={16} /> {error ?? 'Configuration needed'}</div>
        </Card>
      ) : (
        <div className="text-dim text-sm mb-6 flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-line border-t-[color:var(--accent)] rounded-full animate-spin" /> Checking module…
        </div>
      )}

      {/* Header */}
      <div className="flex items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">Subscriptions</h1>
          <p className="text-dim text-sm mt-1">Recurring USDC charges, capped on-chain.</p>
        </div>
        <Btn kind="primary" icon={<IconPlus size={18} />} onClick={() => onNavigate('create')}>New subscription</Btn>
      </div>

      {/* Stats (no ETH-spent / gasless stat by design choice) */}
      <div className="mb-6">
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs text-faint"><IconRepeat size={16} /> Total engaged</div>
          <div className="mt-2 font-mono font-bold text-ink tnum" style={{ fontSize: 24 }}>${committed.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
          <div className="text-xs text-dim mt-1">{active.length} active mandate{active.length === 1 ? '' : 's'}</div>
        </Card>
      </div>

      {/* Subscriptions grid */}
      {subs.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-dim text-sm">No subscriptions yet.</p>
          <div className="mt-3 inline-flex">
            <Btn kind="secondary" icon={<IconArrowR size={16} />} onClick={() => onNavigate('create')}>Create your first</Btn>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {subs.map((d) => (
            <SubCard key={d.meta.delegationHash} d={d} onOpen={() => setSelected(d)} executedTx={executed.get(d.meta.delegationHash.toLowerCase())} />
          ))}
        </div>
      )}

      {selected && <SubscriptionDetail d={selected} onClose={() => setSelected(null)} onChanged={refresh} />}
    </div>
  )
}
