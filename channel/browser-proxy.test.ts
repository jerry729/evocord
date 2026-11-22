import { expect, test } from 'bun:test'
import { spawn } from 'child_process'
import { join } from 'path'
import { DEFAULT_IDLE_MS, IdleTracker, parseArgs, PROXY_ID_PREFIX } from './browser-proxy'

const call = (id: number, name: string) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } })
const ok = (id: unknown) => ({ jsonrpc: '2.0', id, result: { content: [] } })

test('closes only after the browser was used and stayed idle', () => {
  let t = 0
  const tr = new IdleTracker(1000, () => t)
  t = 5000
  expect(tr.shouldClose()).toBe(false) // never used
  tr.fromClient(call(1, 'browser_navigate'))
  t += 5000
  expect(tr.shouldClose()).toBe(false) // still running, never interrupted
  expect(tr.fromServer(ok(1))).toBe(true)
  t += 999
  expect(tr.shouldClose()).toBe(false)
  t += 1
  expect(tr.shouldClose()).toBe(true)
  expect(tr.shouldClose()).toBe(false) // close already in progress
  expect(tr.fromServer(ok(`${PROXY_ID_PREFIX}1`))).toBe(false) // our answer is swallowed
  t += 10_000
  expect(tr.shouldClose()).toBe(false) // already closed
})

test('activity resets the timer and browser_close by the model counts as closed', () => {
  let t = 0
  const tr = new IdleTracker(1000, () => t)
  tr.fromClient(call(1, 'browser_navigate'))
  tr.fromServer(ok(1))
  t = 900
  tr.fromClient(call(2, 'browser_snapshot'))
  tr.fromServer(ok(2))
  t = 1500
  expect(tr.shouldClose()).toBe(false)
  tr.fromClient(call(3, 'browser_close'))
  tr.fromServer(ok(3))
  t = 10_000
  expect(tr.shouldClose()).toBe(false)
})

test('cancelled calls do not keep the browser open forever; 0 disables', () => {
  let t = 0
  const tr = new IdleTracker(1000, () => t)
  tr.fromClient(call(7, 'browser_navigate'))
  tr.fromClient({ method: 'notifications/cancelled', params: { requestId: 7 } } as any)
  t = 2000
  expect(tr.shouldClose()).toBe(true)

  const off = new IdleTracker(0, () => t)
  off.fromClient(call(1, 'browser_navigate'))
  off.fromServer(ok(1))
  t = 1e9
  expect(off.shouldClose()).toBe(false)
})

test('a failed idle close leaves the browser marked open for a retry', () => {
  let t = 0
  const tr = new IdleTracker(1000, () => t)
  tr.fromClient(call(1, 'browser_navigate'))
  tr.fromServer(ok(1))
  t = 1000
  expect(tr.shouldClose()).toBe(true)
  tr.fromServer({ id: `${PROXY_ID_PREFIX}1`, error: { code: -1 } })
  expect(tr.shouldClose()).toBe(true)
})

test('parseArgs', () => {
  expect(parseArgs(['--', 'npx', '-y', 'x'])).toEqual({ idleMs: DEFAULT_IDLE_MS, command: ['npx', '-y', 'x'] })
  expect(parseArgs(['--idle-min', '3', '--', 'a', '--idle-min', '9'])).toEqual({ idleMs: 180_000, command: ['a', '--idle-min', '9'] })
  expect(parseArgs(['--idle-ms', '250', '--', 'a']).idleMs).toBe(250)
})

// End to end: the real proxy in front of a fake MCP server that reports every tool call it receives.
test('proxy forwards traffic and sends browser_close after the idle timeout', async () => {
  const fake = `
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', d => {
      buf += d
      const parts = buf.split('\\n'); buf = parts.pop()
      for (const l of parts) {
        if (!l.trim()) continue
        const m = JSON.parse(l)
        if (m.method === 'tools/call') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'test/seen', params: { name: m.params.name } }) + '\\n')
        if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [] } }) + '\\n')
      }
    })
    process.stdin.on('end', () => process.exit(0))
  `
  const p = spawn(process.execPath, [join(import.meta.dir, 'browser-proxy.ts'), '--idle-ms', '200', '--', process.execPath, '-e', fake], {
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const got: any[] = []
  let buf = ''
  p.stdout!.setEncoding('utf8')
  p.stdout!.on('data', (d: string) => {
    buf += d
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    for (const l of parts) if (l.trim()) got.push(JSON.parse(l))
  })
  const exited = new Promise(r => p.on('exit', r))
  try {
    p.stdin!.write(JSON.stringify(call(1, 'browser_navigate')) + '\n')
    await Bun.sleep(800)
    const seen = got.filter(m => m.method === 'test/seen').map(m => m.params.name)
    expect(seen).toEqual(['browser_navigate', 'browser_close']) // exactly one idle close
    const ids = got.filter(m => m.id !== undefined).map(m => m.id)
    expect(ids).toEqual([1]) // the proxy's own response is not forwarded
  } finally {
    p.stdin!.end()
    await exited
  }
}, 10_000)
