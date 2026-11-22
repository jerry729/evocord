import { describe, expect, test } from 'bun:test'
import { mayEvolve, mayRunCode, normalize } from './config'
import { allowedChat, gate, gateReaction, parseAdminCommand, type Inbound } from './gate'

const cfg = normalize({
  admins: ['100000000000000001'],
  dmAllowFrom: ['100000000000000002'],
  channels: {
    '200000000000000001': { requireMention: true },
    '200000000000000002': { requireMention: false, allowFrom: ['100000000000000003'] },
  },
  mentionPatterns: ['^claude[,，:：\\s]'],
})

const msg = (o: Partial<Inbound>): Inbound => ({
  authorId: '100000000000000009', isDM: false, channelId: '200000000000000001', parentId: null,
  mentionsBot: false, repliesToBot: false, content: 'hi', ...o,
})

describe('gateReaction', () => {
  const r = (o: Partial<Parameters<typeof gateReaction>[0]>) => ({
    reactorId: '100000000000000009', isDM: false, channelId: '200000000000000001', parentId: null, onBotMessage: false, ...o,
  })
  test('requireMention channels: only reactions on the bot\'s messages', () => {
    expect(gateReaction(r({}), cfg).deliver).toBe(false)
    expect(gateReaction(r({ onBotMessage: true }), cfg).deliver).toBe(true)
  })
  test('allowFrom and unconfigured channels apply to the reactor', () => {
    expect(gateReaction(r({ channelId: '200000000000000002' }), cfg).deliver).toBe(false)
    expect(gateReaction(r({ channelId: '200000000000000002', reactorId: '100000000000000003' }), cfg).deliver).toBe(true)
    expect(gateReaction(r({ channelId: '299999999999999999', onBotMessage: true }), cfg).deliver).toBe(false)
  })
  test('DMs: only allowlisted reactors, admin flag set', () => {
    expect(gateReaction(r({ isDM: true }), cfg).deliver).toBe(false)
    expect(gateReaction(r({ isDM: true, reactorId: '100000000000000001' }), cfg)).toEqual({ deliver: true, mentioned: true, admin: true })
  })
})

describe('gate', () => {
  test('DMs only from admins and dmAllowFrom', () => {
    expect(gate(msg({ isDM: true, authorId: '100000000000000001' }), cfg)).toEqual({ deliver: true, mentioned: true, admin: true })
    expect(gate(msg({ isDM: true, authorId: '100000000000000002' }), cfg).deliver).toBe(true)
    expect(gate(msg({ isDM: true }), cfg).deliver).toBe(false)
  })

  test('unknown channels are dropped', () => {
    expect(gate(msg({ channelId: '299999999999999999' }), cfg).deliver).toBe(false)
  })

  test('requireMention: mention, reply-to-bot or pattern', () => {
    expect(gate(msg({}), cfg).deliver).toBe(false)
    expect(gate(msg({ mentionsBot: true }), cfg).deliver).toBe(true)
    expect(gate(msg({ repliesToBot: true }), cfg).deliver).toBe(true)
    expect(gate(msg({ content: 'Claude, hello' }), cfg).deliver).toBe(true)
  })

  test('threads inherit the parent policy', () => {
    expect(gate(msg({ channelId: '300000000000000001', parentId: '200000000000000001', mentionsBot: true }), cfg).deliver).toBe(true)
    expect(gate(msg({ channelId: '300000000000000001', parentId: '299999999999999999', mentionsBot: true }), cfg).deliver).toBe(false)
  })

  test('no-mention channel delivers everything from allowed users, flags mentions', () => {
    const c = '200000000000000002'
    expect(gate(msg({ channelId: c, authorId: '100000000000000003' }), cfg)).toEqual({ deliver: true, mentioned: false, admin: false })
    expect(gate(msg({ channelId: c }), cfg).deliver).toBe(false) // not in allowFrom
    expect(gate(msg({ channelId: c, authorId: '100000000000000001' }), cfg).deliver).toBe(true) // admins always
  })
})

test('allowedChat', () => {
  expect(allowedChat(cfg, { isDM: false, channelId: '200000000000000001', parentId: null })).toBe(true)
  expect(allowedChat(cfg, { isDM: false, channelId: '3', parentId: '200000000000000002' })).toBe(true)
  expect(allowedChat(cfg, { isDM: false, channelId: '299999999999999999', parentId: null })).toBe(false)
  expect(allowedChat(cfg, { isDM: true, channelId: 'x', parentId: null, dmUserId: '100000000000000001' })).toBe(true)
  expect(allowedChat(cfg, { isDM: true, channelId: 'x', parentId: null, dmUserId: null })).toBe(false)
})

test('parseAdminCommand', () => {
  expect(parseAdminCommand('!bot status', '!bot')).toEqual({ cmd: 'status', arg: '' })
  expect(parseAdminCommand('  !BOT evolve add a /roll command\nsecond line', '!bot')).toEqual({ cmd: 'evolve', arg: 'add a /roll command\nsecond line' })
  expect(parseAdminCommand('!bot', '!bot')).toEqual({ cmd: 'help', arg: '' })
  expect(parseAdminCommand('!botany', '!bot')).toBeNull()
  expect(parseAdminCommand('hello !bot status', '!bot')).toBeNull()
})

describe('config', () => {
  test('defaults are closed: no admins, no channels', () => {
    const d = normalize({})
    expect(d.admins).toEqual([])
    expect(d.channels).toEqual({})
  })

  test('malformed ids are dropped, requireMention defaults to true', () => {
    const c = normalize({ admins: ['abc', 123456789012], channels: { 'nope': {}, '200000000000000001': {} } })
    expect(c.admins).toEqual(['123456789012'])
    expect(Object.keys(c.channels)).toEqual(['200000000000000001'])
    expect(c.channels['200000000000000001'].requireMention).toBe(true)
  })

  test('mayEvolve: admins by default; evolve.allow opens it; disabled closes it for everyone', () => {
    const base = { admins: ['100000000000000001'] }
    expect(mayEvolve(normalize(base), '100000000000000009')).toBe(false)
    expect(mayEvolve(normalize(base), '100000000000000001')).toBe(true)
    expect(mayEvolve(normalize({ ...base, evolve: { allow: 'everyone' } }), '100000000000000009')).toBe(true)
    expect(mayEvolve(normalize({ ...base, evolve: { allow: ['100000000000000009'] } }), '100000000000000009')).toBe(true)
    expect(mayEvolve(normalize({ ...base, evolve: { enabled: false, allow: 'everyone' } }), '100000000000000001')).toBe(false)
    expect(normalize({}).evolve.dailyLimit).toBe(5)
  })

  test('mayRunCode honours sandbox.allow; admins always allowed', () => {
    const base = { admins: ['100000000000000001'] }
    expect(mayRunCode(normalize(base), '100000000000000009')).toBe(true)
    expect(mayRunCode(normalize({ ...base, sandbox: { allow: 'admins' } }), '100000000000000009')).toBe(false)
    expect(mayRunCode(normalize({ ...base, sandbox: { allow: 'admins' } }), '100000000000000001')).toBe(true)
    expect(mayRunCode(normalize({ ...base, sandbox: { allow: ['100000000000000009'] } }), '100000000000000009')).toBe(true)
    expect(mayRunCode(normalize({ ...base, sandbox: { enabled: false } }), '100000000000000001')).toBe(false)
  })
})
