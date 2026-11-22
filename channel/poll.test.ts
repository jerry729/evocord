import { describe, expect, test } from 'bun:test'
import { fetchAllVoters, parsePoll, pollSummary } from './poll'

const base = { question: 'Dinner?', answers: [{ text: 'Noodles' }, { text: 'Pizza', emoji: '🍕' }] }

describe('parsePoll', () => {
  test('defaults: 24h, single choice', () => {
    expect(parsePoll(base)).toEqual({
      question: { text: 'Dinner?' },
      answers: [{ text: 'Noodles' }, { text: 'Pizza', emoji: '🍕' }],
      duration: 24,
      allowMultiselect: false,
    })
  })
  test('accepts plain-string answers, multiselect, custom duration', () => {
    const p = parsePoll({ question: 'q', answers: ['a', 'b', 'c'], duration_hours: 2.4, allow_multiselect: true })
    expect(p.answers).toEqual([{ text: 'a' }, { text: 'b' }, { text: 'c' }])
    expect(p.duration).toBe(2)
    expect(p.allowMultiselect).toBe(true)
  })
  test('answer count must be 2–10', () => {
    expect(() => parsePoll({ question: 'q', answers: ['a'] })).toThrow(/2–10/)
    expect(() => parsePoll({ question: 'q', answers: Array.from({ length: 11 }, (_, i) => `a${i}`) })).toThrow(/2–10/)
    expect(parsePoll({ question: 'q', answers: Array.from({ length: 10 }, (_, i) => `a${i}`) }).answers.length).toBe(10)
  })
  test('duration range 1–768', () => {
    expect(() => parsePoll({ ...base, duration_hours: 0 })).toThrow(/1–768/)
    expect(() => parsePoll({ ...base, duration_hours: 769 })).toThrow(/1–768/)
    expect(() => parsePoll({ ...base, duration_hours: 'abc' })).toThrow(/1–768/)
    expect(parsePoll({ ...base, duration_hours: 768 }).duration).toBe(768)
  })
  test('rejects bad shapes and lengths', () => {
    expect(() => parsePoll(null)).toThrow()
    expect(() => parsePoll([])).toThrow()
    expect(() => parsePoll({ answers: ['a', 'b'] })).toThrow(/question/)
    expect(() => parsePoll({ question: 'x'.repeat(301), answers: ['a', 'b'] })).toThrow(/300/)
    expect(() => parsePoll({ question: 'q', answers: 'a,b' })).toThrow(/array/)
    expect(() => parsePoll({ question: 'q', answers: ['a', ' '] })).toThrow(/empty/)
    expect(() => parsePoll({ question: 'q', answers: ['a', 'x'.repeat(56)] })).toThrow(/55/)
    expect(() => parsePoll({ question: 'q', answers: ['Yes', 'yes'] })).toThrow(/distinct/)
  })
})

describe('pollSummary', () => {
  const stamp = (ms: number) => `T${ms}`
  test('open poll with end time', () => {
    const s = pollSummary({
      question: 'Lunch?', multiselect: true, finalized: false, expiresAt: Date.now() + 3_600_000,
      answers: [{ text: 'Noodles', emoji: '🍜', votes: 3 }, { text: 'Pizza', votes: 1 }],
    }, stamp)
    expect(s).toMatch(/^"Lunch\?" 🍜Noodles×3 \/ Pizza×1 \(multi, ends T\d+\)$/)
  })
  test('finalized / expired', () => {
    const v = { question: 'q', multiselect: false, answers: [{ text: 'a', votes: 0 }, { text: 'b', votes: 2 }] }
    expect(pollSummary({ ...v, finalized: true, expiresAt: 1 }, stamp)).toBe('"q" a×0 / b×2 (final)')
    expect(pollSummary({ ...v, finalized: false, expiresAt: 1 }, stamp)).toBe('"q" a×0 / b×2 (ended)')
  })
  test('lists voters, truncated after 10', () => {
    const many = Array.from({ length: 12 }, (_, i) => `u${i}`)
    const s = pollSummary({
      question: 'q', multiselect: false, finalized: false, expiresAt: null,
      answers: [{ text: 'Alice', votes: 1, voters: ['alice(1)'] }, { text: 'b', votes: 12, voters: many }, { text: 'c', votes: 0, voters: [] }],
    }, stamp)
    expect(s).toBe(`"q" Alice×1 [alice(1)] / b×12 [${many.slice(0, 10).join(', ')}, …] / c×0 (open)`)
  })
})

describe('fetchAllVoters', () => {
  const users = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: String(1000 + from + i) }))
  test('single short page', async () => {
    const calls: (string | undefined)[] = []
    const r = await fetchAllVoters(async after => (calls.push(after), users(0, 2)))
    expect(r).toEqual({ voters: users(0, 2), complete: true })
    expect(calls).toEqual([undefined])
  })
  test('paginates with the highest id as cursor', async () => {
    const calls: (string | undefined)[] = []
    const r = await fetchAllVoters(async after => {
      calls.push(after)
      return after === undefined ? users(0, 100) : users(100, 5)
    })
    expect(r.voters.length).toBe(105)
    expect(r.complete).toBe(true)
    expect(calls).toEqual([undefined, '1099'])
  })
  test('stops at maxPages and reports incomplete', async () => {
    const r = await fetchAllVoters(async () => users(0, 100), 2)
    expect(r).toMatchObject({ complete: false })
    expect(r.voters.length).toBe(200)
  })
})
