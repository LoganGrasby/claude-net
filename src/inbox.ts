// Local inbox UI. Bound to 127.0.0.1 only: this is an operator dashboard for
// watching your own channel (roster, pairings, message log) and poking it
// during testing. It is NOT a peer endpoint and never accepts LAN traffic.
// Every action here calls the same hub operation the MCP tools call.
import type { LogEntry, PairedPeer, PendingIn, RosterEntry } from './state'

export interface UiSnapshot {
  me: { peer_id: string; name: string; project: string }
  iface: { name: string; address: string; netmask: string }
  peerPort: number
  roster: RosterEntry[]
  paired: PairedPeer[]
  pendingIn: PendingIn[]
  log: LogEntry[]
}

export interface UiHub {
  snapshot(): UiSnapshot
  subscribe(cb: () => void): () => void
  connectPeer(peerId: string): Promise<{ ok: boolean; message: string }>
  approve(code: string): Promise<{ ok: boolean; message: string }>
  deny(code: string): { ok: boolean; message: string }
  sendMessage(
    peerId: string,
    text: string,
  ): Promise<{ ok: boolean; message: string }>
  simulateInbound(text: string): void
}

export interface UiServer {
  port: number
  stop(): void
}

export function startInboxServer(uiPort: number, hub: UiHub): UiServer {
  const clients = new Set<ReadableStreamDefaultController>()
  const enc = new TextEncoder()

  const push = () => {
    const data = `data: ${JSON.stringify(hub.snapshot())}\n\n`
    for (const c of clients) {
      try {
        c.enqueue(enc.encode(data))
      } catch {
        clients.delete(c) // client gone
      }
    }
  }
  const unsubscribe = hub.subscribe(push)

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })

  const readBody = async (req: Request) => {
    try {
      return (await req.json()) as Record<string, string>
    } catch {
      return {}
    }
  }

  const fetch = async (req: Request): Promise<Response> => {
      const url = new URL(req.url)

      if (req.method === 'GET' && url.pathname === '/') {
        return new Response(PAGE, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }

      // One-shot snapshot (handy for scripts/tests and debugging).
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return json(hub.snapshot())
      }

      if (req.method === 'GET' && url.pathname === '/events') {
        let self: ReadableStreamDefaultController | null = null
        const remove = () => {
          if (self) {
            clients.delete(self)
            self = null
          }
        }
        const stream = new ReadableStream({
          start(ctrl) {
            self = ctrl
            clients.add(ctrl)
            ctrl.enqueue(enc.encode(`data: ${JSON.stringify(hub.snapshot())}\n\n`))
          },
          cancel: remove,
        })
        req.signal.addEventListener('abort', remove)
        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
        })
      }

      if (req.method === 'POST') {
        const b = await readBody(req)
        switch (url.pathname) {
          case '/api/connect':
            return json(await hub.connectPeer(b.peer_id ?? ''))
          case '/api/approve':
            return json(await hub.approve(b.code ?? ''))
          case '/api/deny':
            return json(hub.deny(b.code ?? ''))
          case '/api/send':
            return json(await hub.sendMessage(b.peer_id ?? '', b.text ?? ''))
          case '/api/simulate':
            hub.simulateInbound(b.text ?? '')
            return json({ ok: true, message: 'injected' })
        }
      }

      return new Response('not found', { status: 404 })
  }

  // Loopback only — never reachable from the LAN. Fall back to an ephemeral
  // port if the preferred one is taken (e.g. a second session on this machine).
  let server: ReturnType<typeof Bun.serve>
  // idleTimeout: 0 keeps the SSE stream open while the channel is quiet, so the
  // dashboard's "live" indicator doesn't flicker.
  try {
    server = Bun.serve({ hostname: '127.0.0.1', port: uiPort, idleTimeout: 0, fetch })
  } catch {
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch })
  }

  return {
    port: server.port!, // always defined for a TCP listener
    stop() {
      unsubscribe()
      for (const c of clients) {
        try {
          c.close()
        } catch {
          /* ignore */
        }
      }
      server.stop(true)
    },
  }
}

