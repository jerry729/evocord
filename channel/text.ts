/** Text helpers with no Discord dependency (unit-tested in text.test.ts). */

/**
 * Split text into Discord-sized messages (limit is in UTF-16 units, which is
 * what String.length counts). Prefers paragraph, then line, then space
 * boundaries; never splits a surrogate pair; keeps ``` code fences balanced
 * by closing an open fence at the end of a chunk and reopening it (with its
 * language tag) at the start of the next.
 */
export function chunk(text: string, limit = 2000): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  let reopen = '' // fence header to prepend to the next chunk, e.g. "```py\n"
  while (rest.length > 0) {
    const room = limit - reopen.length - 4 // reserve "\n```" for closing a fence
    if (reopen.length + rest.length <= limit) {
      out.push(reopen + rest)
      break
    }
    let cut = room
    const para = rest.lastIndexOf('\n\n', room)
    const line = rest.lastIndexOf('\n', room)
    const space = rest.lastIndexOf(' ', room)
    cut = para > room / 2 ? para : line > room / 2 ? line : space > room / 2 ? space : room
    if (cut <= 0) cut = room
    const code = rest.charCodeAt(cut - 1)
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1 // don't split a surrogate pair
    let piece = reopen + rest.slice(0, cut)
    rest = rest.slice(cut).replace(/^\n+/, '')
    const open = openFence(piece)
    if (open !== null) {
      piece += '\n```'
      reopen = open + '\n'
    } else {
      reopen = ''
    }
    out.push(piece)
  }
  return out
}

/** If text ends inside a ``` block, return that block's opening fence line ("```lang"). */
export function openFence(text: string): string | null {
  let open: string | null = null
  for (const m of text.matchAll(/^[ \t]*(```[^\n`]*)/gm)) {
    open = open === null ? m[1].trim() : null
  }
  return open
}

/** Values placed in <channel ...> attributes: single line, bounded. */
export function metaValue(s: string, max = 300): string {
  const flat = s.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

/** Uploader-controlled names must not break out of bracketed / ; separated lists. */
export function safeName(s: string): string {
  return s.replace(/[\[\]\r\n;"<>]/g, '_').slice(0, 120)
}

export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s
  const head = Math.floor(max * 0.7)
  const tail = max - head
  return `${s.slice(0, head)}\n… [${s.length - max} chars omitted] …\n${s.slice(-tail)}`
}
