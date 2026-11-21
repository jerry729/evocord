import { expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const settings = JSON.parse(readFileSync(join(import.meta.dir, '..', 'config', 'runtime-settings.json'), 'utf8'))

test('chat session: file tools stay inside the bot directory', () => {
  const { allow, deny, defaultMode } = settings.permissions as { allow: string[]; deny: string[]; defaultMode: string }
  // A bare "Read", "Grep" or "Glob" allow rule lets the model read any file the bot's user account can read.
  for (const tool of ['Read', 'Grep', 'Glob', 'Edit', 'Write']) expect(allow).not.toContain(tool)
  for (const rule of allow.filter(r => /^(Read|Edit|Write)\(/.test(r))) expect(rule).toMatch(/^(Read|Edit|Write)\(\.\//)
  expect(defaultMode).toBe('dontAsk')
  expect(deny).toContain('Bash')
})
