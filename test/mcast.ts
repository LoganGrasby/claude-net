#!/usr/bin/env bun
// Tests for the multicast fallback transport (src/mcast.ts):
//   1. crypto/framing units — sealing is confidential + authenticated, routing
//      fields are bound, and chunking round-trips (no sockets, deterministic);
//   2. a live two-instance round-trip — A multicasts to B, B decrypts and
//      accepts, and A's send() resolves true off B's authenticated ACK.
import {
  seal,
  open,
  frame,
  ackTag,
  startMcast,
  type McastTransport,
} from '../src/mcast'
import { detectIface, type Identity } from '../src/state'

let failures = 0
function check(cond: unknown, label: string) {
  if (cond) {
    console.log(`  ✓ ${label}`)
  } else {
    console.log(`  ✗ ${label}`)
    failures++
  }
}

const TOKEN = 'shared-pair-token-abc123'
const FROM = 'aaaaaaaa-1111-2222-3333-444444444444'
const TO = 'bbbbbbbb-5555-6666-7777-888888888888'
const MID = 'mid-deadbeef'

// --- 1. crypto + framing ---------------------------------------------------
console.log('crypto + framing')
{
  const text = 'what port does the gateway listen on?'
  const blob = seal(TOKEN, FROM, TO, MID, text)
  check(!blob.includes(text), 'sealed blob does not contain plaintext')
  check(!blob.includes(TOKEN), 'sealed blob does not contain the token')
  check(open(TOKEN, FROM, TO, MID, blob) === text, 'open() recovers plaintext')

  // Wrong token must fail to authenticate.
  let wrongTok = false
  try {
    open('different-token', FROM, TO, MID, blob)
  } catch {
    wrongTok = true
  }
  check(wrongTok, 'open() with wrong token throws (auth fails)')

  // Routing fields are bound as AAD: a swapped msg_id must not verify.
  let wrongAad = false
  try {
    open(TOKEN, FROM, TO, 'other-mid', blob)
  } catch {
    wrongAad = true
  }
  check(wrongAad, 'open() with mismatched msg_id throws (AAD bound)')

  // Tampered ciphertext must fail.
  const tampered = blob.slice(0, -2) + (blob.endsWith('A') ? 'B' : 'A')
  let tamper = false
  try {
    open(TOKEN, FROM, TO, MID, tampered)
  } catch {
    tamper = true
  }
  check(tamper, 'open() on tampered blob throws')

  // Chunking: a long message spans multiple TXT records and reassembles.
  const long = 'x'.repeat(1500)
  const bigBlob = seal(TOKEN, FROM, TO, MID, long)
  const records = frame(FROM, TO, MID, bigBlob)
  check(records.length > 1, `long message frames into multiple records (${records.length})`)
  check(
    records.every((r) => {
      const data = r.data as string[]
      return data[1].length <= 200 && JSON.parse(data[0]).n === records.length
    }),
    'every chunk is within the TXT cap and carries the chunk count',
  )
  // Reassemble out of order and decrypt.
  const reassembled = [...records]
    .reverse()
    .sort((a, b) => JSON.parse((a.data as string[])[0]).i - JSON.parse((b.data as string[])[0]).i)
    .map((r) => (r.data as string[])[1])
    .join('')
  check(open(TOKEN, FROM, TO, MID, reassembled) === long, 'reassembled chunks decrypt to the original')

  // ACK tag is deterministic and token-bound.
  check(ackTag(TOKEN, MID) === ackTag(TOKEN, MID), 'ackTag is deterministic')
  check(ackTag(TOKEN, MID) !== ackTag('other', MID), 'ackTag depends on the token')
}

// --- 2. live two-instance round-trip ---------------------------------------
console.log('live multicast round-trip')
const iface = detectIface()
const idA: Identity = { peer_id: 'live-aaaa-0001', created: new Date().toISOString() }
const idB: Identity = { peer_id: 'live-bbbb-0002', created: new Date().toISOString() }

let a: McastTransport | undefined
let b: McastTransport | undefined
const inbox: Array<{ from: string; text: string; mid: string }> = []

try {
  a = startMcast({
    identity: idA,
    iface,
    peerToken: (id) => (id === idB.peer_id ? TOKEN : undefined),
    accept: () => 'rejected', // A is the sender; it should not receive here
  })
  b = startMcast({
    identity: idB,
    iface,
    peerToken: (id) => (id === idA.peer_id ? TOKEN : undefined),
    accept: (from, text, mid) => {
      inbox.push({ from, text, mid })
      return 'delivered'
    },
  })

  await Bun.sleep(900) // let both sockets bind + join the multicast group

  const msg = 'multicast hello — direct port was unreachable'
  const delivered = await a.send(idB.peer_id, TOKEN, msg, 'live-mid-1')
  check(delivered === true, 'send() resolves true on authenticated ACK')
  check(
    inbox.some((m) => m.from === idA.peer_id && m.text === msg && m.mid === 'live-mid-1'),
    'B decrypted and accepted the message',
  )

  // A peer B does not know is dropped: no ACK, send() resolves false.
  const stranger = await b.send('live-cccc-9999', TOKEN, 'should not arrive', 'live-mid-2')
  check(stranger === false, 'send() to a peer the other side cannot decrypt resolves false (no ACK)')
} catch (e) {
  console.log(`  ✗ harness error: ${(e as Error).message}`)
  failures++
} finally {
  a?.stop()
  b?.stop()
}

console.log(failures === 0 ? '\nMCAST OK' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
