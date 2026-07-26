/**
 * Client for the agent service (`server/og-agent-service.ts`).
 *
 * Three calls, in the order the chain forces: provision an agent wallet, then — once the
 * operator has signed the mandate to that address and funded it — start the run and read
 * its state. Provisioning has to come first because the mandate's delegate IS the agent
 * address, so it must exist before there is anything to sign.
 */
import { isAddress, type Address } from 'viem'

export interface AgentRun {
  id: string
  agentAddress: Address
  state: 'provisioned' | 'running' | 'filled' | 'blocked' | 'failed'
  detail: string | null
  startedAt: string | null
  chainId: number | null
  log: string
}

export interface AgentInstruction {
  hourglassStrategy: 'limitOrder'
  chainId: number
  safe: Address
  agent: Address
  delegationHash: string
  fundingToken: Address
  targetToken: Address
  maxSpend: string
  triggerPrice: string
}

/**
 * Defaults to the same-origin path Caddy reverse-proxies to the agent service running
 * in this same container — so prod and every preview work with no per-env config, and
 * with no CORS. Override only to point at an external agent service.
 */
export const AGENT_SERVICE_URL: string = import.meta.env.VITE_AGENT_SERVICE_URL || '/agent'

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  const body = (await res.json().catch(() => null)) as { error?: string } | null
  if (!res.ok) throw new Error(body?.error ?? `agent service ${res.status}`)
  if (body === null) throw new Error('agent service returned no body')
  return body as T
}

/** Ask the service for a fresh agent wallet. Slow: the model creates it in its own shell. */
export async function provisionAgent(baseUrl: string): Promise<{ id: string; agentAddress: Address }> {
  const out = await call<{ id: string; agentAddress: string }>(`${baseUrl}/provision`, { method: 'POST' })
  if (!isAddress(out.agentAddress)) throw new Error('agent service returned an invalid address')
  return { id: out.id, agentAddress: out.agentAddress }
}

/**
 * Hand the signed mandate to the agent. The service refuses if the instruction's agent is
 * not this run's address, or if that address holds no gas — both are worth surfacing
 * verbatim, they tell the operator exactly which step they skipped.
 */
export function startAgentRun(baseUrl: string, id: string, instruction: AgentInstruction): Promise<AgentRun> {
  return call<AgentRun>(`${baseUrl}/runs/${id}/start`, {
    method: 'POST',
    body: JSON.stringify({ instruction }),
  })
}

export function getAgentRun(baseUrl: string, id: string): Promise<AgentRun> {
  return call<AgentRun>(`${baseUrl}/runs/${id}`)
}
