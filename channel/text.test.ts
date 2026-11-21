import { describe, expect, test } from 'bun:test'
import { chunk, metaValue, openFence, safeName, truncateMiddle } from './text'

describe('chunk', () => {
  test('short text is one chunk', () => {
    expect(chunk('hello', 2000)).toEqual(['hello'])
  })

  test('every chunk fits the limit and nothing is lost', () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i} ` + 'x'.repeat(i % 40)).join('\n')
    const parts = chunk(text, 500)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(500)
    expect(parts.join('\n').replace(/\n+/g, '\n')).toBe(text.replace(/\n+/g, '\n'))
  })

  test('prefers paragraph boundaries', () => {
    const a = 'a'.repeat(300), b = 'b'.repeat(300)
    expect(chunk(`${a}\n\n${b}`, 400)).toEqual([a, b])
  })

  test('does not split surrogate pairs', () => {
    const text = '😀'.repeat(300) // 600 UTF-16 units, no spaces
    for (const p of chunk(text, 101)) {
      expect(p.length).toBeLessThanOrEqual(101)
      expect(/[\ud800-\udbff]$/.test(p)).toBe(false)
      expect(/^[\udc00-\udfff]/.test(p)).toBe(false)
    }
  })

  test('keeps code fences balanced across chunks', () => {
    const code = Array.from({ length: 80 }, (_, i) => `print(${i})`).join('\n')
    const parts = chunk('intro\n```python\n' + code + '\n```\nouttro', 300)
    expect(parts.length).toBeGreaterThan(2)
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(300)
      expect(openFence(p)).toBeNull()
    }
    expect(parts[1].startsWith('```python\n')).toBe(true)
  })
})

test('openFence', () => {
  expect(openFence('a\n```js\nx')).toBe('```js')
  expect(openFence('a\n```js\nx\n```')).toBeNull()
  expect(openFence('no code')).toBeNull()
})

test('metaValue flattens and bounds', () => {
  expect(metaValue('a\nb\r\n  c')).toBe('a b c')
  expect(metaValue('x'.repeat(50), 10)).toBe('x'.repeat(9) + '…')
})

test('safeName strips delimiter characters', () => {
  expect(safeName('a];b\n"c<d>.png')).toBe('a__b__c_d_.png')
})

test('truncateMiddle', () => {
  expect(truncateMiddle('abc', 10)).toBe('abc')
  const t = truncateMiddle('x'.repeat(100), 20)
  expect(t).toContain('80 chars omitted')
})
