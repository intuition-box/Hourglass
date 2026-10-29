import { useEffect, useState, type ReactNode } from 'react'
import { useSafeAppsSDK } from '@safe-global/safe-apps-react-sdk'
import { ipfsToHttp } from '../lib/subscriptionTerms'
import { portalAtomUrl } from '../lib/intuition'
import { buildRevokeTxs } from '../lib/revoke'
import { updateDelegationStatus, removeDelegation, type StoredDelegation } from '../lib/storage'
import { Card, Btn, StatusBadge, Payee, Mono, CopyChip, type Status } from '../ui/components'
import { IconX, IconStop, IconCube, IconExt, IconLock, IconCal, IconRepeat } from '../ui/icons'
import { chainName } from '../config/supported-chains'

const statusOf = (s: StoredDelegation['meta']['status']): Status =>
  s === 'signed' ? 'active' : s === 'revoked' ? 'revoked' : 'pending'
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const tintFor = (addr: string) => {
  const palette = ['#3B82F6', '#22D3EE', '#8B5CF6', '#34D399', '#FB7185', '#FBBF24']
  let h = 0
  for (let i = 2; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 border-b border-line last:border-0">
      <span className="text-xs text-faint shrink-0 pt-0.5">{label}</span>
      <span className="text-right min-w-0">{children}</span>
    </div>
  )
}

const token = (d: StoredDelegation) => (d.meta.tokenAddress ? 'USDC' : 'ETH')

