# claude-net

A **Claude Code channel** that lets Claude sessions message each other **on the
same local network**. User A's Claude asks a question; User B's Claude answers
from *its* repo and replies — escalating to its human only when it must. No
cloud, no relay; LAN isolation is structural, not a toggle you can forget.

> You're deep in a task and have a question for a teammate across the room.
> Instead of interrupting them, your Claude asks *their* Claude.

## How it works

Each session runs this MCP server as a subprocess of Claude Code — a **two-way
channel**: inbound peer messages arrive as `<channel>` events, and Claude
replies with the `send_message` tool.

- **Discovery** — mDNS/DNS-SD (`_claudenet._tcp.local`). Multicast is
  link-local, so the peers you can ever see *are* your local network.
- **Transport** — direct peer-to-peer HTTP, bound to one LAN interface;
  connections off that interface's subnet are refused.
- **Trust** — a peer is untrusted until your human approves a short pairing
  code; after that, every message carries a per-pair secret token.

A message surfaces to the receiving Claude as:

```
<channel source="claude-net" kind="message" peer_name="user-a" project="checkout-api">
how does the gateway pick which upstream to route to?
</channel>
```

## Install

Requires [Bun](https://bun.sh). Clone the repo, install deps, and register the
channel **once** at user scope — then Claude Code spawns it for you in every
project (no manual server, no per-project `.mcp.json`):

```bash
bun install
claude mcp add claude-net --scope user -- "$(which bun)" "$(pwd)/src/claude-net.ts"
```

This writes an absolute-path entry to `~/.claude.json`, so it resolves from any
directory — `claude mcp get claude-net` reports *"available in all your
projects."* (Add `-e CLAUDE_NET_NAME=you` to set the name peers see; it defaults
to your OS username.)

Channels aren't on the research-preview allowlist yet, so each session still
needs one flag. Alias it so you never type it again — add to `~/.zshrc`:

```bash
alias claude-net='claude --dangerously-load-development-channels server:claude-net'
```

Now **`claude-net` in any project** launches Claude with the channel live — you
never run `bun` yourself.

> One channel session per machine at a time: sessions share the `~/.claude-net`
> identity, so two at once advertise the same peer. Need several? Give each its
> own `CLAUDE_NET_HOME` (the demo does).

## Try it locally

No second machine handy? Run two peers on this one — no Claude required:

```bash
bun run demo    # two local peers; open the two inbox URLs it prints
bun run test    # e2e + MCP handshake + emit checks
```

Open both inbox dashboards, **Connect** on one, **Approve** on the other, and
exchange messages to watch the pairing and transport mechanics.

## A typical exchange

With the channel live (run `claude-net`, per **Install**):

1. **User A:** "Ask the gateway team how their service picks an upstream." →
   A's Claude runs `list_peers` → `connect_peer <user-b>` → `send_message`.
2. **User B** approves the pairing once (`approve_peer <code>`).
3. **User B's Claude** answers from its own repo and replies — without
   interrupting User B unless the question needs them.
4. **User A's Claude** relays the answer back.

Notes:

- The `--dangerously-load-development-channels` flag is **hidden from
  `claude --help`** but works (verified on 2.1.152). *"Blocked by org policy"*
  means the `channelsEnabled` admin policy is off.
- **Receiving needs an *interactive* session.** `claude -p` / stream-json loads
  the channel and exposes the tools but doesn't deliver async inbound pushes.
- Each machine installs once (per **Install**) — there's no shared server.

## Inbox UI

Each channel serves a **loopback-only** dashboard (default
`http://127.0.0.1:7333`, URL printed to stderr at startup): discovered/paired
peers, pending requests (approve/deny), a live log, and a test-message injector.
Never reachable from the LAN.

## Configuration

All optional — set via `-e KEY=val` on `claude mcp add`, an `.mcp.json` `env`
block, or your shell:

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_NET_NAME` | host name | Display name shown to peers |
| `CLAUDE_NET_PROJECT` | cwd basename | Project label shown to peers |
| `CLAUDE_NET_HOME` | `~/.claude-net` | State dir (identity + paired peers) |
| `CLAUDE_NET_IFACE` | auto (`en*`, skips VPN) | LAN interface to bind/confine to |
| `CLAUDE_NET_PORT` | ephemeral | Peer HTTP port (advertised via mDNS) |
| `CLAUDE_NET_UI_PORT` | `7333` | Inbox UI port (loopback) |

## Security model

Three layers keep the channel local and authenticated:

1. **Link-local discovery** — mDNS multicast can't cross the local link.
2. **Subnet gate** — the peer server binds one interface and drops any
   connection whose source IP isn't on that subnet, *before reading the body*.
   Interface-based, not RFC-1918, so VPN/`utun` peers are off-subnet and refused.
3. **Pairing + per-peer tokens** — content flows only after a human approves a
   code; every `/msg` needs a paired `from_id` *and* its secret token. The
   identity Claude sees comes from *your* paired record, never the payload;
   untrusted strings are control-stripped and length-clamped.

**Known gaps (research-preview demo, not hardened):**

- **No transport encryption** — plaintext HTTP on the LAN; a sniffer can read
  tokens/messages. Add TLS/Noise for a hostile LAN.
- **No revocation/rotation** — un-pair by deleting the peer from
  `~/.claude-net/peers.json`. A duplicate pair request from a known id is
  refused (`409`), never re-sending the token.
- **Pairing requests are shown before trust** — the (sanitized) requester
  name/project are attacker-controllable; approval is the gate, so verify it's a
  real teammate first.

**Non-goals:** remote tool approval / permission relay, attachments, group
rooms, and any cloud/relay component.
