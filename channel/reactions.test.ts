import { describe, expect, test } from 'bun:test'
import { type ReactionChange, type ReactionEvent, ReactionBatcher, describeChanges, netChanges, reactionSummary } from './reactions'

const ev = (o: Partial<ReactionEvent>): ReactionEvent => ({
  chatId: 'c1', messageId: 'm1', userId: 'u1', user: 'alice', displayName: 'Alice', emoji: '👍', added: true, admin: false, ...o,
})

function fakeTimers() {
  const fns: (() => void)[] = []
  return { fns, timers: { set: (fn: () => void) => fns.push(fn), clear: () => {} } }
}

describe('netChanges', () => {
  test('add + remove cancels, add/remove/add stays added', () => {
    expect(netChanges([ev({}), ev({ added: false })])).toEqual([])
    expect(netChanges([ev({ added: false }), ev({})])).toEqual([])
    expect(netChanges([ev({}), ev({ added: false }), ev({})]).map(c => c.added)).toEqual([true])
  })
  test('different users and emojis are separate', () => {
    const out = netChanges([ev({}), ev({ userId: 'u2', user: 'bob' }), ev({ emoji: '✅' })])
    expect(out.length).toBe(3)
  })
})

describe('describeChanges', () => {
  test('groups by emoji and action', () => {
    const cs: ReactionChange[] = [
      { userId: 'u1', user: 'a', displayName: 'Alice', emoji: '👍', added: true, admin: false },
      { userId: 'u2', user: 'b', displayName: 'Bob', emoji: '👍', added: true, admin: false },
      { userId: 'u1', user: 'a', displayName: 'Alice', emoji: '✅', added: false, admin: false },
    ]
    expect(describeChanges(cs)).toBe('👍 added by Alice(u1), Bob(u2); ✅ removed by Alice(u1)')
  })
})

describe('ReactionBatcher', () => {
  test('merges events per message into one flush', () => {
    const { fns, timers } = fakeTimers()
    const out: [string, string, number][] = []
    const b = new ReactionBatcher((c, m, ch) => out.push([c, m, ch.length]), 5000, timers)
    b.add(ev({}))
    b.add(ev({ userId: 'u2' }))
    b.add(ev({ messageId: 'm2' }))
    expect(fns.length).toBe(2)
    fns.forEach(f => f())
    expect(out).toEqual([['c1', 'm1', 2], ['c1', 'm2', 1]])
  })
  test('no flush when everything cancels out; clear drops pending', () => {
    const { fns, timers } = fakeTimers()
    let n = 0
    const b = new ReactionBatcher(() => n++, 5000, timers)
    b.add(ev({}))
    b.add(ev({ added: false }))
    fns[0]()
    b.add(ev({ messageId: 'm3' }))
    b.clear()
    fns[1]()
    expect(n).toBe(0)
  })
})

describe('reactionSummary', () => {
  test('counts, users and the bot itself', () => {
    expect(reactionSummary([{ emoji: '👍', count: 2, me: true }, { emoji: '✅', count: 1 }])).toBe('👍×2 (me) ✅×1')
    expect(reactionSummary([{ emoji: '👍', count: 3, users: ['alice(1)', 'me'] }])).toBe('👍×3 (alice(1), me, …)')
    expect(reactionSummary([])).toBe('')
  })
})
