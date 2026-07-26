// OpenClaw node — off-chain A2A bridge for WillTokenV5, per
// artifacts/openclaw-architecture.md §1/§3 ("imsg" negotiation +
// EIP-712 intent construction + on-chain settlement).
//
// Fully V5-native: no WillDividendTracker (0xe117...) reference
// anywhere in this file (per CEO decision 2026-07-24 — see
// phase3-roadmap.md item 3 for whether the real imsg/acpx/wacli/gogcli
// repos exist; this is a from-scratch, minimal implementation of just
// enough of the "imsg" role to unblock A2A settlement on V5, not a
// port of anything that already exists).
//
// Security posture (mirrors ajan1-testnet-deploy.sh / ajan4-testnet-read.ts):
// - No private key is ever read from or written to a file by this module.
// - Signing requires an explicit `Account` passed in by the caller
//   (e.g. a viem LocalAccount) — nothing here holds or derives key
//   material.
// - Building a signed intent and SUBMITTING it on-chain are two
//   separate, explicit calls — nothing here submits automatically.
// - The negotiation queue (OpenClawBridge) is in-memory only, single
//   process — it is a REFERENCE implementation of the imsg role
//   described in the architecture doc, not a distributed system.

import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  type Address,
  type Hex,
  type Account,
  type PublicClient,
  type WalletClient,
} from 'viem'

export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.ROBINHOOD_RPC ?? ''] },
  },
})

export const WILL_TOKEN_V5_ADDRESS: Address = '0xd69c454eCf09eE8294e69231e0727e55F59E42D1'

// ABI slice this node needs: the reads used by watchers, plus the one
// state-changing function intents ultimately settle through.
const WILL_TOKEN_V5_ABI = [
  { type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'isAgent', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'executeIntent',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'taskId', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'IntentExecuted',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'taskId', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'AgentRegistered',
    inputs: [{ name: 'agent', type: 'address', indexed: true }],
  },
  {
    type: 'event',
    name: 'AgentRevoked',
    inputs: [{ name: 'agent', type: 'address', indexed: true }],
  },
  { type: 'event', name: 'Paused', inputs: [{ name: 'guardian', type: 'address', indexed: true }] },
  { type: 'event', name: 'Unpaused', inputs: [] },
] as const

// ============ EIP-712 intent construction ============
// Must match ajan1-WillTokenV5.sol's DOMAIN_SEPARATOR / INTENT_TYPEHASH
// exactly — the contract's EIP712Domain has NO "version" field
// (`keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)")`).
// Including a `version` in the domain object below would make viem
// derive a different domain type and produce a signature the contract
// rejects.

const AGENT_INTENT_TYPES = {
  AgentIntent: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'taskId', type: 'bytes32' },
  ],
} as const

export interface AgentIntent {
  from: Address
  to: Address
  amount: bigint
  nonce: bigint
  deadline: bigint
  taskId: Hex
}

function domainFor(contractAddress: Address) {
  // Deliberately only these three fields — see note above.
  return {
    name: 'WillTokenV5',
    chainId: robinhoodChain.id,
    verifyingContract: contractAddress,
  } as const
}

