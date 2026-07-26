/**
 * Owns the lifecycle of one Hourglass-operated agent: provision, start, and polling for
 * state while it runs. The page calls this; it never talks to the service directly.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Address } from 'viem'
import {
  AGENT_SERVICE_URL,
  provisionAgent,
  startAgentRun,
  getAgentRun,
  type AgentInstruction,
  type AgentRun,
} from '../lib/agent-service'

const POLL_MS = 5000
const TERMINAL: AgentRun['state'][] = ['filled', 'blocked', 'failed']

export interface UseAgentRun {
  available: boolean
  agentAddress: Address | null
  run: AgentRun | null
  provisioning: boolean
  starting: boolean
  error: string | null
  provision: () => Promise<void>
  start: (instruction: AgentInstruction) => Promise<void>
}

export function useAgentRun(): UseAgentRun {
  const baseUrl = AGENT_SERVICE_URL
  const [id, setId] = useState<string | null>(null)
  const [agentAddress, setAgentAddress] = useState<Address | null>(null)
  const [run, setRun] = useState<AgentRun | null>(null)
  const [provisioning, setProvisioning] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Polling must stop on a terminal state; a ref keeps the interval from restarting on
  // every state write.
  const polling = useRef(false)

  const provision = useCallback(async () => {
    setError(null)
    setProvisioning(true)
    try {
      const out = await provisionAgent(baseUrl)
      setId(out.id)
      setAgentAddress(out.agentAddress)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not provision an agent')
    } finally {
      setProvisioning(false)
    }
  }, [baseUrl])

  const start = useCallback(
    async (instruction: AgentInstruction) => {
      if (!id) return
      setError(null)
      setStarting(true)
      try {
        setRun(await startAgentRun(baseUrl, id, instruction))
        polling.current = true
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not start the agent')
      } finally {
        setStarting(false)
      }
    },
    [baseUrl, id],
  )

  useEffect(() => {
    if (!id || !polling.current) return
    let cancelled = false
    const timer = setInterval(() => {
      void getAgentRun(baseUrl, id)
        .then((next) => {
          if (cancelled) return
          setRun(next)
          if (TERMINAL.includes(next.state)) polling.current = false
        })
        .catch(() => {
          /* transient: the next tick retries */
        })
    }, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [baseUrl, id, run?.state])

  return {
    // The service is always reachable in principle (same-origin by default); whether
    // it is configured shows up as a provisioning error, not as a hidden option.
    available: true,
    agentAddress,
    run,
    provisioning,
    starting,
    error,
    provision,
    start,
  }
}