export function SubscriptionDetail({
  d,
  onClose,
  onChanged,
}: {
  d: StoredDelegation
  onClose: () => void
  onChanged: () => void
}) {
  const { sdk, safe } = useSafeAppsSDK()
  const [revoking, setRevoking] = useState(false)
  const status = statusOf(d.meta.status)
  const stream = d.meta.scopeType === 'erc20Streaming'
  const payeeAddr = d.meta.recipient ?? d.delegation.delegate
  const httpUri =
    d.meta.agreement && !d.meta.agreement.uri.startsWith('ipfs://local-')
      ? ipfsToHttp(d.meta.agreement.uri)
      : undefined
  // Prefer the Intuition portal (the DelegationJson atom) once published.
  const intuitionUrl = d.meta.intuition
    ? portalAtomUrl(d.meta.intuition.atomId, d.meta.intuition.network)
    : undefined
  const agreementUrl = intuitionUrl ?? httpUri

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleRevoke() {
    setRevoking(true)
    try {
      await sdk.txs.send({ txs: buildRevokeTxs(d, safe.chainId) })
      updateDelegationStatus(d.meta.delegationHash, 'revoked')
      onChanged()
    } catch (err) {
      console.error('Revoke failed:', err)
    } finally {
      setRevoking(false)
    }
  }

  function handleRemove() {
    removeDelegation(d.meta.delegationHash)
    onChanged()
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-6 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label={`Subscription ${d.meta.label}`}
    >
      <button aria-label="Close" onClick={onClose} className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
      <Card className="relative w-full max-w-lg p-6 my-8">
        <div className="flex items-start justify-between gap-4">
          <Payee logo={payeeAddr.slice(2, 4).toUpperCase()} tint={tintFor(payeeAddr)} name={d.meta.label} addr={short(payeeAddr)} />
          <div className="flex items-center gap-2 shrink-0">
            <StatusBadge status={status} size="sm" />
            <button
              onClick={onClose}
              aria-label="Close"
              className="grid place-items-center w-9 h-9 rounded-xl text-faint hover:text-ink hover:bg-raised transition"
            >
              <IconX size={16} />
            </button>
          </div>
        </div>

        <div className="mt-5 flex items-end gap-2">
          <span className="font-mono font-bold text-ink tnum leading-none" style={{ fontSize: 30 }}>
            {stream ? d.meta.ratePerPeriod ?? '—' : d.meta.amount ?? '—'}
          </span>
          <span className="text-dim text-sm mb-0.5">
            {token(d)} / {stream ? d.meta.ratePeriod ?? 'period' : d.meta.period ?? 'period'}
          </span>
        </div>

        <div className="mt-5 rounded-xl glass-soft ring-1 ring-line px-4">
          {stream ? (
            <Row label="Accrues">
              <span className="inline-flex items-center gap-1.5 text-sm text-ink font-mono">
                <IconRepeat size={12} className="text-faint" />
                {d.meta.ratePerPeriod ?? '—'} {token(d)} / {d.meta.ratePeriod ?? 'period'}
              </span>
            </Row>
          ) : (
            <Row label="On-chain cap">
              <span className="inline-flex items-center gap-1.5 text-sm text-ink font-mono">
                <IconLock size={12} className="text-faint" />
                {d.meta.amount ?? '—'} {token(d)} / {d.meta.period ?? 'period'}
              </span>
            </Row>
          )}
          <Row label="Chain">
            <span className="text-sm text-ink">{chainName(d.meta.chainId)}</span>
          </Row>
          <Row label="Created">
            <span className="text-sm text-dim">{new Date(d.meta.createdAt).toLocaleString()}</span>
          </Row>
          {d.meta.expiryDate && (
            <Row label="Ends">
              <span className="inline-flex items-center gap-1.5 text-sm text-dim">
                <IconCal size={12} className="text-faint" />
                {new Date(d.meta.expiryDate).toLocaleString()}
              </span>
            </Row>
          )}
        </div>

        <div className="mt-3 rounded-xl glass-soft ring-1 ring-line px-4">
          <Row label="Delegate">
            <Mono className="text-xs text-dim break-all">{d.delegation.delegate}</Mono>
          </Row>
          <Row label="Delegator">
            <Mono className="text-xs text-dim break-all">{d.delegation.delegator}</Mono>
          </Row>
          <Row label="Module">
            <Mono className="text-xs text-dim break-all">{d.meta.moduleAddress}</Mono>
          </Row>
          <Row label="Salt">
            <Mono className="text-xs text-dim break-all">{d.delegation.salt}</Mono>
          </Row>
          {d.meta.agreement && (
            <Row label="Agreement">
              {agreementUrl ? (
                <a
                  href={agreementUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 font-mono text-xs text-[color:var(--accent)] hover:underline break-all"
                >
                  <IconCube size={12} />
                  {intuitionUrl ? 'View on Intuition' : `${d.meta.agreement.cid.slice(0, 18)}…`}
                  <IconExt size={10} className="opacity-60" />
                </a>
              ) : (
                <span className="inline-flex items-center gap-1.5 font-mono text-xs text-faint">
                  <IconCube size={12} /> offline contract
                </span>
              )}
            </Row>
          )}
          {d.meta.agreement && (
            <Row label="Terms hash">
              <Mono className="text-xs text-dim break-all">{d.meta.agreement.termsHash}</Mono>
            </Row>
          )}
        </div>

        <div className="mt-3 rounded-xl glass-soft ring-1 ring-line px-4 py-3">
          <div className="text-xs text-faint mb-2 flex items-center gap-1.5">
            <IconLock size={11} /> Caveats ({d.delegation.caveats.length})
          </div>
          <div className="space-y-1.5">
            {d.delegation.caveats.map((c, i) => (
              <Mono key={i} className="block text-[11px] text-dim break-all">
                {short(c.enforcer)} · {c.terms.length > 26 ? `${c.terms.slice(0, 26)}…` : c.terms}
              </Mono>
            ))}
          </div>
        </div>

        <div className="mt-5 flex items-center gap-2">
          <Mono className="text-[11px] text-faint mr-auto">{short(d.meta.delegationHash)}</Mono>
          <CopyChip value={JSON.stringify(d, null, 2)} label="Copy JSON" />
          {d.meta.status === 'signed' && (
            <Btn kind="danger" size="sm" icon={<IconStop size={14} />} onClick={handleRevoke} disabled={revoking}>
              {revoking ? 'Revoking…' : 'Revoke'}
            </Btn>
          )}
          <Btn kind="ghost" size="sm" icon={<IconX size={14} />} onClick={handleRemove}>
            Remove
          </Btn>
        </div>
      </Card>
    </div>
  )
}
