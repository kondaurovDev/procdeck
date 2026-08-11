import { createServer } from "node:http"

const port = Number(process.env.PORT)
// Wired by the config: http://localhost:${port:api} — procdeck substituted
// the port it assigned to the `api` proc.
const apiUrl = process.env.API_URL

createServer(async (req, res) => {
  console.log(`${req.method} ${req.url}`)
  let api = "api is unreachable"
  try {
    api = await (await fetch(apiUrl)).text()
  } catch {
    // Shown as-is below.
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
  res.end(`<h1>web pane</h1>
<p>My port (assigned by procdeck): <b>${port}</b></p>
<p>The api pane (found via \${port:api}): <code>${api}</code></p>`)
}).listen(port, () => console.log(`web listening on :${port}, api at ${apiUrl}`))
