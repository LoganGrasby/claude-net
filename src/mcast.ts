// Multicast message transport — the fallback path when a peer's direct HTTP
// port is unreachable (firewall, wrong-interface bind, or a zombie advert on a
// dead port). Discovery already proves multicast works bidirectionally on the
// link even when unicast TCP to the peer's process does not, so we reuse that
// same mDNS path (UDP 5353) to carry messages.
//
// The catch is that multicast is seen by EVERY session on the subnet, so this
// transport cannot rely on the point-to-point privacy the HTTP path enjoys.
// Three things make it safe and reliable anyway:
//   1. Confidentiality + authenticity: the body is AES-256-GCM sealed under a
//      key derived from the per-pair token. The token itself never goes on the
//      wire; non-recipients see only ciphertext, and a valid auth tag proves
//      the sender holds the shared token (i.e. is the paired peer).
//   2. Framing: DNS TXT character-strings cap at 255 bytes, so the sealed blob
//      is base64url'd and chunked across TXT records, reassembled by msg_id.
//   3. Delivery confirmation: the receiver multicasts back an authenticated ACK
//      (an HMAC over the msg_id), so send() can resolve true only on real
//      delivery — restoring the "sent means delivered" guarantee HTTP 200 gave.
import crypto from 'node:crypto'
import mdns from 'multicast-dns'
import type { Identity, Iface } from './state'
import { normalizeIp, onSubnet } from './state'

// TXT record names. The trailing labels keep us clear of the discovery service
// (_claudenet._tcp) so the two never parse each other's records.
const MSG_NAME = '_cnmsg._udp.local'
const ACK_NAME = '_cnack._udp.local'

// Keep a single chunk's base64 payload well under the 255-byte TXT string cap
// (the JSON header rides in a separate string of the same record).
const CHUNK = 200
const ACK_TIMEOUT_MS = 3500
const RESEND_AFTER_MS = 450
const MAX_PARTIALS = 256

interface MsgHeader {
  to: string
  from: string
  mid: string
  i: number
  n: number
}

export interface McastDeps {
  identity: Identity
  iface: Iface
  /** Shared token for a paired peer, or undefined if not paired. */
  peerToken(peerId: string): string | undefined
  /** Hand a decrypted message to the hub; it dedups and emits. */
  accept(fromId: string, text: string, msgId: string): 'delivered' | 'duplicate' | 'rejected'
}

export interface McastTransport {
  /** Multicast `text` to `toId`, resolving true once an authenticated ACK
   *  arrives (or false on timeout). */
  send(toId: string, token: string, text: string, msgId: string): Promise<boolean>
  stop(): void
}

// ---------------------------------------------------------------------------
// Crypto + framing (pure; exported for tests)
// ---------------------------------------------------------------------------

function keyFor(token: string): Buffer {
  return crypto.createHash('sha256').update(token).digest()
}

/** Bind routing fields as additional authenticated data so a sealed blob can't
 *  be replayed under a different (from,to,mid). */
function aad(from: string, to: string, mid: string): Buffer {
  return Buffer.from(`${from}|${to}|${mid}`)
}

/** Seal plaintext → base64url(iv ‖ tag ‖ ciphertext). */
export function seal(token: string, from: string, to: string, mid: string, text: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(token), iv)
  cipher.setAAD(aad(from, to, mid))
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ct]).toString('base64url')
}

/** Open a sealed blob. Throws if the auth tag does not verify. */
export function open(token: string, from: string, to: string, mid: string, blob: string): string {
  const buf = Buffer.from(blob, 'base64url')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ct = buf.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(token), iv)
  decipher.setAAD(aad(from, to, mid))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

/** Authenticated ACK tag: HMAC(token, "cnack|"+mid). */
export function ackTag(token: string, mid: string): string {
  return crypto.createHmac('sha256', token).update(`cnack|${mid}`).digest('base64url')
}

function ackValid(token: string, mid: string, tag: string): boolean {
  const want = Buffer.from(ackTag(token, mid))
  const got = Buffer.from(String(tag))
  return want.length === got.length && crypto.timingSafeEqual(want, got)
}

/** Split a base64url blob into TXT records carrying [headerJSON, chunk]. */
export function frame(from: string, to: string, mid: string, blob: string) {
  const chunks: string[] = []
  for (let i = 0; i < blob.length; i += CHUNK) chunks.push(blob.slice(i, i + CHUNK))
  if (chunks.length === 0) chunks.push('')
  const n = chunks.length
  return chunks.map((chunk, i) => ({
    name: MSG_NAME,
    type: 'TXT' as const,
    ttl: 1,
    data: [JSON.stringify({ to, from, mid, i, n } satisfies MsgHeader), chunk],
  }))
}

