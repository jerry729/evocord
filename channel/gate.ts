/**
 * Inbound access decision, separated from discord.js so it can be unit-tested.
 * Outbound tools use allowedChat() so the model can only post where people
 * are allowed to reach it from.
 */
import { type Config, isAdmin } from './config'

export type Inbound = {
  authorId: string
  isDM: boolean
  /** Channel the message is in (thread ID for threads). */
  channelId: string
  /** Parent channel for threads, else null. Threads inherit their parent's policy. */
  parentId: string | null
  mentionsBot: boolean
  repliesToBot: boolean
  content: string
}

export type Verdict =
  | { deliver: false; reason: string }
  | { deliver: true; mentioned: boolean; admin: boolean }

export function gate(m: Inbound, cfg: Config): Verdict {
  const admin = isAdmin(cfg, m.authorId)
  if (m.isDM) {
    if (admin || cfg.dmAllowFrom.includes(m.authorId)) return { deliver: true, mentioned: true, admin }
    return { deliver: false, reason: 'dm sender not allowlisted' }
  }
  const policy = cfg.channels[m.parentId ?? m.channelId]
  if (!policy) return { deliver: false, reason: 'channel not configured' }
  if (policy.allowFrom.length > 0 && !policy.allowFrom.includes(m.authorId) && !admin) {
    return { deliver: false, reason: 'sender not in channel allowFrom' }
  }
  const mentioned = m.mentionsBot || m.repliesToBot || matchesPattern(m.content, cfg.mentionPatterns)
  if (policy.requireMention && !mentioned) return { deliver: false, reason: 'not mentioned' }
  return { deliver: true, mentioned, admin }
}

/**
 * Same rules as gate() for an emoji reaction: the reactor must be allowed to reach the bot in this chat. In
 * channels that require a mention, only reactions on the bot's own messages count (like a reply to the bot).
 */
export function gateReaction(
  r: { reactorId: string; isDM: boolean; channelId: string; parentId: string | null; onBotMessage: boolean },
  cfg: Config,
): Verdict {
  return gate({
    authorId: r.reactorId, isDM: r.isDM, channelId: r.channelId, parentId: r.parentId,
    mentionsBot: false, repliesToBot: r.onBotMessage, content: '',
  }, cfg)
}

export function matchesPattern(text: string, patterns: string[]): boolean {
  for (const p of patterns) {
    try {
      if (new RegExp(p, 'i').test(text)) return true
    } catch {}
  }
  return false
}

/** May the bot post in / read from this chat? dmUserId is the DM recipient for DM channels. */
export function allowedChat(
  cfg: Config,
  chat: { isDM: boolean; channelId: string; parentId: string | null; dmUserId?: string | null },
): boolean {
  if (chat.isDM) {
    const u = chat.dmUserId
    return !!u && (isAdmin(cfg, u) || cfg.dmAllowFrom.includes(u))
  }
  return (chat.parentId ?? chat.channelId) in cfg.channels
}

/** Parse "!bot <cmd> [args]" from an admin. Returns null when it is not a command. */
export function parseAdminCommand(content: string, prefix: string): { cmd: string; arg: string } | null {
  const t = content.trim()
  if (!t.toLowerCase().startsWith(prefix.toLowerCase())) return null
  const rest = t.slice(prefix.length)
  if (rest && !/^\s/.test(rest)) return null // "!botany" is not a command
  const m = rest.trim().match(/^(\S+)\s*([\s\S]*)$/)
  return m ? { cmd: m[1].toLowerCase(), arg: m[2].trim() } : { cmd: 'help', arg: '' }
}
