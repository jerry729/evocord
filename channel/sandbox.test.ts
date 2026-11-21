import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { dockerArgs, underAllowedRoot } from './sandbox'

describe('underAllowedRoot', () => {
  const root = mkdtempSync(join(tmpdir(), 'sbx-'))
  const allowed = join(root, 'allowed')
  const secret = join(root, 'secret.txt')
  mkdirSync(allowed)
  writeFileSync(join(allowed, 'ok.png'), 'x')
  writeFileSync(secret, 'token')
  symlinkSync(secret, join(allowed, 'link.txt'))

  test('files inside a root are allowed', () => {
    expect(underAllowedRoot(join(allowed, 'ok.png'), [allowed])).toBe(true)
  })
  test('files outside, traversal and symlinks out are refused', () => {
    expect(underAllowedRoot(secret, [allowed])).toBe(false)
    expect(underAllowedRoot(join(allowed, '..', 'secret.txt'), [allowed])).toBe(false)
    expect(underAllowedRoot(join(allowed, 'link.txt'), [allowed])).toBe(false)
    expect(underAllowedRoot(join(allowed, 'missing'), [allowed])).toBe(false)
  })
})

test('dockerArgs locks the container down', () => {
  const args = dockerArgs({
    name: 'n', workdir: '/w', image: 'img', network: 'none', memory: '1g', cpus: '2',
    uid: 1000, gid: 1000, timeoutSec: 30, cmd: ['python3', '.bot/run.py'],
  })
  const s = args.join(' ')
  for (const want of ['--rm', '--cap-drop ALL', 'no-new-privileges', '--network none', '--pids-limit 256',
    '--memory 1g', '--user 1000:1000', '-v /w:/work', 'img timeout -k 5 30 python3 .bot/run.py']) {
    expect(s).toContain(want)
  }
  expect(s).not.toContain('docker.sock')
  expect(args.filter(a => a === '-v')).toHaveLength(1) // only the work dir is mounted
})
