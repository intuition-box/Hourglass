'use client';

import Link from 'next/link';
import { useAnalytics } from './useAnalytics';
import { totals, byToken, byChain, byReceiver, byAgreement, chargesPerDay, type Group } from './aggregate';
import { formatAmount, formatCount, shortHex } from './format';
import { ANALYTICS_CHAINS } from './config';
import type { TokenMeta } from './tokens';

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-fd-border bg-fd-card p-4">
      <div className="text-xs uppercase tracking-wide text-fd-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-fd-muted-foreground">{sub}</div>}
    </div>
  );
}

function chainName(chainId: number): string {
  return ANALYTICS_CHAINS.find((c) => c.chain.id === chainId)?.name ?? `chain ${chainId}`;
}

/** `key` is the `chainId:address` token key used across the aggregates. */
function tokenLabel(key: string, tokens: Map<string, TokenMeta>): string {
  const meta = tokens.get(key);
  if (meta) return meta.symbol;
  return shortHex(key.slice(key.indexOf(':') + 1));
}

function groupVolume(g: Group | { volumeByToken: Map<string, bigint> }, tokens: Map<string, TokenMeta>): string {
  const parts = [...g.volumeByToken.entries()].map(([key, total]) => {
    const meta = tokens.get(key);
    return `${formatAmount(total, meta?.decimals ?? 18)} ${tokenLabel(key, tokens)}`;
  });
  return parts.join(' · ');
}

