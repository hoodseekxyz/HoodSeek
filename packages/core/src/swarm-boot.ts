// swarm-boot.ts — Faz 3 Aşama 2: Swarm Boot Sequence.
// Assigns each of the 9 SCARCAT swarm agents (Ajan-1..Ajan-9, per
// status/SWARM_STATUS.md) a unique TEST wallet, connects them to a
// shared OpenClawBridge for A2A negotiation, and watches the real
// WillTokenV5 contract (via openclaw-node.ts) for on-chain activity.
//
// TEST WALLETS ONLY. Private keys are generated fresh in-memory each
// run via viem's generatePrivateKey() — never written to disk, never
// derived from anything persistent, never logged. These are NOT the
// real guardian keys (dispatch/GUARDIAN_ADDRESSES.txt) and must never
// be used for a real deploy or mainnet action. A test wallet has no
// on-chain agent authority until someone separately runs it through
// WillTokenV5's real guardian-gated registerAgent flow.

import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import type { Address } from 'viem'
import { WebSocketServer, type WebSocket } from 'ws'
import { createOpenClawNode, OpenClawBridge } from './openclaw-node'
import { calcClawScore } from './ajan6-ClawScore'

export interface SwarmAgentRole {
  id: string // "ajan-1".."ajan-9"
  title: string
}

// Mirrors status/SWARM_STATUS.md's role table.
export const SWARM_ROLES: SwarmAgentRole[] = [
  { id: 'ajan-1', title: 'Smart Contract & MEV Lead' },
  { id: 'ajan-2', title: 'Interface & ClawHub' },
  { id: 'ajan-3', title: 'Stealth Motion Designer' },
  { id: 'ajan-4', title: 'Node & Infrastructure' },
  { id: 'ajan-5', title: 'ClawHub AI Model Engineer' },
  { id: 'ajan-6', title: 'A2A Monetization Strategist' },
  { id: 'ajan-7', title: 'Ecosystem & Partnerships VP' },
  { id: 'ajan-8', title: 'Autonomous Swarm & Social-Fi' },
  { id: 'ajan-9', title: 'Swarm Commander' },
]

export interface SwarmAgent {
  id: string
  title: string
  account: PrivateKeyAccount
  address: Address
}

export interface SwarmBoot {
  agents: SwarmAgent[]
  bridge: OpenClawBridge
  node: ReturnType<typeof createOpenClawNode>
  stopWatching: () => void
}

function createSwarmAgents(): SwarmAgent[] {
  return SWARM_ROLES.map((role) => {
    const account = privateKeyToAccount(generatePrivateKey())
    return { id: role.id, title: role.title, account, address: account.address }
  })
}

export interface BootSwarmOptions {
  contractAddress?: Address
  /** Defaults to console.log — override for tests/quiet boots. */
  log?: (line: string) => void
}

export function bootSwarm(options: BootSwarmOptions = {}): SwarmBoot {
  const log = options.log ?? ((line: string) => console.log(line))

  const agents = createSwarmAgents()
  const bridge = new OpenClawBridge()
  const node = createOpenClawNode(options.contractAddress)

  log(`[swarm-boot] ${agents.length} ajan test cüzdanıyla başlatıldı:`)
  for (const agent of agents) {
    log(`  ${agent.id} (${agent.title}) -> ${agent.address}`)
  }

  const unwatchIntents = node.watchIntents((intent) => {
    log(
      `[swarm-boot] IntentExecuted: ${intent.from} -> ${intent.to} (${intent.amount} WILL, task ${intent.taskId})`
    )
  })

  const unwatchRegistry = node.watchAgentRegistry((agentAddress, registered) => {
    const matched = agents.find((a) => a.address.toLowerCase() === agentAddress.toLowerCase())
    const label = matched ? `${matched.id} (${matched.title})` : agentAddress
    log(`[swarm-boot] AgentRegistry: ${label} ${registered ? 'REGISTERED' : 'REVOKED'}`)
  })

  return {
    agents,
    bridge,
    node,
    stopWatching: () => {
      unwatchIntents()
      unwatchRegistry()
    },
  }
}

// ============ Bridge convenience wrappers ============
// Thin helpers so callers work in terms of swarm agent ids instead of
// importing OpenClawBridge's Address-keyed types directly. These only
// touch the in-memory bridge — no signing, no on-chain calls.

export function findAgent(boot: SwarmBoot, agentId: string): SwarmAgent {
  const agent = boot.agents.find((a) => a.id === agentId)
  if (!agent) throw new Error(`unknown agent ${agentId}`)
  return agent
}

export function postAgentRequest(
  boot: SwarmBoot,
  agentId: string,
  requestId: string,
  description: string
): void {
  const agent = findAgent(boot, agentId)
  boot.bridge.postRequest({ id: requestId, requester: agent.address, description })
}

