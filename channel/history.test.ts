import { expect, test } from 'bun:test'
import { formatLine, parseMessageLink, searchParams, snowflakeAt, snowflakeTime, toBound } from './history'

test('message links', () => {
  expect(parseMessageLink('see https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333 ok'))
    .toEqual({ guildId: '111111111111111111', channelId: '222222222222222222', messageId: '333333333333333333' })
  expect(parseMessageLink('https://ptb.discord.com/channels/@me/222222222222222222/333333333333333333')?.guildId).toBeNull()
  expect(parseMessageLink('https://discordapp.com/channels/1/22222/33333')?.messageId).toBe('33333')
  expect(parseMessageLink('https://example.com/channels/1/2/3')).toBeNull()
})

test('snowflakes round-trip times', () => {
  const t = Date.UTC(2026, 10, 21, 12, 0, 0)
  expect(snowflakeTime(snowflakeAt(t))).toBe(t)
  // a real id: 2015-01-01 epoch + known offset
  expect(snowflakeTime('175928847299117063')).toBe(1462015105796)
})

test('date bounds', () => {
  expect(toBound('200000000000000001')).toBe('200000000000000001')
  expect(toBound('')).toBeNull()
  const start = snowflakeTime(toBound('2026-11-20')!)
  const end = snowflakeTime(toBound('2026-11-20', true)!)
  expect(end - start).toBe(24 * 3600_000)
  expect(new Date(start).getHours()).toBe(0) // local midnight
  expect(snowflakeTime(toBound('2026-11-20T10:00:00Z')!)).toBe(Date.UTC(2026, 10, 20, 10))
  expect(() => toBound('last tuesday')).toThrow()
})

test('search params: repeated array keys, clamps, sort', () => {
  const q = searchParams({ channelIds: ['200000000000000001'], query: ' pizza ', authorIds: ['100000000000000001', 'x'], has: ['image', '-link', 'bogus'], limit: 99, sort: 'oldest' })
  expect(q.getAll('channel_id')).toEqual(['200000000000000001'])
  expect(q.get('content')).toBe('pizza')
  expect(q.getAll('author_id')).toEqual(['100000000000000001'])
  expect(q.getAll('has')).toEqual(['image', '-link'])
  expect(q.get('limit')).toBe('25')
  expect(q.get('sort_order')).toBe('asc')
  expect(searchParams({ channelIds: [], sort: 'relevance' }).get('sort_by')).toBe('relevance')
  expect(searchParams({ channelIds: [] }).get('sort_order')).toBe('desc')
})

test('formatLine', () => {
  const line = formatLine({ id: '9', ts: Date.UTC(2026, 10, 21), author: 'alice(1)', content: 'a\nb', attachments: 2, voice: null })
  expect(line).toContain('alice(1): a ⏎ b [voice: not transcribed — use transcribe]  (id: 9 +2att)')
  expect(formatLine({ id: '9', ts: 0, author: 'x', content: 'y'.repeat(50), attachments: 0 }, 10)).toContain('yyyyyyyyyy…')
})