export function createOpenClawNode(contractAddress: Address = WILL_TOKEN_V5_ADDRESS) {
  if (!process.env.ROBINHOOD_RPC) {
    throw new Error('ROBINHOOD_RPC not set')
  }

  const publicClient: PublicClient = createPublicClient({
    chain: robinhoodChain,
    transport: http(),
  })

  return {
    publicClient,

    // ---------- Reads ----------

    async getNonce(holder: Address): Promise<bigint> {
      return publicClient.readContract({
        address: contractAddress,
        abi: WILL_TOKEN_V5_ABI,
        functionName: 'nonces',
        args: [holder],
      })
    },

    async isRegisteredAgent(agent: Address): Promise<boolean> {
      return publicClient.readContract({
        address: contractAddress,
        abi: WILL_TOKEN_V5_ABI,
        functionName: 'isAgent',
        args: [agent],
      })
    },

    async isPaused(): Promise<boolean> {
      return publicClient.readContract({
        address: contractAddress,
        abi: WILL_TOKEN_V5_ABI,
        functionName: 'paused',
      })
    },

    async getBalance(holder: Address): Promise<bigint> {
      return publicClient.readContract({
        address: contractAddress,
        abi: WILL_TOKEN_V5_ABI,
        functionName: 'balanceOf',
        args: [holder],
      })
    },

    // ---------- Event watching ----------
    // Thin wrappers around viem's watchContractEvent — caller owns the
    // unwatch() lifecycle (these return it directly).

    watchIntents(onIntent: (log: { from: Address; to: Address; amount: bigint; taskId: Hex }) => void) {
      return publicClient.watchContractEvent({
        address: contractAddress,
        abi: WILL_TOKEN_V5_ABI,
        eventName: 'IntentExecuted',
        onLogs: (logs) => {
          for (const log of logs) {
            if (log.args.from && log.args.to && log.args.amount !== undefined && log.args.taskId) {
              onIntent({
                from: log.args.from,
                to: log.args.to,
                amount: log.args.amount,
                taskId: log.args.taskId,
              })
            }
          }
        },
      })
    },

    watchAgentRegistry(onChange: (agent: Address, registered: boolean) => void) {
      const unwatchRegistered = publicClient.watchContractEvent({
        address: contractAddress,
        abi: WILL_TOKEN_V5_ABI,
        eventName: 'AgentRegistered',
        onLogs: (logs) => {
          for (const log of logs) if (log.args.agent) onChange(log.args.agent, true)
        },
      })
      const unwatchRevoked = publicClient.watchContractEvent({
        address: contractAddress,
        abi: WILL_TOKEN_V5_ABI,
        eventName: 'AgentRevoked',
        onLogs: (logs) => {
          for (const log of logs) if (log.args.agent) onChange(log.args.agent, false)
        },
      })
      return () => {
        unwatchRegistered()
        unwatchRevoked()
      }
    },

    watchPauseState(onChange: (paused: boolean) => void) {
      const unwatchPaused = publicClient.watchContractEvent({
        address: contractAddress,
        abi: WILL_TOKEN_V5_ABI,
        eventName: 'Paused',
        onLogs: () => onChange(true),
      })
      const unwatchUnpaused = publicClient.watchContractEvent({
        address: contractAddress,
        abi: WILL_TOKEN_V5_ABI,
        eventName: 'Unpaused',
        onLogs: () => onChange(false),
      })
      return () => {
        unwatchPaused()
        unwatchUnpaused()
      }
    },

    // ---------- Intent construction / signing / submission ----------

    /**
     * Reads the current on-chain nonce for `from` and builds a ready-to-
     * sign AgentIntent. Pure read — no signing, no submission.
     */
    async buildIntent(params: {
      from: Address
      to: Address
      amount: bigint
      taskId: Hex
      deadlineSecondsFromNow?: number
    }): Promise<AgentIntent> {
      const nonce = await this.getNonce(params.from)
      const deadline = BigInt(Math.floor(Date.now() / 1000) + (params.deadlineSecondsFromNow ?? 3600))
      return {
        from: params.from,
        to: params.to,
        amount: params.amount,
        nonce,
        deadline,
        taskId: params.taskId,
      }
    },

    /**
     * Signs an AgentIntent with the caller-supplied account. `account`
     * must correspond to `intent.from` — the contract checks the
     * recovered signer equals `from`.
     */
    async signIntent(intent: AgentIntent, account: Account, walletClient?: WalletClient): Promise<Hex> {
      const client =
        walletClient ??
        createWalletClient({ account, chain: robinhoodChain, transport: http() })

      return client.signTypedData({
        account,
        domain: domainFor(contractAddress),
        types: AGENT_INTENT_TYPES,
        primaryType: 'AgentIntent',
        message: intent,
      })
    },

    /**
     * Submits a signed intent via executeIntent(). `agentAccount` must
     * be a registered on-chain agent (isAgent == true) — the contract
     * enforces this, this call will revert otherwise. Caller supplies
     * the wallet client/account; this function never holds key material.
     */
    async submitIntent(intent: AgentIntent, signature: Hex, agentWalletClient: WalletClient): Promise<Hex> {
      if (!agentWalletClient.account) {
        throw new Error('agentWalletClient has no account')
      }
      return agentWalletClient.writeContract({
        address: contractAddress,
        abi: WILL_TOKEN_V5_ABI,
        functionName: 'executeIntent',
        args: [intent.from, intent.to, intent.amount, intent.deadline, intent.taskId, signature],
        account: agentWalletClient.account,
        chain: robinhoodChain,
      })
    },
  }
}

// ============ A2A negotiation bridge ("imsg" role, reference impl) ============
// In-memory, single-process. Represents the Manifesto v3 A2A flow:
//   Agent A requests -> Agent B offers (deliverable + invoice) ->
//   A accepts -> a ready-to-sign AgentIntent is produced.
// This is NOT the real imsg (see file header) — it exists so the
// negotiation step in openclaw-architecture.md §3 has a concrete,
// testable shape rather than remaining a diagram-only concept.

export interface A2ARequest {
  id: string
  requester: Address
  description: string
}

export interface A2AOffer {
  requestId: string
  responder: Address
  deliverable: string
  invoiceAmount: bigint
}

export class OpenClawBridge {
  private requests = new Map<string, A2ARequest>()
  private offers = new Map<string, A2AOffer[]>()

  postRequest(request: A2ARequest): void {
    this.requests.set(request.id, request)
    this.offers.set(request.id, [])
  }

  postOffer(offer: A2AOffer): void {
    const existing = this.requests.get(offer.requestId)
    if (!existing) throw new Error(`no request ${offer.requestId}`)
    this.offers.get(offer.requestId)!.push(offer)
  }

  getOffers(requestId: string): A2AOffer[] {
    return this.offers.get(requestId) ?? []
  }

  /**
   * Accepts one offer for a request and returns the parameters needed
   * to build+sign the settling AgentIntent — does NOT sign or submit
   * anything itself (that's the requester's own account, via
   * createOpenClawNode().buildIntent/signIntent/submitIntent).
   */
  acceptOffer(requestId: string, responder: Address): { to: Address; amount: bigint; taskId: Hex } {
    const request = this.requests.get(requestId)
    if (!request) throw new Error(`no request ${requestId}`)

    const offer = this.getOffers(requestId).find((o) => o.responder === responder)
    if (!offer) throw new Error(`no offer from ${responder} for request ${requestId}`)

    return {
      to: offer.responder,
      amount: offer.invoiceAmount,
      // taskId binds the on-chain settlement back to this negotiated
      // request — an indexer can correlate IntentExecuted events to
      // the original A2A request via this hash.
      taskId: idToTaskId(requestId),
    }
  }
}

function idToTaskId(requestId: string): Hex {
  // Simple, deterministic mapping — not a cryptographic commitment to
  // the request contents, just a stable on-chain correlation handle.
  const bytes = new TextEncoder().encode(requestId)
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 64)
    .padEnd(64, '0')
  return `0x${hex}` as Hex
}
