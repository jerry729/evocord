/**
 * Stdio MCP proxy in front of @playwright/mcp that closes the browser when it sits idle.
 *
 *   bun channel/browser-proxy.ts [--idle-min N | --idle-ms N] -- <command> [args...]
 *
 * Messages are forwarded unchanged in both directions (newline-delimited JSON-RPC). The proxy watches
 * `tools/call` requests: once the browser has been used and nothing has been called for the idle timeout
 * (default 10 min; 0 disables), it sends its own `browser_close` call to the child and swallows the
 * answer. Playwright MCP launches the browser again lazily on the next tool call. Calls still in flight
 * keep the browser open, so a long-running browser task is never interrupted.
 */
import { spawn } from 'child_process'

export const DEFAULT_IDLE_MS = 10 * 60_000
/** Our own request ids; the client's ids are numbers or its own strings and never use this prefix. */
export const PROXY_ID_PREFIX = 'browser-proxy-idle-close-'

type Msg = { id?: unknown; method?: string; params?: any; result?: unknown; error?: unknown }

/** Pure bookkeeping (no I/O) so the timing logic can be unit-tested with a fake clock. */
export class IdleTracker {
  /** Browser possibly open: some tool other than browser_close was called since the last close. */
  open = false
  lastUsed = 0
  private inflight = new Map<string, string>() // client request id → tool name
  private closing = false

  constructor(readonly idleMs: number, private now: () => number = Date.now) {}

  /** A message from the client (Claude Code) to the browser server. */
  fromClient(m: Msg): void {
    if (m.method === 'tools/call' && m.id !== undefined) {
      const name = String(m.params?.name ?? '')
      this.inflight.set(JSON.stringify(m.id), name)
      this.lastUsed = this.now()
      if (name !== 'browser_close') this.open = true
    } else if (m.method === 'notifications/cancelled') {
      this.inflight.delete(JSON.stringify(m.params?.requestId))
    }
  }

  /** A message from the browser server. Returns false if it answers our own request (do not forward). */
  fromServer(m: Msg): boolean {
    if (m.method !== undefined || m.id === undefined) return true
    if (typeof m.id === 'string' && m.id.startsWith(PROXY_ID_PREFIX)) {
      this.closing = false
      if (m.error === undefined) this.open = false
      return false
    }
    const key = JSON.stringify(m.id)
    const name = this.inflight.get(key)
    if (name !== undefined) {
      this.inflight.delete(key)
      this.lastUsed = this.now()
      if (name === 'browser_close' && m.error === undefined) this.open = false
    }
    return true
  }

  /** True when the proxy should close the browser now; marks the close as started. */
  shouldClose(): boolean {
    if (this.idleMs <= 0 || !this.open || this.closing || this.inflight.size > 0) return false
    if (this.now() - this.lastUsed < this.idleMs) return false
    this.closing = true
    return true
  }
}

export function parseArgs(argv: string[]): { idleMs: number; command: string[] } {
  const sep = argv.indexOf('--')
  const opts = sep >= 0 ? argv.slice(0, sep) : []
  const command = sep >= 0 ? argv.slice(sep + 1) : argv
  let idleMs = DEFAULT_IDLE_MS
  const env = process.env.BROWSER_IDLE_MIN
  if (env !== undefined && env !== '' && Number.isFinite(Number(env))) idleMs = Number(env) * 60_000
  for (let i = 0; i < opts.length; i++) {
    const v = Number(opts[i + 1])
    if (opts[i] === '--idle-min' && Number.isFinite(v)) idleMs = v * 60_000
    if (opts[i] === '--idle-ms' && Number.isFinite(v)) idleMs = v
  }
  return { idleMs: Math.max(0, idleMs), command }
}

/** Calls onLine for every complete line of a stream. */
function lines(stream: NodeJS.ReadableStream, onLine: (line: string) => void, onEnd: () => void): void {
  let partial = ''
  stream.setEncoding('utf8')
  stream.on('data', (d: string) => {
    partial += d
    const parts = partial.split('\n')
    partial = parts.pop() ?? ''
    for (const l of parts) onLine(l)
  })
  stream.on('end', () => {
    if (partial) onLine(partial)
    onEnd()
  })
}

const parse = (line: string): Msg | null => {
  try {
    const m = JSON.parse(line)
    return m && typeof m === 'object' && !Array.isArray(m) ? m : null
  } catch {
    return null
  }
}

function main(): void {
  const { idleMs, command } = parseArgs(process.argv.slice(2))
  if (command.length === 0) {
    process.stderr.write('browser-proxy: usage: browser-proxy.ts [--idle-min N] -- <command> [args...]\n')
    process.exit(2)
  }
  const tracker = new IdleTracker(idleMs)
  const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] })
  let seq = 0

  lines(process.stdin, line => {
    const m = parse(line)
    if (m) tracker.fromClient(m)
    child.stdin.write(line + '\n')
  }, () => child.stdin.end())

  lines(child.stdout, line => {
    const m = parse(line)
    if (m && !tracker.fromServer(m)) return
    process.stdout.write(line + '\n')
  }, () => {})

  const timer = setInterval(() => {
    if (!tracker.shouldClose()) return
    process.stderr.write(`browser-proxy: browser idle for ${Math.round(idleMs / 1000)}s, closing it\n`)
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: `${PROXY_ID_PREFIX}${++seq}`,
      method: 'tools/call',
      params: { name: 'browser_close', arguments: {} },
    }) + '\n')
  }, Math.max(50, Math.min(30_000, Math.floor(idleMs / 4) || 30_000)))
  timer.unref()

  child.on('error', err => {
    process.stderr.write(`browser-proxy: ${err}\n`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sig, () => {
      try { child.kill(sig) } catch {}
    })
  }
}

if (import.meta.main) main()
