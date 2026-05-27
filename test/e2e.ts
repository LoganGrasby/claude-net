#!/usr/bin/env bun
// End-to-end test: two real claude-net instances on this machine discover each
// other over mDNS, pair, and exchange a message — and we verify the inbound
// message actually surfaces as a notifications/claude/channel event on the
// receiver's stdout (the Claude-facing leg). Also probes the security gates.
import { rmSync } from 'node:fs'

const ROOT = '/tmp/claude-net-test'
const MSG = 'what port does the gateway listen on?'

let failures = 0
function check(cond: unknown, label: string) {
  if (cond) {
    console.log(`  ✓ ${label}`)
  } else {
    console.log(`  ✗ ${label}`)
    failures++
  }
}

function spawnPeer(name: string, uiPort: number) {
  const home = `${ROOT}/${name}`
  rmSync(home, { recursive: true, force: true })
  const proc = Bun.spawn({
    cmd: ['bun', 'src/claude-net.ts'],
    env: {
      ...process.env,
      CLAUDE_NET_HOME: home,
      CLAUDE_NET_NAME: name,
      CLAUDE_NET_PROJECT: `${name}-project`,
      CLAUDE_NET_UI_PORT: String(uiPort),
    },
    stdin: 'pipe', // keep stdin open so the MCP stdio transport stays connected
    stdout: 'pipe', // capture channel notifications (the Claude-facing leg)
    stderr: 'pipe',
  })
  return { proc, uiPort, out: collect(proc.stdout), errLog: collect(proc.stderr) }
}

function collect(stream: ReadableStream<Uint8Array>) {
  const state = { text: '' }
  const dec = new TextDecoder()
  ;(async () => {
    const reader = stream.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) state.text += dec.decode(value, { stream: true })
      }
    } catch {
      /* stream closed */
    }
  })()
  return state
}

async function state(uiPort: number): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${uiPort}/api/state`)
  return r.json()
}

async function post(uiPort: number, path: string, body: unknown) {
  const r = await fetch(`http://127.0.0.1:${uiPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return r.json()
}

async function until(fn: () => Promise<boolean>, ms: number, label: string) {
  const t0 = Date.now()
  for (;;) {
    try {
      if (await fn()) return
    } catch {
      /* not ready */
    }
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for: ${label}`)
    await Bun.sleep(200)
  }
}

/** Find a parsed JSON-RPC channel notification on a captured stdout buffer. */
function channelEvents(buf: string): any[] {
  const out: any[] = []
  for (const line of buf.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    try {
      const m = JSON.parse(s)
      if (m.method === 'notifications/claude/channel') out.push(m.params)
    } catch {
      /* partial line */
    }
  }
  return out
}

const alice = spawnPeer('alice', 7401)
const bob = spawnPeer('bob', 7402)

try {
  console.log('boot + discovery')
  await until(async () => !!(await state(alice.uiPort)).me, 8000, 'alice up')
  await until(async () => !!(await state(bob.uiPort)).me, 8000, 'bob up')
  const aliceId = (await state(alice.uiPort)).me.peer_id
  const bobId = (await state(bob.uiPort)).me.peer_id
  check(aliceId && bobId && aliceId !== bobId, 'two distinct identities')

  await until(
    async () => (await state(alice.uiPort)).roster.some((p: any) => p.peer_id === bobId),
    10000,
    'alice discovers bob via mDNS',
  )
  await until(
    async () => (await state(bob.uiPort)).roster.some((p: any) => p.peer_id === aliceId),
    10000,
    'bob discovers alice via mDNS',
  )
  check(true, 'mutual mDNS discovery')

  console.log('pairing handshake')
  await post(alice.uiPort, '/api/connect', { peer_id: bobId })
  let code = ''
  await until(async () => {
    const pend = (await state(bob.uiPort)).pendingIn
    if (pend.length) code = pend[0].code
    return !!code
  }, 5000, 'bob receives pair request')
  check(/^[a-km-z]{5}$/.test(code), `pair code is 5 letters w/o l (got "${code}")`)

  await post(bob.uiPort, '/api/approve', { code })
  await until(
    async () => (await state(alice.uiPort)).paired.some((p: any) => p.peer_id === bobId),
    5000,
    'alice sees pairing confirmed',
  )
  await until(
    async () => (await state(bob.uiPort)).paired.some((p: any) => p.peer_id === aliceId),
    5000,
    'bob sees pairing confirmed',
  )
  check(true, 'mutual pairing established')

  console.log('message delivery')
  await post(alice.uiPort, '/api/send', { peer_id: bobId, text: MSG })
  await until(
    async () => (await state(bob.uiPort)).log.some((l: any) => l.dir === 'in' && l.text === MSG),
    5000,
    'bob logs the inbound message',
  )
  // The decisive check: did it reach the Claude-facing channel?
  await until(async () => channelEvents(bob.out.text).some((p) => p.content === MSG), 5000, 'channel event emitted')
  const ev = channelEvents(bob.out.text).find((p) => p.content === MSG)
  check(ev?.meta?.kind === 'message', 'channel event kind=message')
  check(ev?.meta?.peer_name === 'alice', 'channel event peer_name from paired record (=alice)')
  check(ev?.meta?.peer_id === aliceId, 'channel event carries alice peer_id')

  console.log('security gates')
  const bobState = await state(bob.uiPort)
  const bobAddr = bobState.iface.address
  const bobPeerPort = bobState.peerPort

  // Bad token from a known peer id -> rejected.
  const badTok = await fetch(`http://${bobAddr}:${bobPeerPort}/msg`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from_id: aliceId, token: 'WRONG', text: 'injected', msg_id: 'x1' }),
  })
  check(badTok.status === 403, 'message with wrong token rejected (403)')

  // Unknown peer id -> rejected.
  const unknown = await fetch(`http://${bobAddr}:${bobPeerPort}/msg`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from_id: 'nobody', token: 'whatever', text: 'injected', msg_id: 'x2' }),
  })
  check(unknown.status === 403, 'message from unpaired id rejected (403)')

  // The injected text must NOT have reached Claude.
  check(
    !channelEvents(bob.out.text).some((p) => p.content === 'injected'),
    'rejected messages never reached the channel',
  )

  // Peer server must be bound to the LAN interface, NOT loopback.
  let loopbackRefused = false
  try {
    await fetch(`http://127.0.0.1:${bobPeerPort}/msg`, {
      method: 'POST',
      body: '{}',
      signal: AbortSignal.timeout(1500),
    })
  } catch {
    loopbackRefused = true
  }
  check(loopbackRefused, 'peer port not reachable on loopback (LAN-bound)')
} catch (e) {
  console.log(`\n✗ harness error: ${(e as Error).message}`)
  console.log('--- alice stderr ---\n' + alice.errLog.text.split('\n').slice(-8).join('\n'))
  console.log('--- bob stderr ---\n' + bob.errLog.text.split('\n').slice(-8).join('\n'))
  failures++
} finally {
  alice.proc.kill()
  bob.proc.kill()
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