export function postAgentOffer(
  boot: SwarmBoot,
  agentId: string,
  requestId: string,
  deliverable: string,
  invoiceAmount: bigint
): void {
  const agent = findAgent(boot, agentId)
  boot.bridge.postOffer({ requestId, responder: agent.address, deliverable, invoiceAmount })
}

/**
 * Accepts an offer via the bridge and builds (but does not sign or
 * submit) the settling AgentIntent — mirrors
 * openclaw-architecture.md §3 step 3→4. Actual signing requires the
 * requesting agent's account to ALSO be a registered on-chain agent
 * (or the intent to be handed to one), which test wallets are not by
 * default.
 */
export async function prepareSettlement(
  boot: SwarmBoot,
  requesterAgentId: string,
  responderAgentId: string,
  requestId: string
) {
  const requester = findAgent(boot, requesterAgentId)
  const responder = findAgent(boot, responderAgentId)
  const { to, amount, taskId } = boot.bridge.acceptOffer(requestId, responder.address)

  return boot.node.buildIntent({
    from: requester.address,
    to,
    amount,
    taskId,
  })
}

// ============ Monitor WebSocket server ============
// Bridges swarm-boot.ts / openclaw-node.ts's on-chain watchers + a
// periodic ClawScore snapshot to artifacts/scarcat-monitor.tsx's client
// over a plain WebSocket. Message shape (MonitorMessage) is duplicated
// in scarcat-monitor.tsx rather than shared via import — that file runs
// in the browser, this one in Node, and keeping them independently
// type-checkable avoided a cross-runtime build step for what is, for
// now, a small fixed protocol.

export type MonitorMessage =
  | { type: 'intent'; from: string; to: string; amount: string; taskId: string; timestamp: number }
  | { type: 'agent-registry'; agent: string; label: string; registered: boolean; timestamp: number }
  | { type: 'claw-score'; agentId: string; label: string; address: string; cs100: number; tier: string; timestamp: number }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string; timestamp: number }

export interface MonitorServerOptions {
  port?: number
  /** How often (ms) to recompute + broadcast ClawScore per agent. Default 30s. */
  clawScoreIntervalMs?: number
}

export interface MonitorServer {
  wss: WebSocketServer
  broadcast: (message: MonitorMessage) => void
  close: () => void
}

export function startMonitorServer(boot: SwarmBoot, options: MonitorServerOptions = {}): MonitorServer {
  const port = options.port ?? 8787
  const wss = new WebSocketServer({ port })
  const clients = new Set<WebSocket>()

  wss.on('connection', (socket) => {
    clients.add(socket)
    socket.on('close', () => clients.delete(socket))
  })

  function broadcast(message: MonitorMessage) {
    const payload = JSON.stringify(message)
    for (const client of clients) {
      if (client.readyState === client.OPEN) client.send(payload)
    }
  }

  const unwatchIntents = boot.node.watchIntents((intent) => {
    broadcast({
      type: 'intent',
      from: intent.from,
      to: intent.to,
      amount: intent.amount.toString(),
      taskId: intent.taskId,
      timestamp: Date.now(),
    })
  })

  const unwatchRegistry = boot.node.watchAgentRegistry((agentAddress, registered) => {
    const matched = boot.agents.find((a) => a.address.toLowerCase() === agentAddress.toLowerCase())
    broadcast({
      type: 'agent-registry',
      agent: agentAddress,
      label: matched ? `${matched.id} (${matched.title})` : agentAddress,
      registered,
      timestamp: Date.now(),
    })
  })

  // Periodic ClawScore snapshot per swarm agent. Uses each agent's
  // on-chain nonce as claimCount (V5-native "protocol activity" — see
  // ajan6-ClawScore.ts) and balance for H. holdDays is left at 0 (test
  // wallets have no real acquisition history) and factionScore is
  // omitted entirely (no data source — see phase3-roadmap.md item 4).
  // This is a best-effort demo feed, not a production score service.
  const clawScoreTimer = setInterval(() => {
    for (const agent of boot.agents) {
      Promise.all([boot.node.getBalance(agent.address), boot.node.getNonce(agent.address)])
        .then(([balance, nonce]) => {
          const score = calcClawScore({
            balance,
            holdDays: 0,
            claimCount: Number(nonce),
          })
          broadcast({
            type: 'claw-score',
            agentId: agent.id,
            label: `${agent.id} (${agent.title})`,
            address: agent.address,
            cs100: score.cs100,
            tier: score.tier,
            timestamp: Date.now(),
          })
        })
        .catch(() => {
          // best-effort monitor feed — a single failed read shouldn't
          // stop the interval or crash the server
        })
    }
  }, options.clawScoreIntervalMs ?? 30_000)

  return {
    wss,
    broadcast,
    close: () => {
      clearInterval(clawScoreTimer)
      unwatchIntents()
      unwatchRegistry()
      for (const client of clients) client.close()
      wss.close()
    },
  }
}