// --- the page: dependency-free, renders from the SSE snapshot --------------
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>claude-net inbox</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #0d1117; color: #e6edf3;
    font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  header {
    padding: 14px 20px; border-bottom: 1px solid #30363d;
    display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap;
  }
  header h1 { font-size: 15px; margin: 0; color: #58a6ff; letter-spacing: .04em; }
  header .meta { color: #8b949e; font-size: 12px; }
  header .dot { color: #3fb950; }
  main { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
  @media (max-width: 820px) { main { grid-template-columns: 1fr; } }
  section { padding: 16px 20px; border-bottom: 1px solid #30363d; border-right: 1px solid #30363d; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .12em; color: #8b949e; margin: 0 0 10px; }
  .card { border: 1px solid #30363d; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; background: #161b22; }
  .card .name { color: #e6edf3; font-weight: 600; }
  .card .sub { color: #8b949e; font-size: 12px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .grow { flex: 1; }
  .empty { color: #6e7681; font-style: italic; }
  button {
    font: inherit; cursor: pointer; border: 1px solid #30363d; background: #21262d;
    color: #e6edf3; border-radius: 6px; padding: 5px 10px;
  }
  button:hover { border-color: #8b949e; }
  button.primary { background: #238636; border-color: #2ea043; }
  button.warn { background: #6e2530; border-color: #b62324; }
  button.code { font-family: inherit; color: #d2a8ff; }
  input, textarea {
    font: inherit; background: #0d1117; color: #e6edf3; border: 1px solid #30363d;
    border-radius: 6px; padding: 6px 8px; width: 100%;
  }
  .pending { border-color: #bb8009; background: #2d2200; }
  .pending .tag { color: #e3b341; font-size: 11px; text-transform: uppercase; letter-spacing: .1em; }
  .log { grid-column: 1 / -1; border-right: none; }
  .log .lines { max-height: 320px; overflow-y: auto; display: flex; flex-direction: column-reverse; }
  .line { padding: 4px 0; border-bottom: 1px solid #1b2027; display: flex; gap: 10px; }
  .line .t { color: #6e7681; font-size: 12px; white-space: nowrap; }
  .line .badge { font-size: 11px; padding: 0 6px; border-radius: 4px; align-self: center; }
  .line.in  .badge { background: #1f6feb33; color: #79c0ff; }
  .line.out .badge { background: #23863633; color: #7ee787; }
  .line.sys .badge { background: #6e768133; color: #c9d1d9; }
  .line .txt { white-space: pre-wrap; word-break: break-word; }
  .line .who { color: #d2a8ff; }
  code { color: #ffa657; }
</style>
</head>
<body>
<header>
  <h1>claude-net</h1>
  <span class="meta" id="me"></span>
  <span class="meta" id="net"></span>
  <span class="meta dot" id="status">connecting…</span>
</header>
<main>
  <section>
    <h2>Discovered on the network</h2>
    <div id="roster"></div>
  </section>
  <section>
    <h2>Paired peers</h2>
    <div id="paired"></div>
  </section>
  <section style="grid-column: 1 / -1;">
    <h2>Pending pairing requests</h2>
    <div id="pending"></div>
  </section>
  <section class="log">
    <h2>Message log</h2>
    <div class="row" style="margin-bottom:10px;">
      <input id="simText" class="grow" placeholder="Simulate an inbound message to your Claude (test only)…" />
      <button onclick="simulate()">Inject</button>
    </div>
    <div class="lines" id="log"></div>
  </section>
</main>
<script>
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
));
async function post(path, body) {
  const r = await fetch(path, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
  return r.json();
}
function connect(id) { post('/api/connect', { peer_id: id }); }
function approve(code) { post('/api/approve', { code }); }
function deny(code) { post('/api/deny', { code }); }
function simulate() {
  const el = document.getElementById('simText');
  if (el.value.trim()) post('/api/simulate', { text: el.value });
  el.value = '';
}
function send(id) {
  const el = document.getElementById('send-' + id);
  if (el && el.value.trim()) { post('/api/send', { peer_id: id, text: el.value }); el.value = ''; }
}

function render(s) {
  document.getElementById('me').textContent =
    s.me.name + ' · ' + s.me.project + ' · ' + s.me.peer_id.slice(0, 8);
  document.getElementById('net').textContent =
    'iface ' + s.iface.name + ' ' + s.iface.address + ' · peer-port ' + s.peerPort;

  const paired = new Set(s.paired.map((p) => p.peer_id));
  document.getElementById('roster').innerHTML = s.roster.length ? s.roster.map((p) =>
    '<div class="card"><div class="row"><div class="grow"><div class="name">' + esc(p.display_name) +
    '</div><div class="sub">' + esc(p.project || 'no project') + ' · ' + esc(p.addr) + ':' + p.port + '</div></div>' +
    (paired.has(p.peer_id)
      ? '<span class="sub">paired ✓</span>'
      : '<button class="primary" onclick="connect(\\'' + esc(p.peer_id) + '\\')">Connect</button>') +
    '</div></div>'
  ).join('') : '<div class="empty">no sessions discovered yet…</div>';

  document.getElementById('paired').innerHTML = s.paired.length ? s.paired.map((p) =>
    '<div class="card"><div class="name">' + esc(p.display_name) +
    '</div><div class="sub">' + esc(p.project || 'no project') + ' · ' + esc(p.peer_id.slice(0,8)) + '</div>' +
    '<div class="row" style="margin-top:8px;"><input id="send-' + esc(p.peer_id) + '" class="grow" placeholder="message…" />' +
    '<button onclick="send(\\'' + esc(p.peer_id) + '\\')">Send</button></div></div>'
  ).join('') : '<div class="empty">no paired peers — connect to someone above</div>';

  document.getElementById('pending').innerHTML = s.pendingIn.length ? s.pendingIn.map((p) =>
    '<div class="card pending"><span class="tag">untrusted — verify before approving</span>' +
    '<div class="name">' + esc(p.display_name) + ' <code>' + esc(p.code) + '</code></div>' +
    '<div class="sub">claims project ' + esc(p.project || '—') + ' · from ' + esc(p.addr) + '</div>' +
    '<div class="row" style="margin-top:8px;"><button class="primary" onclick="approve(\\'' + esc(p.code) + '\\')">Approve</button>' +
    '<button class="warn" onclick="deny(\\'' + esc(p.code) + '\\')">Deny</button></div></div>'
  ).join('') : '<div class="empty">none</div>';

  document.getElementById('log').innerHTML = s.log.map((l) =>
    '<div class="line ' + esc(l.dir) + '"><span class="t">' + esc(new Date(l.t).toLocaleTimeString()) +
    '</span><span class="badge">' + esc(l.dir) + '</span><span class="txt">' +
    (l.peer ? '<span class="who">' + esc(l.peer) + '</span> ' : '') + esc(l.text) + '</span></div>'
  ).join('');
}

const ev = new EventSource('/events');
ev.onmessage = (e) => { render(JSON.parse(e.data)); document.getElementById('status').textContent = '● live'; };
ev.onerror = () => { document.getElementById('status').textContent = '○ disconnected'; };
</script>
</body>
</html>`