export function AnalyticsDashboard() {
  const { loading, error, charges, failures, tokens, refresh } = useAnalytics();

  const scanned = ANALYTICS_CHAINS.map((c) => c.name).join(' and ');

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Analytics</h1>
        <p className="mt-1 max-w-2xl text-sm text-fd-muted-foreground">
          Live, read straight from the HourGlass enforcer instances on {scanned} — no backend.{' '}
          <Link
            href="/docs/analytics"
            className="rounded underline underline-offset-4 hover:text-[color:var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-line)]"
          >
            How attribution works
          </Link>
          {' · '}
          <Link
            href="/docs/deployments"
            className="rounded underline underline-offset-4 hover:text-[color:var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-line)]"
          >
            Contract addresses per chain
          </Link>
          .
        </p>
      </div>
      <button
        onClick={refresh}
        disabled={loading}
        className="h-9 shrink-0 rounded-full border border-fd-border px-4 text-sm font-medium transition-colors hover:bg-fd-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-line)] disabled:opacity-40"
      >
        {loading ? 'Reading…' : 'Refresh'}
      </button>
    </div>
  );

  // Partial data must not read as complete: name the chains that failed.
  const failureNotice = failures.length > 0 && (
    <div className="mt-6 rounded-xl border border-fd-border p-4 text-sm text-fd-muted-foreground">
      Showing partial data — could not read{' '}
      <span className="text-fd-foreground">{failures.map((f) => f.name).join(', ')}</span>
      {failures[0]?.reason ? `: ${failures[0].reason}` : null}
    </div>
  );

  let body: React.ReactNode;
  if (loading) {
    body = <p className="mt-10 text-sm text-fd-muted-foreground">Reading on-chain events…</p>;
  } else if (error) {
    body = (
      <div className="mt-10 rounded-xl border border-fd-border p-5 text-sm text-fd-muted-foreground">
        Could not read on-chain analytics: <span className="text-fd-foreground">{error}</span>
      </div>
    );
  } else if (charges.length === 0) {
    body = (
      <div className="mt-10 rounded-xl border border-fd-border p-6">
        <h2 className="text-base font-semibold">No attributable charges yet</h2>
        <p className="mt-2 max-w-xl text-sm text-fd-muted-foreground">
          This view counts charges and claims routed to the HourGlass-deployed enforcer instances on {scanned}.
          Once subscriptions and streams created through HourGlass are charged on-chain, their volume and counts —
          broken down by chain, agreement, receiver, and token — appear here automatically. The instances are
          listed in{' '}
          <Link
            href="/docs/deployments"
            className="rounded underline underline-offset-4 hover:text-[color:var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-line)]"
          >
            Deployments
          </Link>
          .
        </p>
      </div>
    );
  } else {
    const t = totals(charges);
    const tokenRows = byToken(charges);
    const chainRows = byChain(charges);
    const receivers = byReceiver(charges).slice(0, 10);
    const agreements = byAgreement(charges).slice(0, 10);
    const days = chargesPerDay(charges);
    const peak = Math.max(...days.map((d) => d.count), 1);

    body = (
      <div className="mt-8 space-y-10">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <StatCard label="Charges" value={formatCount(t.charges)} sub={`${formatCount(t.subscriptionCharges)} subs · ${formatCount(t.streamClaims)} claims`} />
          <StatCard label="Chains" value={formatCount(t.chains)} />
          <StatCard label="Agreements" value={formatCount(t.agreements)} />
          <StatCard label="Receivers" value={formatCount(t.receivers)} />
          <StatCard label="Tokens" value={formatCount(t.tokens)} />
        </div>

        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-fd-muted-foreground">By chain</h2>
          <div className="mt-3 overflow-hidden rounded-xl border border-fd-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-fd-border text-left text-xs uppercase tracking-wide text-fd-muted-foreground">
                  <th scope="col" className="px-4 py-2.5 font-medium">Chain</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Volume</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Charges</th>
                </tr>
              </thead>
              <tbody>
                {chainRows.map((row) => (
                  <tr key={row.chainId} className="border-b border-fd-border/60 last:border-0">
                    <td className="px-4 py-2.5 font-medium">{chainName(row.chainId)}</td>
                    <td className="px-4 py-2.5 text-right text-xs text-fd-muted-foreground">{groupVolume(row, tokens)}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">{formatCount(row.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-fd-muted-foreground">Volume by token</h2>
          <div className="mt-3 overflow-hidden rounded-xl border border-fd-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-fd-border text-left text-xs uppercase tracking-wide text-fd-muted-foreground">
                  <th scope="col" className="px-4 py-2.5 font-medium">Token</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Chain</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Volume</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Charges</th>
                </tr>
              </thead>
              <tbody>
                {tokenRows.map((row) => (
                  <tr key={row.key} className="border-b border-fd-border/60 last:border-0">
                    <td className="px-4 py-2.5 font-medium">{tokenLabel(row.key, tokens)}</td>
                    <td className="px-4 py-2.5 text-xs text-fd-muted-foreground">{chainName(row.chainId)}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                      {formatAmount(row.total, tokens.get(row.key)?.decimals ?? 18)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">{formatCount(row.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-fd-muted-foreground">Charges over time</h2>
          <div className="mt-3 flex h-32 items-end gap-1" role="img" aria-label="Charges per day">
            {days.map((d) => (
              // h-full gives each column a definite height; without it the bar's
              // percentage height resolves against auto and every bar collapses.
              <div key={d.day} className="flex h-full flex-1 items-end" title={`${d.day}: ${d.count}`}>
                <div
                  className="w-full rounded-t-sm bg-[color:var(--accent)]"
                  style={{ height: `${Math.max(2, (d.count / peak) * 100)}%`, opacity: d.count === 0 ? 0.2 : 1 }}
                />
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-xs text-fd-muted-foreground">
            <span>{days[0]?.day}</span>
            <span>{days[days.length - 1]?.day}</span>
          </div>
        </section>

        <div className="grid gap-8 md:grid-cols-2">
          <GroupTable title="Top receivers" rows={receivers} tokens={tokens} keyLabel={(k) => shortHex(k)} />
          <GroupTable title="Top agreements" rows={agreements} tokens={tokens} keyLabel={(k) => shortHex(k)} />
        </div>
      </div>
    );
  }

  return (
    <section className="relative mx-auto min-h-[calc(100vh-56px)] max-w-4xl px-6 py-16 md:px-8">
      <div className="stream-edge absolute left-0 top-0 h-full w-px" aria-hidden="true" />
      {header}
      {failureNotice}
      {body}
    </section>
  );
}

function GroupTable({
  title,
  rows,
  tokens,
  keyLabel,
}: {
  title: string;
  rows: Group[];
  tokens: Map<string, TokenMeta>;
  keyLabel: (key: string) => string;
}) {
  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-fd-muted-foreground">{title}</h2>
      <div className="mt-3 overflow-hidden rounded-xl border border-fd-border">
        <table className="w-full text-sm">
          <tbody>
            {rows.map((g) => (
              <tr key={g.key} className="border-b border-fd-border/60 last:border-0">
                <td className="px-4 py-2.5 font-mono text-xs">{keyLabel(g.key)}</td>
                <td className="px-4 py-2.5 text-right text-xs text-fd-muted-foreground">{groupVolume(g, tokens)}</td>
                <td className="px-4 py-2.5 text-right font-mono tabular-nums">{formatCount(g.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
