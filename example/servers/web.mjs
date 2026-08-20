import { createServer } from "node:http"

const port = Number(process.env.PORT)
// Wired by the config: http://localhost:${port:api} — the *public* port
// procdeck assigned to `api`, with the HTTP observer in front of it.
const apiUrl = process.env.API_URL

const page = (api) => `<!doctype html>
<meta charset="utf-8">
<title>procdeck demo shop</title>
<style>
  body { font: 15px/1.5 system-ui; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
  pre, #chat { background: #f4f4f4; padding: .6rem .8rem; border-radius: 6px; overflow-x: auto; }
  #chat { min-height: 6rem; }
  button { margin-right: .5rem; }
  small { color: #666; }
</style>
<h1>procdeck demo shop</h1>
<p>My port (assigned by procdeck): <b>${port}</b></p>
<p>Server-side call to the api (via <code>\${port:api}</code>): <code>${api}</code></p>

<h2>Call the api from the browser</h2>
<p><small>Requests go to <code>api.localhost</code> — watch them land with
<code>procdeck http api</code>. The broken order feeds
<code>procdeck http --digest</code>.</small></p>
<button onclick="call('GET','/products')">load products</button>
<button onclick="call('POST','/orders',{productId:1,qty:2})">place an order</button>
<button onclick="call('POST','/orders',{productId:999,qty:0})">place a broken order</button>
<button onclick="call('GET','/products/13')">the cursed product</button>
<pre id="out">…</pre>

<h2>Chat over WebSocket</h2>
<p><small>Connected to <code>chat.localhost</code> — watch the messages with
<code>procdeck http --ws --body</code>.</small></p>
<div id="chat"></div>
<input id="say" placeholder="type and hit Enter">

<script>
  // web.localhost:4830 → api.localhost:4830 / chat.localhost:4830 — every
  // pane is a sibling subdomain on the UI port. Open this page through
  // http://web.localhost:4830 for the buttons and the chat to work.
  const sibling = (id) =>
    location.hostname.endsWith(".localhost")
      ? id + "." + location.hostname.split(".").slice(1).join(".") + ":" + location.port
      : null

  const out = document.getElementById("out")
  const call = async (method, path, body) => {
    const host = sibling("api")
    if (host === null) return (out.textContent = "open me via http://web.localhost:4830 first")
    const response = await fetch("http://" + host + path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    out.textContent = method + " " + path + " → " + response.status + "\\n" + (await response.text())
  }

  const chat = document.getElementById("chat")
  const say = document.getElementById("say")
  const chatHost = sibling("chat")
  if (chatHost !== null) {
    const socket = new WebSocket("ws://" + chatHost)
    const line = (text) => {
      chat.textContent += text + "\\n"
      chat.scrollTop = chat.scrollHeight
    }
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      line("[" + message.from + "] " + message.text)
    }
    socket.onclose = () => line("(chat closed — is the chat pane running?)")
    say.onkeydown = (event) => {
      if (event.key !== "Enter" || say.value === "") return
      socket.send(say.value)
      say.value = ""
    }
  } else {
    chat.textContent = "open me via http://web.localhost:4830 to join the chat"
  }
</script>`

createServer(async (req, res) => {
  console.log(`${req.method} ${req.url}`)
  let api = "api is unreachable"
  try {
    api = await (await fetch(`${apiUrl}/products/1`)).text()
  } catch {
    // Shown as-is below.
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
  res.end(page(api))
}).listen(port, () => console.log(`web listening on :${port}, api at ${apiUrl}`))