/** TXT record data comes back from dns-packet as Buffers; normalise to string. */
function txtString(v: unknown): string {
  if (Buffer.isBuffer(v)) return v.toString('utf8')
  return typeof v === 'string' ? v : ''
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export function startMcast(deps: McastDeps): McastTransport {
  const selfId = deps.identity.peer_id
  // Bind to 0.0.0.0 so the socket actually receives multicast (binding to a
  // specific unicast address silently drops group traffic on macOS); the LAN
  // interface is still used for group membership + egress, and every inbound
  // packet is subnet-gated below, so confinement to the local link is intact.
  const m = mdns({
    interface: deps.iface.address,
    bind: '0.0.0.0',
    reuseAddr: true,
    loopback: true,
  })

  // Reassembly buffers for inbound multi-chunk messages, keyed by msg_id.
  const partials = new Map<string, { n: number; parts: Map<number, string>; from: string; to: string }>()
  // Pending outbound sends awaiting an ACK, keyed by msg_id.
  const waiters = new Map<string, () => void>()

  m.on('warning', () => {}) // non-fatal socket hiccups; the HTTP path is primary
  m.on('error', () => {})

  m.on('response', (pkt, rinfo) => {
    // Same isolation gate as the HTTP transport: ignore anything off-subnet.
    const src = normalizeIp(rinfo.address || '')
    if (!onSubnet(src, deps.iface)) return

    for (const ans of pkt.answers ?? []) {
      if (ans.type !== 'TXT') continue
      const data = Array.isArray(ans.data) ? ans.data : [ans.data]

      if (ans.name === MSG_NAME) {
        handleMsgRecord(txtString(data[0]), txtString(data[1]))
      } else if (ans.name === ACK_NAME) {
        handleAckRecord(txtString(data[0]))
      }
    }
  })

  function handleMsgRecord(headerStr: string, chunk: string) {
    let h: MsgHeader
    try {
      h = JSON.parse(headerStr)
    } catch {
      return
    }
    if (!h || h.to !== selfId || h.from === selfId) return // not for us, or our own loopback
    if (typeof h.n !== 'number' || h.n < 1 || typeof h.i !== 'number' || h.i < 0 || h.i >= h.n) return
    const token = deps.peerToken(h.from)
    if (!token) return // not paired with this sender — drop silently

    let slot = partials.get(h.mid)
    if (!slot) {
      slot = { n: h.n, parts: new Map(), from: h.from, to: h.to }
      // Bound memory: evict the oldest partial if we are tracking too many.
      if (partials.size >= MAX_PARTIALS) {
        const oldest = partials.keys().next().value
        if (oldest) partials.delete(oldest)
      }
      partials.set(h.mid, slot)
    }
    slot.parts.set(h.i, chunk)
    if (slot.parts.size < slot.n) return // still waiting on chunks

    partials.delete(h.mid)
    let text: string
    try {
      const blob = Array.from({ length: slot.n }, (_, i) => slot!.parts.get(i) ?? '').join('')
      text = open(token, h.from, h.to, h.mid, blob)
    } catch {
      return // bad auth tag / corrupt: drop, do not ACK
    }

    const result = deps.accept(h.from, text, h.mid)
    if (result === 'rejected') return
    // ACK both fresh and duplicate deliveries so the sender's retry resolves.
    sendAck(h.from, h.mid, token)
  }

  function handleAckRecord(payload: string) {
    let a: { to?: string; from?: string; mid?: string; tag?: string }
    try {
      a = JSON.parse(payload)
    } catch {
      return
    }
    if (!a || a.to !== selfId || a.from === selfId || !a.mid || !a.tag) return
    const token = deps.peerToken(a.from!)
    if (!token || !ackValid(token, a.mid, a.tag)) return
    const resolve = waiters.get(a.mid)
    if (resolve) resolve()
  }

  function sendAck(toId: string, mid: string, token: string) {
    m.respond({
      answers: [
        {
          name: ACK_NAME,
          type: 'TXT',
          ttl: 1,
          data: [JSON.stringify({ to: toId, from: selfId, mid, tag: ackTag(token, mid) })],
        },
      ],
    })
  }

  function send(toId: string, token: string, text: string, msgId: string): Promise<boolean> {
    const blob = seal(token, selfId, toId, msgId, text)
    const answers = frame(selfId, toId, msgId, blob)

    return new Promise<boolean>((resolve) => {
      let done = false
      const finish = (ok: boolean) => {
        if (done) return
        done = true
        waiters.delete(msgId)
        clearTimeout(resend)
        clearTimeout(timeout)
        resolve(ok)
      }
      waiters.set(msgId, () => finish(true))

      // Fire all chunks now, then once more after a beat — UDP multicast has no
      // retransmission of its own, so a single dropped chunk would stall forever.
      for (const a of answers) m.respond({ answers: [a] })
      const resend = setTimeout(() => {
        if (!done) for (const a of answers) m.respond({ answers: [a] })
      }, RESEND_AFTER_MS)
      const timeout = setTimeout(() => finish(false), ACK_TIMEOUT_MS)
    })
  }

  return {
    send,
    stop() {
      try {
        m.destroy()
      } catch {
        /* best effort */
      }
    },
  }
}
