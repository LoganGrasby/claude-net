#!/usr/bin/env bun
// Verifies the Claude->server leg: a real MCP client can spawn the server,
// complete the initialize handshake, see the claude/channel capability, read
// the channel instructions, and list the control tools.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

let failures = 0
const check = (cond: unknown, label: string) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`)
  if (!cond) failures++
}

const transport = new StdioClientTransport({
  command: 'bun',
  args: ['src/claude-net.ts'],
  env: {
    ...(process.env as Record<string, string>),
    CLAUDE_NET_HOME: '/tmp/claude-net-test/mcp',
    CLAUDE_NET_NAME: 'mcptest',
    CLAUDE_NET_UI_PORT: '7409',
  },
})

const client = new Client({ name: 'handshake-test', version: '0' }, { capabilities: {} })

try {
  await client.connect(transport)

  const caps = client.getServerCapabilities() as any
  check(caps?.experimental?.['claude/channel'] !== undefined, 'advertises claude/channel capability')
  check(caps?.tools !== undefined, 'advertises tools capability')

  const instructions = client.getInstructions() ?? ''
  check(instructions.includes('claude-net') && instructions.includes('send_message'), 'channel instructions present')

  const { tools } = await client.listTools()
  const names = new Set(tools.map((t) => t.name))
  for (const t of ['list_peers', 'connect_peer', 'approve_peer', 'deny_peer', 'send_message']) {
    check(names.has(t), `tool exposed: ${t}`)
  }

  const res = await client.callTool({ name: 'list_peers', arguments: {} })
  const out = (res.content as any[])?.[0]?.text ?? ''
  check(out.includes('mcptest'), 'list_peers returns this session identity')
} catch (e) {
  console.log(`✗ ${(e as Error).message}`)
  failures++
} finally {
  await client.close().catch(() => {})
}

console.log(failures === 0 ? '\nMCP HANDSHAKE OK' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
