/** Subprocess helper: argv only (no shell), bounded output, timeout kills the whole process group. */
import { spawn } from 'child_process'

export type RunResult = { code: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean }

export type RunOptions = {
  cwd?: string
  env?: Record<string, string | undefined>
  timeoutMs?: number
  input?: string
  maxBytes?: number
  /** Called for each complete stdout line (for streaming JSON). */
  onLine?: (line: string) => void
}

/** Process groups still running, so shutdown can take them down (an orphaned agent would keep editing). */
const live = new Set<number>()

export function killAllChildren(sig: NodeJS.Signals = 'SIGTERM'): void {
  for (const pid of live) {
    try { process.kill(-pid, sig) } catch {}
  }
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const max = opts.maxBytes ?? 4 * 1024 * 1024
  return new Promise(resolve => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: (opts.env ?? process.env) as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true, // own process group, so a timeout kills grandchildren too
    })
    if (child.pid) live.add(child.pid)
    let stdout = '', stderr = '', partial = ''
    let timedOut = false
    const append = (cur: string, chunk: string) => (cur.length >= max ? cur : (cur + chunk).slice(0, max))
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      stdout = append(stdout, d)
      if (opts.onLine) {
        partial += d
        const lines = partial.split('\n')
        partial = lines.pop() ?? ''
        for (const l of lines) if (l.trim()) opts.onLine(l)
      }
    })
    child.stderr.on('data', (d: string) => (stderr = append(stderr, d)))
    const kill = (sig: NodeJS.Signals) => {
      try { process.kill(-child.pid!, sig) } catch { try { child.kill(sig) } catch {} }
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          kill('SIGTERM')
          setTimeout(() => kill('SIGKILL'), 5000).unref()
        }, opts.timeoutMs)
      : null
    child.on('error', err => {
      if (child.pid) live.delete(child.pid)
      if (timer) clearTimeout(timer)
      resolve({ code: null, signal: null, stdout, stderr: stderr + String(err), timedOut })
    })
    child.on('close', (code, signal) => {
      if (child.pid) live.delete(child.pid)
      if (timer) clearTimeout(timer)
      if (opts.onLine && partial.trim()) opts.onLine(partial)
      resolve({ code, signal, stdout, stderr, timedOut })
    })
    if (opts.input !== undefined) child.stdin.end(opts.input)
    else child.stdin.end()
  })
}

/** Environment for child agents/tools: no Discord token, no inherited Claude Code session variables. */
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    // CLAUDE_CONFIG_DIR is kept: the supervisor only sets it when the bot uses its own account dir.
    if (k === 'DISCORD_BOT_TOKEN' || (k.startsWith('CLAUDE') && k !== 'CLAUDE_CONFIG_DIR')) continue
    env[k] = v
  }
  return { ...env, ...extra }
}
