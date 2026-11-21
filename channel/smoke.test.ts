// Starts the real channel server (offline: no Discord) and talks MCP to it over stdio.
// Catches runtime errors that the type checker cannot (bad imports, top-level exceptions).
import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

test('channel server starts and lists its tools', async () => {
  const state = mkdtempSync(join(tmpdir(), 'smoke-'))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, 'server.ts')],
    env: { ...(process.env as Record<string, string>), BOT_DISCORD_OFFLINE: '1', BOT_STATE_DIR: state, BOT_ENV_FILE: join(state, 'none.env') },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'smoke', version: '0' })
  try {
    await client.connect(transport)
    expect(client.getServerCapabilities()?.experimental?.['claude/channel']).toBeDefined()
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name)
    for (const t of ['reply', 'fetch_messages', 'download_attachment', 'transcribe', 'run_code', 'self_update']) expect(names).toContain(t)
    const r: any = await client.callTool({ name: 'reply', arguments: { chat_id: 'not-an-id', text: 'x' } })
    expect(r.isError).toBe(true)
  } finally {
    await client.close()
  }
}, 30_000)
