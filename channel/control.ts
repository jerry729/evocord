/**
 * Files shared with supervisor.py.
 *
 *   state/control/restart.json   written here, consumed by the supervisor:
 *                                {"fresh": bool, "reason": str}
 *   state/update.json            the update currently being verified:
 *                                {id, prev, new, chat_id, status, ...}
 *                                status: pending -> ok (written here once the new
 *                                version is connected) | rolled_back (written by
 *                                the supervisor when the new version never came up)
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { CONTROL_DIR, JOBS_DIR, STATE_DIR } from './config'

export const UPDATE_FILE = join(STATE_DIR, 'update.json')
export const RESTART_FILE = join(CONTROL_DIR, 'restart.json')
export const HISTORY_LOG = join(JOBS_DIR, 'history.jsonl')

export type UpdateState = {
  id: string
  prev: string
  new: string
  chat_id: string
  status: 'pending' | 'ok' | 'rolled_back'
  summary?: string
  files?: string[]
  kind?: 'evolve' | 'rollback'
  requested_at: number
  announced?: boolean
  rollback_reason?: string
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

export function requestRestart(opts: { fresh?: boolean; reason: string }): void {
  writeJson(RESTART_FILE, { fresh: !!opts.fresh, reason: opts.reason, at: Date.now() })
}

export const readUpdate = () => readJson<UpdateState>(UPDATE_FILE)
export const writeUpdate = (u: UpdateState) => writeJson(UPDATE_FILE, u)
export const clearUpdate = () => rmSync(UPDATE_FILE, { force: true })

export function logHistory(entry: Record<string, unknown>): void {
  mkdirSync(JOBS_DIR, { recursive: true })
  appendFileSync(HISTORY_LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
}

/** True when launched by supervisor.py (which is what makes restart requests work). */
export const supervised = () => process.env.BOT_SUPERVISED === '1'
