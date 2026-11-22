/**
 * Native Discord polls: validation of the `reply(poll)` argument and a one-line summary for fetch_messages.
 * No discord.js here so it can be unit-tested; wiring is in server.ts.
 */

export type PollInput = {
  question: { text: string }
  answers: { text: string; emoji?: string }[]
  duration: number
  allowMultiselect: boolean
}

export const POLL_LIMITS = { question: 300, answer: 55, minAnswers: 2, maxAnswers: 10, maxHours: 768, defaultHours: 24 }

/** Validates untrusted tool input; throws with a message the model can act on. */
export function parsePoll(raw: unknown): PollInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('poll must be an object { question, answers, duration_hours?, allow_multiselect? }')
  const p = raw as Record<string, unknown>
  const question = String(p.question ?? '').trim()
  if (!question) throw new Error('poll.question is required')
  if (question.length > POLL_LIMITS.question) throw new Error(`poll.question is longer than ${POLL_LIMITS.question} characters`)
  if (!Array.isArray(p.answers)) throw new Error('poll.answers must be an array')
  const n = p.answers.length
  if (n < POLL_LIMITS.minAnswers || n > POLL_LIMITS.maxAnswers) throw new Error(`poll needs ${POLL_LIMITS.minAnswers}–${POLL_LIMITS.maxAnswers} answers (got ${n})`)
  const answers = p.answers.map((a, i) => {
    const o = typeof a === 'string' ? { text: a } : (a && typeof a === 'object' ? (a as Record<string, unknown>) : {})
    const text = String(o.text ?? '').trim()
    if (!text) throw new Error(`poll.answers[${i}].text is empty`)
    if (text.length > POLL_LIMITS.answer) throw new Error(`poll.answers[${i}].text is longer than ${POLL_LIMITS.answer} characters`)
    const emoji = o.emoji == null ? '' : String(o.emoji).trim()
    if (emoji.length > 64) throw new Error(`poll.answers[${i}].emoji is too long`)
    return emoji ? { text, emoji } : { text }
  })
  const lower = answers.map(a => a.text.toLowerCase())
  if (new Set(lower).size !== lower.length) throw new Error('poll.answers must be distinct')
  let duration: number = POLL_LIMITS.defaultHours
  if (p.duration_hours != null) {
    const d = Number(p.duration_hours)
    if (!Number.isFinite(d) || d < 1 || d > POLL_LIMITS.maxHours) throw new Error(`poll.duration_hours must be 1–${POLL_LIMITS.maxHours}`)
    duration = Math.round(d)
  }
  return { question: { text: question }, answers, duration, allowMultiselect: p.allow_multiselect === true }
}

export type PollView = {
  question: string
  /** voters: who picked this answer (only when fetched live; at most VOTERS_SHOWN are listed). */
  answers: { text: string; emoji?: string; votes: number; voters?: string[] }[]
  multiselect: boolean
  expiresAt: number | null
  finalized: boolean
}

export const VOTERS_SHOWN = 10

/**
 * All voters of one answer via the paginated "Get Answer Voters" endpoint (≤100 per page, `after` cursor).
 * Stops after maxPages; returns `complete: false` then, so callers can keep a larger cached count.
 */
export async function fetchAllVoters<T extends { id: string }>(
  page: (after: string | undefined) => Promise<T[]>,
  maxPages = 10,
): Promise<{ voters: T[]; complete: boolean }> {
  const voters: T[] = []
  let after: string | undefined
  for (let i = 0; i < maxPages; i++) {
    const got = await page(after)
    voters.push(...got)
    if (got.length < 100) return { voters, complete: true }
    after = got.reduce((m, u) => (BigInt(u.id) > BigInt(m) ? u.id : m), got[0]!.id)
  }
  return { voters, complete: false }
}

/** `"Lunch?" 🍜Noodles×3 [a, b, c] / Pizza×1 [d] (multi, ends 2026-11-23 20:00)` */
export function pollSummary(p: PollView, stamp: (ms: number) => string): string {
  const who = (v?: string[], n = 0) => (v?.length ? ` [${v.slice(0, VOTERS_SHOWN).join(', ')}${n > VOTERS_SHOWN ? ', …' : ''}]` : '')
  const opts = p.answers.map(a => `${a.emoji ?? ''}${a.text}×${a.votes}${who(a.voters, a.votes)}`).join(' / ')
  const state = p.finalized ? 'final' : p.expiresAt && p.expiresAt <= Date.now() ? 'ended' : p.expiresAt ? `ends ${stamp(p.expiresAt)}` : 'open'
  return `"${p.question}" ${opts} (${p.multiselect ? 'multi, ' : ''}${state})`
}
