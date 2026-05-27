// Shared types, configuration, persistence, and the network-isolation
// primitives (interface detection + subnet membership) for claude-net.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A resolved network interface we are confined to. */
export interface Iface {
  name: string
  address: string
  netmask: string
}

/** Stable identity for this session, persisted across restarts. */
export interface Identity {
  peer_id: string
  created: string
}

/** A peer we have completed the pairing handshake with. Persisted. */
export interface PairedPeer {
  peer_id: string
  display_name: string
  project: string
  token: string // shared secret established at pairing; gates every message
  addr?: string
  port?: number
  paired_at: string
  last_seen?: string
}

/** A peer seen via mDNS but not necessarily paired. In-memory only. */
export interface RosterEntry {
  peer_id: string
  display_name: string
  project: string
  addr: string
  port: number
  discovered_at: string
}

/** An inbound pairing request awaiting this user's approval. In-memory. */
export interface PendingIn {
  code: string // short human code shown for approval
  peer_id: string
  display_name: string
  project: string
  addr: string
  port: number
  nonce: string // echoed back on accept so the requester can match it
  at: string
}

/** Our outbound pairing request awaiting the other side's accept. In-memory. */
export interface PendingOut {
  nonce: string
  peer_id: string
  display_name: string
  addr: string
  port: number
  at: string
}

export interface LogEntry {
  t: string
  dir: 'in' | 'out' | 'sys'
  kind: string
  peer?: string
  text: string
}

export interface Config {
  name: string
  project: string
  home: string
  peerPort: number // 0 = ephemeral
  uiPort: number
  iface: Iface
}

// ---------------------------------------------------------------------------
// Config & identity
// ---------------------------------------------------------------------------

export function loadConfig(): Config {
  const home =
    process.env.CLAUDE_NET_HOME || path.join(os.homedir(), '.claude-net')
  fs.mkdirSync(home, { recursive: true })
  return {
    name: process.env.CLAUDE_NET_NAME || os.hostname().replace(/\.local$/i, ''), // fall back to the host name (sans mDNS .local)
    project: process.env.CLAUDE_NET_PROJECT || path.basename(process.cwd()),
    home,
    peerPort: Number(process.env.CLAUDE_NET_PORT || 0),
    uiPort: Number(process.env.CLAUDE_NET_UI_PORT || 7333),
    iface: detectIface(process.env.CLAUDE_NET_IFACE),
  }
}

export function loadIdentity(home: string): Identity {
  const file = path.join(home, 'identity.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    const id: Identity = {
      peer_id: crypto.randomUUID(),
      created: new Date().toISOString(),
    }
    fs.writeFileSync(file, JSON.stringify(id, null, 2))
    return id
  }
}

export function loadPeers(home: string): Map<string, PairedPeer> {
  const file = path.join(home, 'peers.json')
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<
      string,
      PairedPeer
    >
    return new Map(Object.entries(obj))
  } catch {
    return new Map()
  }
}

export function savePeers(home: string, peers: Map<string, PairedPeer>): void {
  const file = path.join(home, 'peers.json')
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(peers), null, 2))
  fs.renameSync(tmp, file) // atomic-ish replace
}

// ---------------------------------------------------------------------------
// Random ids
// ---------------------------------------------------------------------------

export function newToken(): string {
  return crypto.randomBytes(24).toString('base64url')
}

export function newNonce(): string {
  return crypto.randomBytes(12).toString('base64url')
}

// Five lowercase letters skipping 'l' — same alphabet Claude Code uses for
// permission ids, so a code never reads as a 1 or I when typed on a phone.
const CODE_ALPHABET = 'abcdefghijkmnopqrstuvwxyz'
export function newCode(): string {
  let s = ''
  for (let i = 0; i < 5; i++) {
    s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]
  }
  return s
}

// ---------------------------------------------------------------------------
// Network isolation: pick ONE interface, confine everything to its subnet.
// ---------------------------------------------------------------------------

// VPN / tunnel / virtual interfaces. Their addresses are often private too, so
// an RFC-1918 check alone would wrongly accept off-LAN peers routed over them.
// We exclude them by name and bind to a real link instead.
const TUNNEL_IFACE = /^(utun|tun|tap|ppp|ipsec|wg|gif|stf|bridge|llw|awdl|ham)/

export function detectIface(preferName?: string): Iface {
  const candidates: Iface[] = []
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      candidates.push({ name, address: a.address, netmask: a.netmask })
    }
  }
  if (candidates.length === 0) {
    throw new Error(
      'claude-net: no external IPv4 interface found — are you on a network?',
    )
  }
  if (preferName) {
    const m = candidates.find((c) => c.name === preferName)
    if (!m) {
      throw new Error(
        `claude-net: CLAUDE_NET_IFACE=${preferName} not found. ` +
          `Available: ${candidates.map((c) => c.name).join(', ')}`,
      )
    }
    return m
  }
  const real = candidates.filter((c) => !TUNNEL_IFACE.test(c.name))
  // Prefer en* (ethernet/wifi on macOS) over anything else.
  const en = real.find((c) => /^en/.test(c.name))
  return en ?? real[0] ?? candidates[0]
}

/** Normalise an IPv4-mapped IPv6 address (::ffff:1.2.3.4) down to dotted quad. */
export function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  return m ? m[1] : ip
}

function ipToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let acc = 0
  for (const p of parts) {
    const n = Number(p)
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    acc = (acc << 8) + n
  }
  return acc >>> 0
}

/**
 * True iff `ip` lives on the same IPv4 subnet as our bound interface. This is
 * the mechanical enforcement of "isolation to the local network": an inbound
 * connection from off-subnet (including a VPN peer) fails this check and is
 * dropped before any of its bytes reach Claude.
 */
export function onSubnet(ip: string, iface: Iface): boolean {
  const a = ipToInt(normalizeIp(ip))
  const base = ipToInt(iface.address)
  const mask = ipToInt(iface.netmask)
  if (a === null || base === null || mask === null) return false
  return (a & mask) === (base & mask)
}

/**
 * Drop control characters and clamp length on untrusted, human-facing strings
 * (peer names, projects) before they reach Claude's context or the UI. Done by
 * code point so the source file stays free of literal control bytes.
 */
export function sanitize(s: unknown, max = 200): string {
  let out = ''
  for (const ch of String(s ?? '')) {
    if (out.length >= max) break
    const code = ch.codePointAt(0) ?? 0
    out += code < 0x20 || code === 0x7f ? ' ' : ch
  }
  return out.trim()
}
