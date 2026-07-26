// crawler-bridge.ts — bridges "gitcrawl"/"discrawl" data into
// openclaw-node.ts's A2A flow (OpenClawBridge).
//
// HONESTY NOTE (searched and confirmed, 2026-07-24): no real gitcrawl or
// discrawl repo/tool exists anywhere in this environment — only the bare
// names appear in the CEO directive, with no description of their
// actual data shape or API. This file does NOT pretend to connect to a
// real gitcrawl/discrawl — it defines a generic CrawlerDataSource
// interface (inferred purpose from the names only: gitcrawl ~ git/repo
// activity, discrawl ~ Discord activity), a MockCrawlerDataSource for
// testing the bridge logic end-to-end, and the bridge function itself.
// When a real gitcrawl/discrawl exists, implementing CrawlerDataSource
// against its real API is the only thing that should need to change —
// bridgeCrawlerToOpenClaw() and everything downstream stays the same.

import type { Address } from 'viem'
import { OpenClawBridge, type A2ARequest } from './openclaw-node'

// ============ Generic crawler event shape ============

// Faz 4: social-fi-webhook.ts 'x' ve 'telegram' ekledi — tek bir
// CrawlerDataSource örneği artık BİRDEN FAZLA kaynaktan event
// yayınlayabiliyor (X+Telegram tek webhook sunucusunda), bu yüzden
// "source" artık DataSource seviyesinde değil sadece her CrawlerEvent'in
// kendi alanı (aşağıda) — bkz. bu dosyanın altındaki not.
export type CrawlerSource = 'gitcrawl' | 'discrawl' | 'x' | 'telegram'

export interface CrawlerEvent {
  source: CrawlerSource
  /** Crawler-assigned event id — used to derive a stable A2A request id. */
  id: string
  /** Who/what the crawler observed acting (a repo owner, a Discord user, etc.) — mapped to an on-chain address by the caller-supplied resolver. */
  actor: string
  /** Free-text description of what was observed — becomes the A2A request description. */
  summary: string
}

export interface CrawlerDataSource {
  /** Starts listening; returns an unsubscribe function. */
  subscribe(onEvent: (event: CrawlerEvent) => void): () => void
}

// ============ Mock source (real gitcrawl/discrawl don't exist yet) ============

export interface MockCrawlerDataSourceOptions {
  source: CrawlerSource
  intervalMs?: number
  events?: CrawlerEvent[]
}

/**
 * Emits a fixed or provided sequence of synthetic events on an
 * interval, in order, then stops. Exists purely so
 * bridgeCrawlerToOpenClaw() has something real to run against — it is
 * NOT a stand-in prediction of what gitcrawl/discrawl will actually
 * produce.
 */
export class MockCrawlerDataSource implements CrawlerDataSource {
  source: CrawlerSource
  private intervalMs: number
  private events: CrawlerEvent[]

  constructor(options: MockCrawlerDataSourceOptions) {
    this.source = options.source
    this.intervalMs = options.intervalMs ?? 1000
    this.events =
      options.events ??
      [
        { source: options.source, id: 'mock-1', actor: 'mock-actor-1', summary: `[mock ${options.source}] example event 1` },
        { source: options.source, id: 'mock-2', actor: 'mock-actor-2', summary: `[mock ${options.source}] example event 2` },
      ]
  }

  subscribe(onEvent: (event: CrawlerEvent) => void): () => void {
    let cancelled = false
    let index = 0

    const timer = setInterval(() => {
      if (cancelled || index >= this.events.length) {
        clearInterval(timer)
        return
      }
      onEvent(this.events[index])
      index += 1
    }, this.intervalMs)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }
}

// ============ Bridge ============

export interface BridgeCrawlerOptions {
  /** Maps a crawler-observed actor string to an on-chain address. Return undefined to skip the event (no known mapping). */
  resolveActor: (actor: string, source: CrawlerSource) => Address | undefined
  /** Called for every event the bridge decides to skip (unresolvable actor) — for logging/metrics. */
  onSkipped?: (event: CrawlerEvent, reason: string) => void
  /** Called for every event successfully turned into an A2A request. */
  onRequestPosted?: (event: CrawlerEvent, request: A2ARequest) => void
}

/**
 * Subscribes to a CrawlerDataSource and turns each event into an
 * OpenClawBridge A2A request (openclaw-architecture.md §3 step 1 — the
 * "Agent A broadcasts a request" side of the flow). Does not post
 * offers, accept anything, or touch the chain — this is purely the
 * ingestion half.
 */
export function bridgeCrawlerToOpenClaw(
  dataSource: CrawlerDataSource,
  bridge: OpenClawBridge,
  options: BridgeCrawlerOptions
): () => void {
  return dataSource.subscribe((event) => {
    const requester = options.resolveActor(event.actor, event.source)
    if (!requester) {
      options.onSkipped?.(event, `no on-chain address mapping for actor "${event.actor}"`)
      return
    }

    const requestId = `${event.source}:${event.id}`
    const request: A2ARequest = {
      id: requestId,
      requester,
      description: event.summary,
    }
    bridge.postRequest(request)
    options.onRequestPosted?.(event, request)
  })
}
