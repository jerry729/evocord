/**
 * Paths and runtime configuration.
 *
 * config/bot.json is re-read whenever it changes, so access edits apply without
 * a restart. A broken edit keeps the last good config instead of falling back
 * to defaults (defaults would silently drop every channel).
 */
import { readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'

export const ROOT = resolve(process.env.BOT_ROOT ?? dirname(import.meta.dir))
export const STATE_DIR = resolve(process.env.BOT_STATE_DIR ?? join(ROOT, 'state'))
export const CONFIG_FILE = resolve(process.env.BOT_CONFIG ?? join(ROOT, 'config', 'bot.json'))
/** Secrets live outside ROOT so the bot session (cwd = ROOT) cannot read them. */
export const ENV_FILE = resolve(
  process.env.BOT_ENV_FILE ?? join(homedir(), '.config', 'evocord', '.env'),
)
export const INBOX_DIR = join(STATE_DIR, 'inbox')
export const SANDBOX_DIR = join(STATE_DIR, 'sandbox')
export const CONTROL_DIR = join(STATE_DIR, 'control')
export const HISTORY_GIT = join(STATE_DIR, 'history.git')
export const JOBS_DIR = join(STATE_DIR, 'evolve')
export const WORKSPACE_DIR = join(ROOT, 'workspace')
/** Evolve worktrees live outside ROOT so CLAUDE.md lookup in them does not climb into the live bot. */
export const EVOLVE_DIR = resolve(
  process.env.BOT_EVOLVE_DIR ?? join(homedir(), '.cache', 'evocord', 'evolve'),
)

export type ChannelPolicy = {
  /** true: only @mentions / replies to the bot / mentionPatterns reach the model. */
  requireMention: boolean
  /** Empty = everyone in the channel. */
  allowFrom: string[]
}

export type Config = {
  admins: string[]
  dmAllowFrom: string[]
  channels: Record<string, ChannelPolicy>
  mentionPatterns: string[]
  ackReaction: string
  adminPrefix: string
  textChunkLimit: number
  voice: {
    enabled: boolean
    model: string
    device: 'auto' | 'cuda' | 'cpu'
    computeType: string
    language: string | null
    initialPrompt: string | null
    maxSeconds: number
    timeoutSec: number
  }
  sandbox: {
    enabled: boolean
    image: string
    network: 'bridge' | 'none'
    timeoutSec: number
    maxTimeoutSec: number
    memory: string
    cpus: string
    /** Who may trigger run_code: 'everyone' (anyone who reaches the bot), 'admins', or a list of user IDs. */
    allow: 'everyone' | 'admins' | string[]
  }
  evolve: {
    enabled: boolean
    model: string | null
    timeoutMin: number
    maxBudgetUsd: number | null
    /** Apply proposals without a click when checks pass and no sensitive file is touched. */
    autoApply: boolean
    /** Who may request / revise self-updates: 'admins', 'everyone' (anyone who reaches the bot) or user IDs. Applying always needs an admin. */
    allow: 'everyone' | 'admins' | string[]
    /** Max agent runs (new requests + revisions) per non-admin user per 24h. */
    dailyLimit: number
  }
  catchup: {
    enabled: boolean
    maxAgeMin: number
    maxMessages: number
  }
  runtime: {
    /** Claude config dir (= which account's subscription) for the session and the self-update agent; null = ~/.claude. */
    claudeConfigDir: string | null
  }
}

export const DEFAULTS: Config = {
  admins: [],
  dmAllowFrom: [],
  channels: {},
  mentionPatterns: [],
  ackReaction: '👀',
  adminPrefix: '!bot',
  textChunkLimit: 2000,
  voice: {
    enabled: true,
    model: 'large-v3-turbo',
    device: 'auto',
    computeType: 'auto',
    language: null,
    initialPrompt: null,
    maxSeconds: 900,
    timeoutSec: 300,
  },
  sandbox: {
    enabled: true,
    image: 'evocord-sandbox:latest',
    network: 'bridge',
    timeoutSec: 60,
    maxTimeoutSec: 600,
    memory: '1g',
    cpus: '2',
    allow: 'everyone',
  },
  evolve: {
    enabled: true,
    model: null,
    timeoutMin: 30,
    maxBudgetUsd: null,
    autoApply: false,
    allow: 'admins',
    dailyLimit: 5,
  },
  catchup: {
    enabled: true,
    maxAgeMin: 30,
    maxMessages: 30,
  },
  runtime: { claudeConfigDir: null },
}

const ids = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String).filter(s => /^\d{5,25}$/.test(s)) : []

