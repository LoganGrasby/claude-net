// Minimal ambient types for `multicast-dns` (no @types package is installed;
// it ships only as a transitive dep of bonjour-service). We only declare the
// slice of the API claude-net actually uses for the multicast message transport.
declare module 'multicast-dns' {
  import type { EventEmitter } from 'node:events'

  /** A TXT resource record. `data` is a string/Buffer or an array thereof; on
   * decode, dns-packet hands TXT `data` back as an array of Buffers. */
  export interface TxtRecord {
    name: string
    type: 'TXT'
    ttl?: number
    data: Array<string | Buffer> | string | Buffer
  }

  export interface Packet {
    type?: 'query' | 'response'
    answers?: TxtRecord[]
    questions?: unknown[]
  }

  export interface RemoteInfo {
    address: string
    port: number
    family?: string
    size?: number
  }

  export interface MulticastDNS extends EventEmitter {
    respond(
      res: { answers: TxtRecord[] } | TxtRecord[],
      rinfo?: unknown,
      cb?: (err?: Error | null) => void,
    ): void
    send(value: unknown, rinfo?: unknown, cb?: (err?: Error | null) => void): void
    destroy(cb?: () => void): void
    on(
      event: 'response' | 'query' | 'packet',
      listener: (packet: Packet, rinfo: RemoteInfo) => void,
    ): this
    on(event: 'ready', listener: () => void): this
    on(event: 'error' | 'warning', listener: (err: Error) => void): this
  }

  export interface Options {
    port?: number
    type?: 'udp4' | 'udp6'
    ip?: string
    interface?: string
    bind?: string | false
    multicast?: boolean
    ttl?: number
    loopback?: boolean
    reuseAddr?: boolean
  }

  export default function mdns(opts?: Options): MulticastDNS
}
