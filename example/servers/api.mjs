import { createServer } from "node:http"

// The procdeck contract: the assigned port arrives as $PORT.
const port = Number(process.env.PORT)

createServer((req, res) => {
  console.log(`${req.method} ${req.url}`)
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify({ service: "api", port, time: new Date().toISOString() }))
}).listen(port, () => console.log(`api listening on :${port}`))
