/**
 * Daily session rotation: "handoff, then a fresh session".
 *
 * Claude Code cannot drop single messages from a session's context (it can only compact, clear, or start a
 * new session), so the context of a long-lived bot only grows. Once a day, after `rotate.at` (server local
 * time, default 04:00) and once the bot has been idle for `rotate.idleMin` minutes, the bridge:
 *   1. asks the model to hand off (kind="system" event="handoff"): write what is worth keeping into memory/,
 *      then call session_handoff with a handoff note (summary of the session + recap of the last hours);
 *   2. restarts the session fresh (no --continue), so the old context, compact summaries included, is gone;
 *   3. starts the new session with a kickoff notice (event="kickoff") that carries the handoff note and asks
 *      it to read memory/ first.
 * New messages during a scheduled handoff postpone the restart until the chat is idle again (nobody gets cut
 * off mid-conversation). If the model does not finish within `handoffTimeoutMin`, the restart happens anyway.
 * `!bot rotate` starts one by hand; `!bot reset` (fresh session, no handoff) also counts as a rotation.
 *
 * state/rotate.json persists across restarts:
 *   last_at          when the current session started fresh (or when tracking began)
 *   last_message_at  last user message delivered to the model (nothing new since last_at = nothing to hand off)
 *   pending          handoff in progress
 *   restarting       fresh restart requested, with the handoff note; consumed by the next boot
 */
import { join } from 'path'
import { STATE_DIR } from './config'
import { readJson, writeJson } from './control'

export const ROTATE_FILE = join(STATE_DIR, 'rotate.json')

export type RotateKind = 'scheduled' | 'manual' | 'reset'

export type Handoff = {
  kind: RotateKind
  started_at: number
  /** Admin who asked (manual / reset). */
  by?: string
  /** Where to report (manual / reset). */
  chat_id?: string
  /** A user message arrived during a scheduled handoff: postpone the restart. */
  interrupted?: boolean
  /** Handoff note from the old session; becomes the new session's kickoff prompt. */
  note?: string
  note_at?: number
  reason?: 'done' | 'timeout' | 'reset'
}

export type RotateState = {
  last_at: number
  last_message_at: number
  pending?: Handoff | null
  restarting?: Handoff | null
}

export type RotateOptions = { atMin: number; idleMin: number }

/** "04:00" → 240; null when malformed. */
export function parseAt(s: unknown): number | null {
  const m = String(s ?? '').match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = Number(m[1]), min = Number(m[2])
  return h < 24 && min < 60 ? h * 60 + min : null
}

/** The rotation "day" a timestamp falls in: the local date, with days starting at `atMin` instead of midnight. */
export function rotationDay(t: number, atMin: number): string {
  const d = new Date(t - atMin * 60_000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * What the scheduler should do now.
 *   wait  – not due, busy, or someone was active recently
 *   skip  – due, but no message reached the model since the last rotation: just mark it done
 *   start – send the handoff notice
 */
export function decide(s: RotateState, now: number, o: RotateOptions, lastActivity: number, busy: boolean): 'wait' | 'skip' | 'start' {
  if (s.pending || s.restarting) return 'wait'
  if (rotationDay(s.last_at, o.atMin) === rotationDay(now, o.atMin)) return 'wait'
  if (s.last_message_at < s.last_at) return 'skip'
  if (busy || now - lastActivity < o.idleMin * 60_000) return 'wait'
  return 'start'
}

export function loadState(file = ROTATE_FILE, now = Date.now()): RotateState {
  const s = readJson<RotateState>(file)
  if (s && typeof s.last_at === 'number') return { ...s, last_message_at: Number(s.last_message_at) || 0 }
  // First run: start counting from now, so the first rotation is the next scheduled one (not right after install).
  const init: RotateState = { last_at: now, last_message_at: now }
  writeJson(file, init)
  return init
}

export const saveState = (s: RotateState, file = ROTATE_FILE) => writeJson(file, s)

export const MAX_NOTE = 6000
