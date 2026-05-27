// mDNS / DNS-SD discovery. Advertises this session on the local link and
// browses for others. mDNS multicast is link-local by construction, so the
// set of peers we can ever discover is exactly the local network — this is the
// first and most important layer of "isolation to the local network".
import { Bonjour } from 'bonjour-service'
import type { Config, Identity, RosterEntry } from './state'
import { normalizeIp, sanitize } from './state'

// Advertised as _claudenet._tcp.local
const SERVICE_TYPE = 'claudenet'

export interface Discovery {
  stop(): void
}

export function startDiscovery(opts: {
  config: Config
  identity: Identity
  peerPort: number
  onUp: (entry: RosterEntry) => void
  onDown: (match: { peer_id?: string; mdnsName: string }) => void
}): Discovery {
  const { config, identity, peerPort } = opts
  const bonjour = new Bonjour()

  // The instance name is cosmetic (what shows up in `dns-sd -B`); the peer_id
  // in TXT is the real identity. Keep them distinct.
  bonjour.publish({
    name: `${config.name} [${identity.peer_id.slice(0, 8)}]`,
    type: SERVICE_TYPE,
    port: peerPort,
    txt: {
      id: identity.peer_id,
      name: config.name,
      project: config.project,
    },
  })

  const browser = bonjour.find({ type: SERVICE_TYPE })

  browser.on('up', (svc) => {
    const id = svc.txt?.id
    if (!id || id === identity.peer_id) return // ignore self and malformed ads
    // Prefer the address the announcement actually arrived from; fall back to
    // an advertised A record. We never trust a hostname we'd have to resolve.
    const addr =
      svc.referer?.address ||
      (svc.addresses ?? []).find((a) => a.includes('.')) ||
      ''
    if (!addr) return
    opts.onUp({
      peer_id: id,
      display_name: sanitize(svc.txt?.name || svc.name, 60),
      project: sanitize(svc.txt?.project || '', 60),
      addr: normalizeIp(addr),
      port: svc.port,
      discovered_at: new Date().toISOString(),
    })
  })

  browser.on('down', (svc) => {
    opts.onDown({ peer_id: svc.txt?.id, mdnsName: svc.name })
  })

  return {
    stop() {
      try {
        browser.stop()
      } catch {
        /* best effort */
      }
      try {
        bonjour.unpublishAll(() => bonjour.destroy())
      } catch {
        /* best effort */
      }
    },
  }
}
