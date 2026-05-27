// Peer-to-peer transport: a small HTTP server bound to the chosen LAN
// interface. There is no central hub — every session talks to every other
// directly. The first thing every request hits is the subnet gate, so an
// off-LAN connection is refused before its body is ever read.
import type { Config } from './state'
import { normalizeIp, onSubnet } from './state'

export interface InboundReply {
  status: number
  body: string
}

/** Semantic validation lives in the hub; transport only does I/O + the gate. */
export interface PeerInbound {
  handlePairRequest(body: unknown, srcIp: string): InboundReply
  handlePairAccept(body: unknown, srcIp: string): InboundReply
  handleMessage(body: unknown, srcIp: string): InboundReply
}

export interface PeerServer {
  port: number
  stop(): void
}

export function startPeerServer(config: Config, hub: PeerInbound): PeerServer {
  const reply = (r: InboundReply) => new Response(r.body, { status: r.status })

  const server = Bun.serve({
    hostname: config.iface.address, // bind to the LAN link, not 0.0.0.0
    port: config.peerPort, // 0 => OS picks an ephemeral port
    async fetch(req, srv) {
      const info = srv.requestIP(req)
      const srcIp = info ? normalizeIp(info.address) : ''

      // --- network isolation gate: nothing off-subnet gets past this line ---
      if (!onSubnet(srcIp, config.iface)) {
        return new Response('off-subnet', { status: 403 })
      }

      if (req.method !== 'POST') {
        return new Response('method not allowed', { status: 405 })
      }

      let body: unknown
      try {
        body = await req.json()
      } catch {
        return new Response('bad json', { status: 400 })
      }

      switch (new URL(req.url).pathname) {
        case '/pair':
          return reply(hub.handlePairRequest(body, srcIp))
        case '/pair/accept':
          return reply(hub.handlePairAccept(body, srcIp))
        case '/msg':
          return reply(hub.handleMessage(body, srcIp))
        default:
          return new Response('not found', { status: 404 })
      }
    },
  })

  return {
    port: server.port!, // always defined for a TCP listener
    stop: () => server.stop(true),
  }
}

/** Outbound JSON POST to a peer, with a short timeout so a dead peer can't hang us. */
export async function postJson(
  addr: string,
  port: number,
  pathname: string,
  body: unknown,
): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(`http://${addr}:${port}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  })
  // Drain the body so the socket can be reused/closed cleanly.
  await res.text().catch(() => '')
  return { ok: res.ok, status: res.status }
}
