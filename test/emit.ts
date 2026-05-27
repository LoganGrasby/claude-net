#!/usr/bin/env bun
// Regression guard for the inbound contract: a simulated inbound message must
// make claude-net write a byte-correct `notifications/claude/channel` to its
// stdout — that stdout IS the MCP pipe Claude Code reads, so this is the exact
// shape the harness ingests and renders as a <channel> event. (Claude Code only
// surfaces it in interactive sessions; see the README note — but emission must
// be correct regardless, and that is what this test pins.)
import { rmSync } from 'node:fs'

const HOME = '/tmp/claude-net-emittest'
const UI = 7447
let passed = 0
function ok(cond: unknown, msg: string) {
  if (!cond) {
    console.error('  ✗ ' + msg)
    throw new Error('FAIL: ' + msg)
  }
  console.log('  ✓ ' + msg)
  passed++
}

rmSync(HOME, { recursive: true, force: true })
const proc = Bun.spawn({
  cmd: ['bun', 'src/claude-net.ts'],
  env: { ...process.env, CLAUDE_NET_NAME: 'emittest', CLAUDE_NET_HOME: HOME, CLAUDE_NET_UI_PORT: String(UI) },
  stdin: 'pipe', // keep alive; also where MCP would read, unused here
  stdout: 'pipe', // the MCP pipe — we assert the notification lands here
  stderr: 'ignore',
})
const chunks: string[] = []
;(async () => {
  const dec = new TextDecoder()
  for await (const c of proc.stdout as any) chunks.push(dec.decode(c))
})()

async function waitUi(ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${UI}/api/state`)
      if (r.ok) { await r.text(); return true }
    } catch {}
    await Bun.sleep(100)
  }
  return false
}

try {
  console.log('emit: simulate → notifications/claude/channel')
  ok(await waitUi(8000), 'inbox UI came up')

  const token = 'EMITTEST-' + Math.random().toString(36).slice(2, 8)
  const res = await fetch(`http://127.0.0.1:${UI}/api/simulate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: token + ' ping' }),
  })
  ok(res.status === 200, 'simulate accepted (200)')
  await res.text()

  let note: any = null
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && !note) {
    for (const ln of chunks.join('').split('\n').filter(Boolean)) {
      try {
        const j = JSON.parse(ln)
        if (j.method === 'notifications/claude/channel') note = j
      } catch {}
    }
    if (!note) await Bun.sleep(100)
  }

  ok(note, 'notifications/claude/channel written to stdout')
  ok(note.jsonrpc === '2.0', 'well-formed JSON-RPC 2.0')
  ok(typeof note.params?.content === 'string' && note.params.content.includes(token), 'content carries the message text')
  ok(note.params?.meta?.kind === 'message', 'meta.kind = "message" (becomes the <channel kind=…> attribute)')

  console.log(`\nEMIT OK (${passed} checks)`)
} finally {
  proc.kill()
}
