// Claw Score — implements SCARCAT_ECON_MODEL.md §7 exactly (Manifesto
// v2+v3 synthesis). Source of truth: ~/dev/will-dapp/design/SCARCAT_ECON_MODEL.md
//
// CS = 0.35H + 0.25T + 0.20C + 0.15F + 0.05A
//
// This supersedes artifacts/ajan6-ClawScoreV1.md, which invented a
// different formula (SuccessRate/StakeScore/TenureScore) without
// consulting this document.
//
// CEO decision (2026-07-24, MVP strategy): the WillDividendTracker
// (0xe117...) dependency for C/F is cut OFF-CHAIN, not by adding native
// claim/faction tracking to the contract — WillTokenV6 (which would
// have added that on-chain) is CANCELLED; WillTokenV5 stays on Mainnet,
// untouched. See artifacts/phase3-roadmap.md for what's deferred.

export interface ClawScoreInput {
  /** WILL balance, 18 decimals, as a bigint. */
  balance: bigint
  /** Days the current position has been held. */
  holdDays: number
  /**
   * V5-native "protocol activity" count — source this from
   * `WillTokenV5.nonces(holder)` (every `executeIntent` call where this
   * address was `from` increments it; see
   * `ajan4-testnet-read.ts#getActivityCount`). Previously sourced from
   * WillDividendTracker's `withdrawDividend` events — that dependency
   * is cut per the 2026-07-24 CEO decision above. §7's "C = Claim Score
   * (protokol aktivitesi)" wording already means general protocol
   * activity, not literally dividend withdrawals, so this is a faithful
   * reinterpretation of the existing formula, not a change to it.
   */
  claimCount: number
  /**
   * Faction (cat) switches/tenure. WillTokenV5 has NO native faction
   * state — that would have required the now-cancelled WillTokenV6.
   * No data source is wired for MVP: omit both faction fields and
   * factionScore computes as 0 (see calcClawScore below). Phase 3
   * roadmap item — see artifacts/phase3-roadmap.md.
   */
  factionSwitchCount?: number
  /** Days spent in the current faction — see factionSwitchCount above. */
  factionDays?: number
  /**
   * DePIN/ClawHub agent participation score, already normalized 0-1.
   * SCARCAT_ECON_MODEL.md §7 leaves this component undecided for v1
   * ("Karar 3: Agent Score (ε) — v3 için mi beklesin?" — still open,
   * "Agent Score (A bileşeni) → DePIN node uptime API" still a TODO).
   * Defaults to 0 until that API exists — do not fabricate a formula
   * for it here.
   */
  agentScore?: number
}

export interface ClawScoreBreakdown {
  holderScore: number
  timeScore: number
  claimScore: number
  factionScore: number
  agentScore: number
  /** 0-1 raw weighted sum. */
  raw: number
  /** 0-100 scaled score, matches §7.4/§7.5 ("CS_100"). */
  cs100: number
  tier: 'Pawn' | 'Claw' | 'Fang' | 'Scarcat'
}

const WEIGHTS = {
  holder: 0.35,
  time: 0.25,
  claim: 0.2,
  faction: 0.15,
  agent: 0.05,
} as const

// §2.1: Scarcat tier threshold — H's cap is deliberately aligned to it.
const HOLDER_CAP_WILL = 10_000_000n * 10n ** 18n
const TIME_CAP_DAYS = 30
const CLAIM_CAP_COUNT = 10
const FACTION_CAP_DAYS = 30
// §7.3: λ — each faction switch costs ~40% of loyalty.
const FACTION_SWITCH_DECAY = 0.5

/**
 * balance / HOLDER_CAP_WILL, computed in bigint fixed-point (6 decimals)
 * before ever touching a JS Number — a raw `Number(balance)` on an
 * 18-decimal token amount can exceed Number.MAX_SAFE_INTEGER and lose
 * precision. Only the small 0-1,000,000 ratio is converted.
 */
export function calcHolderScore(balance: bigint): number {
  if (balance >= HOLDER_CAP_WILL) return 1.0
  if (balance <= 0n) return 0
  const scaled = (balance * 1_000_000n) / HOLDER_CAP_WILL
  return Number(scaled) / 1_000_000
}

export function calcTimeScore(holdDays: number): number {
  return Math.min(Math.max(holdDays, 0) / TIME_CAP_DAYS, 1.0)
}

export function calcClaimScore(claimCount: number): number {
  return Math.min(Math.max(claimCount, 0) / CLAIM_CAP_COUNT, 1.0)
}

/** §7.3: F = e^(-λ × switch_count) × min(faction_days / 30, 1.0) */
export function calcFactionScore(switchCount: number, factionDays: number): number {
  const loyaltyDecay = Math.exp(-FACTION_SWITCH_DECAY * Math.max(switchCount, 0))
  const tenure = Math.min(Math.max(factionDays, 0) / FACTION_CAP_DAYS, 1.0)
  return loyaltyDecay * tenure
}

/** §7.4 tier bands, CS on a 0-100 scale. */
export function tierForCs100(cs100: number): ClawScoreBreakdown['tier'] {
  if (cs100 >= 75) return 'Scarcat'
  if (cs100 >= 50) return 'Fang'
  if (cs100 >= 25) return 'Claw'
  return 'Pawn'
}

export function calcClawScore(input: ClawScoreInput): ClawScoreBreakdown {
  const holderScore = calcHolderScore(input.balance)
  const timeScore = calcTimeScore(input.holdDays)
  const claimScore = calcClaimScore(input.claimCount)
  // MVP (2026-07-24 CEO decision): no faction data source is wired —
  // factionDays omitted means "unknown," which computes as 0 rather
  // than fabricating tenure. Not the same as switchCount=0/factionDays=0
  // being passed explicitly (that would also yield 0 here, so the
  // outcome is identical either way — this branch just makes the "no
  // data" case explicit rather than relying on callers passing zeros).
  const factionScore =
    input.factionDays === undefined
      ? 0
      : calcFactionScore(input.factionSwitchCount ?? 0, input.factionDays)
  // Red Team finding (2026-07-24): every other component clamps its
  // input to [0,1] internally; agentScore was trusted at face value
  // ("already normalized") with no defensive clamp, so a bad upstream
  // value could inflate cs100 past the documented 0-100 scale.
  const agentScore = Math.min(Math.max(input.agentScore ?? 0, 0), 1)

  const raw =
    WEIGHTS.holder * holderScore +
    WEIGHTS.time * timeScore +
    WEIGHTS.claim * claimScore +
    WEIGHTS.faction * factionScore +
    WEIGHTS.agent * agentScore

  const cs100 = Math.round(raw * 1000) / 10 // one decimal, matches §7.5's "73.5" style

  return {
    holderScore,
    timeScore,
    claimScore,
    factionScore,
    agentScore,
    raw,
    cs100,
    tier: tierForCs100(cs100),
  }
}
