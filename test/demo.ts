#!/usr/bin/env bun
// Browser demo: launch two claude-net peers on this machine and print their
// inbox URLs. Open both, watch them discover each other, pair (Connect on one,
// Approve on the other), and exchange messages — all without Claude, just to
// see the channel mechanics. Ctrl-C to stop. For the real thing (two Claude
// sessions), see the README.
import { rmSync } from 'node:fs'

const ROOT = '/tmp/claude-net-demo'

function launch(name: string, uiPort: number) {
  const home = `${ROOT}/${name}`
  rmSync(home, { recursive: true, force: true })
  return Bun.spawn({
    cmd: ['bun', 'src/claude-net.ts'],
    env: {
      ...process.env,
      CLAUDE_NET_HOME: home,
      CLAUDE_NET_NAME: name,
      CLAUDE_NET_PROJECT: `${name}-service`,
      CLAUDE_NET_UI_PORT: String(uiPort),
    },
    stdin: 'pipe', // keep open so the process stays alive
    stdout: 'ignore', // would otherwise be MCP JSON-RPC for a client that isn't here
    stderr: 'inherit', // show each peer's boot banner
  })
}

const a = launch('user-a', 7501)
const b = launch('user-b', 7502)

await Bun.sleep(1500)
console.log(`
  claude-net demo — two peers on this machine
  ───────────────────────────────────────────
  user-a  inbox →  http://127.0.0.1:7501
  user-b  inbox →  http://127.0.0.1:7502

  1. open both URLs in two browser tabs
  2. on user-a's tab, click "Connect" next to user-b
  3. on user-b's tab, "Approve" the pending request
  4. send messages either way and watch the logs
  5. use the "Inject" box to simulate an inbound message

  Ctrl-C to stop.
`)

const stop = () => {
  a.kill()
  b.kill()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
await Promise.all([a.exited, b.exited])