/** Merge a parsed bot.json over the defaults, dropping malformed fields. */
export function normalize(raw: any): Config {
  const r = raw && typeof raw === 'object' ? raw : {}
  const channels: Record<string, ChannelPolicy> = {}
  for (const [id, p] of Object.entries<any>(r.channels ?? {})) {
    if (!/^\d{5,25}$/.test(id)) continue
    channels[id] = {
      requireMention: p?.requireMention !== false,
      allowFrom: ids(p?.allowFrom),
    }
  }
  const allow = r.sandbox?.allow
  const evolveAllow = r.evolve?.allow
  return {
    admins: ids(r.admins),
    dmAllowFrom: ids(r.dmAllowFrom),
    channels,
    mentionPatterns: Array.isArray(r.mentionPatterns) ? r.mentionPatterns.map(String) : [],
    ackReaction: typeof r.ackReaction === 'string' ? r.ackReaction : DEFAULTS.ackReaction,
    adminPrefix: typeof r.adminPrefix === 'string' && r.adminPrefix ? r.adminPrefix : DEFAULTS.adminPrefix,
    textChunkLimit: Math.max(100, Math.min(Number(r.textChunkLimit) || 2000, 2000)),
    voice: { ...DEFAULTS.voice, ...(r.voice ?? {}) },
    sandbox: {
      ...DEFAULTS.sandbox,
      ...(r.sandbox ?? {}),
      network: r.sandbox?.network === 'none' ? 'none' : 'bridge',
      allow: allow === 'admins' ? 'admins' : Array.isArray(allow) ? ids(allow) : 'everyone',
    },
    evolve: {
      ...DEFAULTS.evolve,
      ...(r.evolve ?? {}),
      allow: evolveAllow === 'everyone' ? 'everyone' : Array.isArray(evolveAllow) ? ids(evolveAllow) : 'admins',
      dailyLimit: Math.max(0, Number(r.evolve?.dailyLimit ?? DEFAULTS.evolve.dailyLimit) || 0),
    },
    catchup: { ...DEFAULTS.catchup, ...(r.catchup ?? {}) },
    runtime: {
      claudeConfigDir: typeof r.runtime?.claudeConfigDir === 'string' && r.runtime.claudeConfigDir
        ? r.runtime.claudeConfigDir.replace(/^~(?=\/|$)/, homedir())
        : null,
    },
  }
}

let cached: { mtimeMs: number; config: Config } | null = null

export function loadConfig(file = CONFIG_FILE): Config {
  let mtimeMs: number
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    if (!cached) process.stderr.write(`bot: ${file} not found, nobody can reach the bot\n`)
    cached = { mtimeMs: -1, config: normalize({}) }
    return cached.config
  }
  if (cached && cached.mtimeMs === mtimeMs) return cached.config
  try {
    const config = normalize(JSON.parse(readFileSync(file, 'utf8')))
    cached = { mtimeMs, config }
  } catch (err) {
    process.stderr.write(`bot: ${file} is invalid (${err}); keeping previous config\n`)
    cached = { mtimeMs, config: cached?.config ?? normalize({}) }
  }
  return cached.config
}

export const isAdmin = (cfg: Config, userId: string) => cfg.admins.includes(userId)

export function mayRunCode(cfg: Config, userId: string): boolean {
  if (!cfg.sandbox.enabled) return false
  if (isAdmin(cfg, userId)) return true
  const a = cfg.sandbox.allow
  return a === 'everyone' ? true : a === 'admins' ? false : a.includes(userId)
}

export function mayEvolve(cfg: Config, userId: string): boolean {
  if (!cfg.evolve.enabled) return false
  if (isAdmin(cfg, userId)) return true
  const a = cfg.evolve.allow
  return a === 'everyone' ? true : a === 'admins' ? false : a.includes(userId)
}

/** KEY=VALUE lines; real environment wins. */
export function loadEnvFile(file = ENV_FILE): void {
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
    }
  } catch {}
}
