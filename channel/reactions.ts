/**
 * Emoji reactions: batching of reaction events into one notification per message, and summaries for
 * fetch_messages. No discord.js here so it can be unit-tested; wiring is in server.ts.
 *
 * Reactions arriving for the same message within `delayMs` are merged into one notification, and an add
 * followed by a remove of the same emoji by the same person (or the reverse) cancels out.
 */

export type ReactionEvent = {
  chatId: string
  messageId: string
  userId: string
  user: string
  displayName: string
  emoji: string
  added: boolean
  admin: boolean
}

export type ReactionChange = { userId: string; user: string; displayName: string; emoji: string; added: boolean; admin: boolean }

/** Net effect of a burst of events: per (user, emoji) the action stands only if the first and last event agree. */
export function netChanges(events: ReactionEvent[]): ReactionChange[] {
  const byKey = new Map<string, ReactionEvent[]>()
  for (const e of events) {
    const k = `${e.userId}\u0000${e.emoji}`
    byKey.set(k, [...(byKey.get(k) ?? []), e])
  }
  const out: ReactionChange[] = []
  for (const list of byKey.values()) {
    const first = list[0], last = list[list.length - 1]
    if (first.added !== last.added) continue
    const { userId, user, displayName, emoji, added, admin } = last
    out.push({ userId, user, displayName, emoji, added, admin })
  }
  return out
}

/** "👍 added by Alice(1), Bob(2); ✅ removed by Alice(1)" */
export function describeChanges(changes: ReactionChange[]): string {
  const groups = new Map<string, string[]>()
  for (const c of changes) {
    const k = `${c.emoji} ${c.added ? 'added' : 'removed'}`
    groups.set(k, [...(groups.get(k) ?? []), `${c.displayName}(${c.userId})`])
  }
  return [...groups].map(([k, who]) => `${k} by ${who.join(', ')}`).join('; ')
}

type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void }
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: h => clearTimeout(h as ReturnType<typeof setTimeout>) }

export class ReactionBatcher {
  private pending = new Map<string, { events: ReactionEvent[]; timer: unknown }>()

  constructor(
    private flush: (chatId: string, messageId: string, changes: ReactionChange[]) => void,
    private delayMs = 5000,
    private timers: Timers = realTimers,
  ) {}

  /** Collect an event; the batch for its message is flushed `delayMs` after its first event. */
  add(e: ReactionEvent): void {
    const k = `${e.chatId}/${e.messageId}`
    const cur = this.pending.get(k)
    if (cur) { cur.events.push(e); return }
    const timer = this.timers.set(() => this.fire(k), this.delayMs)
    this.pending.set(k, { events: [e], timer })
  }

  private fire(k: string): void {
    const cur = this.pending.get(k)
    if (!cur) return
    this.pending.delete(k)
    const changes = netChanges(cur.events)
    if (changes.length) this.flush(cur.events[0].chatId, cur.events[0].messageId, changes)
  }

  /** Drop everything not yet flushed (e.g. before a restart). */
  clear(): void {
    for (const { timer } of this.pending.values()) this.timers.clear(timer)
    this.pending.clear()
  }
}

/** "👍×2 (Alice, me) ✅×1" for fetch_messages; `users` is optional (only fetched for single messages). */
export function reactionSummary(rs: { emoji: string; count: number; me?: boolean; users?: string[] }[]): string {
  return rs
    .filter(r => r.count > 0)
    .map(r => {
      const who = r.users?.length ? r.users : r.me ? ['me'] : []
      const more = r.users && r.count > r.users.length ? ', …' : ''
      return `${r.emoji}×${r.count}${who.length ? ` (${who.join(', ')}${more})` : ''}`
    })
    .join(' ')
}
