import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { agentSettings, agentSystem, checkDockerArgs, checkScript, describeTool, sensitiveFiles } from './evolve'

test('sensitive files are flagged', () => {
  expect(sensitiveFiles(['channel/server.ts', 'config/runtime-settings.json', 'channel/gate.ts', 'CLAUDE.md', 'README.md']))
    .toEqual(['config/runtime-settings.json', 'channel/gate.ts', 'CLAUDE.md'])
})

test('describeTool', () => {
  expect(describeTool('Edit', { file_path: '/wt/channel/server.ts' }, '/wt')).toBe('✏️ channel/server.ts')
  expect(describeTool('Bash', { command: 'bun test' }, '/wt')).toBe('$ bun test')
})

test('worktree → fake agent → commit → apply → rollback keeps data dirs', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'evo-'))
  const root = join(tmp, 'bot')
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'memory'))
  mkdirSync(join(root, 'state'))
  writeFileSync(join(root, 'a.txt'), 'v1\n')
  mkdirSync(join(root, 'node_modules')) // createJob symlinks it into the worktree; must stay out of the diff
  writeFileSync(join(root, 'CLAUDE.md'), 'persona\n')
  writeFileSync(join(root, 'scripts', 'post-update.sh'), '#!/bin/bash\necho "$1 $2" >> "$BOT_ROOT/state/post.log"\n')
  const fake = join(tmp, 'fake-claude')
  writeFileSync(fake, [
    '#!/bin/bash',
    'echo v2 > a.txt',
    `echo '{"type":"system","subtype":"init","session_id":"sess-1"}'`,
    `echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"'"$PWD"'/a.txt"}}]}}'`,
    `echo '{"type":"result","subtype":"success","is_error":false,"result":"changed a.txt","session_id":"sess-1","total_cost_usd":0.01}'`,
  ].join('\n') + '\n')
  chmodSync(fake, 0o755)
  const proc = Bun.spawnSync(['bun', join(import.meta.dir, 'testdata', 'evolve-scenario.ts')], {
    env: { ...process.env, BOT_ROOT: root, BOT_STATE_DIR: join(root, 'state'), BOT_EVOLVE_DIR: join(tmp, 'evolve'), BOT_CLAUDE_BIN: fake },
  })
  const out = proc.stdout.toString().trim().split('\n').pop()!
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString())
  expect(JSON.parse(out)).toEqual({
    ok: true, text: 'changed a.txt', sessionId: 'sess-1', cost: 0.01, actions: ['✏️ a.txt'], changed: true, files: ['a.txt'],
    status: 'applied', applied: true, aAfterApply: 'v2', aAfterRollback: 'v1',
    manualAfterRollback: false, memoryAfterRollback: true, worktreeLeft: false, rollbackTo: true, postUpdateLog: 2,
  })
}, 60_000)

test('untrusted agent runs get no shell', () => {
  const t: any = agentSettings(true), u: any = agentSettings(false)
  expect(t.permissions.allow.some((r: string) => r.startsWith('Bash('))).toBe(true)
  expect(u.permissions.allow.some((r: string) => r.startsWith('Bash'))).toBe(false)
  expect(u.permissions.deny).toContain('Bash')
  expect(agentSystem(false)).toContain('no shell')
  expect(agentSystem(true)).not.toContain('no shell')
})

test('sandboxed checks: offline by default, only worktree / node_modules / bun mounted', () => {
  const args = checkDockerArgs({ dir: '/wt', nodeModules: '/bot/node_modules', bun: '/b/bun', image: 'img', uid: 1, gid: 2, packageChanged: false })
  const s = args.join(' ')
  expect(s).toContain('--network none')
  expect(s).toContain('--cap-drop ALL')
  expect(args.filter(a => a === '-v')).toHaveLength(3)
  expect(s).toContain('-v /bot/node_modules:/bot/node_modules:ro')
  expect(checkDockerArgs({ dir: '/wt', nodeModules: '/n', bun: '/b', image: 'i', uid: 1, gid: 1, packageChanged: true }).join(' ')).toContain('--network bridge')
  expect(checkScript(false)).toContain('step bun test')
  expect(checkScript(false)).not.toContain('bun install')
  expect(checkScript(true)).toContain('step bun install')
})
