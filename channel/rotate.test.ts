import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { normalize } from './config'
import { decide, loadState, parseAt, rotationDay, saveState, type RotateState } from './rotate'

const at = (s: string) => new Date(s).getTime() // local time, like the scheduler
const opts = { atMin: 240, idleMin: 30 }
const MIN = 60_000

test('parseAt', () => {
  expect(parseAt('04:00')).toBe(240)
  expect(parseAt('4:05')).toBe(245)
  expect(parseAt('23:59')).toBe(1439)
  expect(parseAt('24:00')).toBeNull()
  expect(parseAt('4am')).toBeNull()
  expect(parseAt(undefined)).toBeNull()
})

test('rotation days start at the configured time, not midnight', () => {
  expect(rotationDay(at('2026-11-22T03:59:00'), 240)).toBe('2026-11-21')
  expect(rotationDay(at('2026-11-22T04:00:00'), 240)).toBe('2026-11-22')
  expect(rotationDay(at('2026-11-22T23:00:00'), 240)).toBe('2026-11-22')
})

describe('decide', () => {
  const s = (o: Partial<RotateState> = {}): RotateState => ({ last_at: at('2026-11-21T19:55:00'), last_message_at: at('2026-11-21T23:00:00'), ...o })

  test('not before the configured time', () => {
    expect(decide(s(), at('2026-11-22T03:00:00'), opts, at('2026-11-21T23:00:00'), false)).toBe('wait')
  })
  test('after the time, once idle long enough', () => {
    expect(decide(s(), at('2026-11-22T04:10:00'), opts, at('2026-11-22T04:00:00'), false)).toBe('wait') // chatting at 04:00
    expect(decide(s(), at('2026-11-22T04:31:00'), opts, at('2026-11-22T04:00:00'), false)).toBe('start')
  })
  test('postponed while busy (self-update running), even if idle', () => {
    expect(decide(s(), at('2026-11-22T05:00:00'), opts, 0, true)).toBe('wait')
  })
  test('at most once per day', () => {
    const done = s({ last_at: at('2026-11-22T04:40:00'), last_message_at: at('2026-11-22T09:00:00') })
    expect(decide(done, at('2026-11-22T23:00:00'), opts, 0, false)).toBe('wait')
    expect(decide(done, at('2026-11-23T04:31:00'), opts, 0, false)).toBe('start')
  })
  test('a manual rotation before the scheduled time does not replace the scheduled one', () => {
    const manual = s({ last_at: at('2026-11-22T03:00:00'), last_message_at: at('2026-11-22T03:30:00') })
    expect(decide(manual, at('2026-11-22T04:31:00'), opts, 0, false)).toBe('start')
  })
  test('nothing new since the last rotation: skip without a handoff', () => {
    const quiet = s({ last_at: at('2026-11-21T04:40:00'), last_message_at: at('2026-11-21T04:00:00') })
    expect(decide(quiet, at('2026-11-22T04:31:00'), opts, 0, false)).toBe('skip')
  })
  test('nothing while a handoff or restart is in progress', () => {
    const now = at('2026-11-22T05:00:00')
    expect(decide(s({ pending: { kind: 'scheduled', started_at: now } }), now, opts, 0, false)).toBe('wait')
    expect(decide(s({ restarting: { kind: 'manual', started_at: now } }), now, opts, 0, false)).toBe('wait')
  })
})

test('state: first run starts counting from now (no rotation right after install)', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'rotate-')), 'rotate.json')
  const now = at('2026-11-21T19:55:00')
  const first = loadState(file, now)
  expect(first).toEqual({ last_at: now, last_message_at: now })
  expect(decide(first, at('2026-11-21T23:00:00'), opts, 0, false)).toBe('wait')
  expect(decide(first, at('2026-11-22T04:31:00'), opts, now, false)).toBe('start')
  saveState({ ...first, pending: { kind: 'manual', started_at: now, chat_id: '1' } }, file)
  expect(loadState(file).pending?.kind).toBe('manual')
})

test('config: rotate defaults and validation', () => {
  expect(normalize({}).rotate).toEqual({ enabled: true, at: '04:00', idleMin: 30, handoffTimeoutMin: 10 })
  expect(normalize({ rotate: { at: '25:00', idleMin: -5 } }).rotate).toMatchObject({ at: '04:00', idleMin: 0 })
  expect(normalize({ rotate: { enabled: false, at: '3:30', handoffTimeoutMin: 0 } }).rotate)
    .toEqual({ enabled: false, at: '3:30', idleMin: 30, handoffTimeoutMin: 10 })
})
