/**
 * run_code: execute a model-written script in a throwaway Docker container.
 *
 * Each chat gets a persistent work dir (state/sandbox/<chat_id>, mounted at
 * /work) so multi-step tasks can reuse files. Nothing else from the host is
 * mounted; the container runs as the host uid with all capabilities dropped,
 * no-new-privileges, and memory/CPU/pid/time limits.
 */
import { copyFileSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, join, relative, sep } from 'path'
import { randomBytes } from 'crypto'
import { type Config, INBOX_DIR, SANDBOX_DIR, WORKSPACE_DIR } from './config'
import { run } from './proc'
import { truncateMiddle } from './text'

export const LANGS: Record<string, { ext: string; cmd: string[] }> = {
  python: { ext: 'py', cmd: ['python3'] },
  bash: { ext: 'sh', cmd: ['bash'] },
  node: { ext: 'js', cmd: ['node'] },
}

export type RunCodeInput = {
  chatId: string
  language: string
  code: string
  /** Host paths (inbox / sandbox / workspace) to copy into /work/input/. */
  files?: string[]
  timeoutSec?: number
  network?: boolean
}

export type RunCodeResult = {
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  stdout: string
  stderr: string
  /** New or modified files under the work dir, as host paths usable in reply(files). */
  outputs: { path: string; size: number }[]
  workdir: string
}

/** Paths the model may read from / attach: Discord downloads, sandbox outputs, its scratch dir. */
export function underAllowedRoot(p: string, roots = [INBOX_DIR, SANDBOX_DIR, WORKSPACE_DIR]): boolean {
  let real: string
  try {
    real = realpathSync(p)
  } catch {
    return false
  }
  return roots.some(r => {
    let root: string
    try {
      root = realpathSync(r)
    } catch {
      return false
    }
    return real === root || real.startsWith(root + sep)
  })
}

export function dockerArgs(o: {
  name: string; workdir: string; image: string; network: 'bridge' | 'none'
  memory: string; cpus: string; uid: number; gid: number; timeoutSec: number; cmd: string[]
}): string[] {
  return [
    'run', '--rm', '--name', o.name,
    '--network', o.network,
    '--memory', o.memory, '--memory-swap', o.memory,
    '--cpus', o.cpus, '--pids-limit', '256',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', `${o.uid}:${o.gid}`,
    '--tmpfs', '/tmp:rw,exec,size=512m',
    '-e', 'HOME=/tmp',
    '-v', `${o.workdir}:/work`, '-w', '/work',
    '--stop-timeout', '2',
    o.image,
    'timeout', '-k', '5', String(o.timeoutSec), ...o.cmd,
  ]
}

function walk(dir: string, base: string, out: { rel: string; mtimeMs: number; size: number }[], depth = 0) {
  if (depth > 6 || out.length > 2000) return
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, base, out, depth + 1)
    else if (e.isFile()) {
      const st = statSync(p)
      out.push({ rel: relative(base, p), mtimeMs: st.mtimeMs, size: st.size })
    }
  }
}

export async function runCode(input: RunCodeInput, cfg: Config): Promise<RunCodeResult> {
  const lang = LANGS[input.language]
  if (!lang) throw new Error(`language must be one of: ${Object.keys(LANGS).join(', ')}`)
  if (!/^\d{5,25}$/.test(input.chatId)) throw new Error('bad chat_id')
  const s = cfg.sandbox
  const timeoutSec = Math.max(1, Math.min(input.timeoutSec ?? s.timeoutSec, s.maxTimeoutSec))
  const workdir = join(SANDBOX_DIR, input.chatId)
  const botDir = join(workdir, '.bot')
  mkdirSync(botDir, { recursive: true })

  for (const f of input.files ?? []) {
    if (!underAllowedRoot(f)) throw new Error(`file not allowed (only Discord downloads, sandbox and workspace files): ${f}`)
    mkdirSync(join(workdir, 'input'), { recursive: true })
    copyFileSync(f, join(workdir, 'input', basename(f)))
  }

  const id = `${Date.now()}-${randomBytes(3).toString('hex')}`
  const script = `.bot/run-${id}.${lang.ext}`
  writeFileSync(join(workdir, script), input.code)

  const snap = new Map<string, number>()
  const pre: { rel: string; mtimeMs: number; size: number }[] = []
  walk(workdir, workdir, pre)
  for (const f of pre) snap.set(f.rel, f.mtimeMs)

  const before = Date.now()
  const name = `evocord-run-${id}`
  const args = dockerArgs({
    name, workdir: realpathSync(workdir), image: s.image,
    network: input.network === false ? 'none' : s.network,
    memory: s.memory, cpus: s.cpus,
    uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000,
    timeoutSec, cmd: [...lang.cmd, script],
  })
  const r = await run('docker', args, { timeoutMs: (timeoutSec + 30) * 1000, maxBytes: 512 * 1024 })
  if (r.timedOut) await run('docker', ['kill', name], { timeoutMs: 15000 })
  if (r.code === 125 || /Unable to find image|Cannot connect to the Docker daemon|permission denied.*docker/i.test(r.stderr)) {
    throw new Error(`docker failed: ${r.stderr.trim().slice(-400)} — run scripts/setup.sh to build ${s.image}`)
  }

  const files: { rel: string; mtimeMs: number; size: number }[] = []
  walk(workdir, workdir, files)
  const outputs = files
    .filter(f => snap.get(f.rel) !== f.mtimeMs && !f.rel.startsWith('.bot' + sep) && !f.rel.startsWith('input' + sep))
    .slice(0, 50)
    .map(f => ({ path: join(workdir, f.rel), size: f.size }))
  const exitCode = r.code === 124 ? null : r.code
  return {
    exitCode,
    timedOut: r.timedOut || r.code === 124,
    durationMs: Date.now() - before,
    stdout: truncateMiddle(r.stdout, 8000),
    stderr: truncateMiddle(r.stderr, 4000),
    outputs,
    workdir,
  }
}

/** Remove sandbox scripts and inbox files older than maxAgeDays. */
export function pruneOld(maxAgeDays = 7): void {
  const cutoff = Date.now() - maxAgeDays * 86400_000
  for (const root of [INBOX_DIR, SANDBOX_DIR]) {
    const files: { rel: string; mtimeMs: number; size: number }[] = []
    try { walk(root, root, files) } catch { continue }
    for (const f of files) if (f.mtimeMs < cutoff) rmSync(join(root, f.rel), { force: true })
  }
}
