/**
 * Chat history lookup helpers for the fetch_messages / search_messages tools.
 *
 * Memory only keeps what matters long-term; everything else can be found again in Discord:
 *   - one message (link or id)         GET /channels/{channel}/messages/{message}
 *   - context around a message         GET /channels/{channel}/messages?around={message}
 *   - keywords / author / date range   GET /guilds/{guild}/messages/search  (bots allowed since 2026-03;
 *                                       202 + retry_after while the server is being indexed)
 * Dates are turned into snowflake bounds (min_id / max_id).
 */

const DISCORD_EPOCH = 1420070400000n

/** discord.com / ptb / canary message links → ids. */
export function parseMessageLink(s: unknown): { guildId: string | null; channelId: string; messageId: string } | null {
  const m = String(s ?? '').match(/https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d+|@me)\/(\d+)\/(\d+)/)
  return m ? { guildId: m[1] === '@me' ? null : m[1], channelId: m[2], messageId: m[3] } : null
}

export const snowflakeAt = (ms: number): string => ((BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH) << 22n).toString()
export const snowflakeTime = (id: string): number => Number((BigInt(id) >> 22n) + DISCORD_EPOCH)

/**
 * A message id, or a date/time turned into a snowflake bound.
 *   "1234567890123456789"  → as is
 *   "2026-11-20"           → start of that day, server local time (end of that day when `endOfDay`)
 *   "2026-11-20T18:00"     → that moment (local time unless it carries an offset)
 */
export function toBound(v: unknown, endOfDay = false): string | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  if (/^\d{15,25}$/.test(s)) return s
  const day = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (day) {
    const d = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]) + (endOfDay ? 1 : 0))
    return snowflakeAt(d.getTime())
  }
  const t = Date.parse(s)
  if (Number.isNaN(t)) throw new Error(`cannot read "${s}" as a date (YYYY-MM-DD or ISO time) or message id`)
  return snowflakeAt(t)
}

export type SearchInput = {
  channelIds: string[]
  query?: string
  authorIds?: string[]
  after?: string | null
  before?: string | null
  has?: string[]
  limit?: number
  offset?: number
  sort?: 'newest' | 'oldest' | 'relevance'
}

const HAS = new Set(['image', 'sound', 'video', 'file', 'sticker', 'embed', 'link', 'poll', 'snapshot'])

/** Query string for Search Guild Messages (arrays = repeated keys). */
export function searchParams(o: SearchInput): URLSearchParams {
  const q = new URLSearchParams()
  for (const c of o.channelIds) q.append('channel_id', c)
  if (o.query?.trim()) q.set('content', o.query.trim().slice(0, 1024))
  for (const a of o.authorIds ?? []) if (/^\d{5,25}$/.test(a)) q.append('author_id', a)
  if (o.after) q.set('min_id', o.after)
  if (o.before) q.set('max_id', o.before)
  for (const h of o.has ?? []) if (HAS.has(h.replace(/^-/, ''))) q.append('has', h)
  q.set('limit', String(Math.max(1, Math.min(Math.floor(Number(o.limit) || 15), 25))))
  if (o.offset) q.set('offset', String(Math.max(0, Math.min(Math.floor(o.offset), 9975))))
  if (o.sort === 'relevance') q.set('sort_by', 'relevance')
  else q.set('sort_order', o.sort === 'oldest' ? 'asc' : 'desc')
  return q
}

/** One line per message, the same shape for fetched and searched messages. */
export type Line = {
  id: string
  ts: number
  author: string
  content: string
  attachments: number
  voice?: string | null
  chatId?: string
  /** Reaction summary, e.g. "👍×2 ✅×1" (see reactions.ts). */
  reactions?: string
  /** Poll summary (see poll.ts). */
  poll?: string
}

/** "2026-11-21 20:15" in server local time. */
export const localStamp = (ms: number) => new Date(ms).toLocaleString('sv-SE', { hour12: false }).slice(0, 16)

export function formatLine(l: Line, maxLen = 500): string {
  let body = (l.content || '').replace(/[\r\n]+/g, ' ⏎ ')
  if (body.length > maxLen) body = body.slice(0, maxLen) + '…'
  const voice = l.voice !== undefined ? ` [voice: ${l.voice ?? 'not transcribed — use transcribe'}]` : ''
  const att = l.attachments ? ` +${l.attachments}att` : ''
  const reacts = l.reactions ? ` [reactions: ${l.reactions}]` : ''
  const poll = l.poll ? ` [poll: ${l.poll}]` : ''
  return `[${localStamp(l.ts)}] ${l.author}: ${body}${voice}${poll}${reacts}  (id: ${l.id}${l.chatId ? ` · chat ${l.chatId}` : ''}${att})`
}
