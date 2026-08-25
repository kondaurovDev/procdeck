import { createServer } from "node:http"

// The procdeck contract: the port to bind arrives as $PORT. With the HTTP
// observer on (the default), this is a *hidden internal* port — the world
// reaches the api through the public assigned one, and every request that
// does is captured for `procdeck http`.
const port = Number(process.env.PORT)

const products = [
  { id: 1, name: "Keyboard", price: 90 },
  { id: 2, name: "Mouse", price: 35 },
  { id: 3, name: "Monitor", price: 240 }
]
let nextOrder = 1

const json = (res, status, body) => {
  res.writeHead(status, {
    "content-type": "application/json",
    // The web pane calls this api straight from the browser (through the
    // api.localhost proxy address) — hence CORS.
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type"
  })
  res.end(JSON.stringify(body))
}

createServer((req, res) => {
  console.log(`${req.method} ${req.url}`)
  if (req.method === "OPTIONS") return json(res, 204, {})

  const { pathname } = new URL(req.url, "http://localhost")

  if (req.method === "GET" && pathname === "/products") return json(res, 200, products)

  const one = /^\/products\/(\d+)$/.exec(pathname)
  if (req.method === "GET" && one !== null) {
    const id = Number(one[1])
    if (id === 13) {
      // A deliberate crash route: `procdeck http --status 5xx` finds it.
      console.error(`Error: product ${id} is cursed, refusing to look it up`)
      return json(res, 500, { error: "unlucky id" })
    }
    const product = products.find((candidate) => candidate.id === id)
    return product === undefined
      ? json(res, 404, { error: `no product ${id}` })
      : json(res, 200, product)
  }

  if (req.method === "POST" && pathname === "/orders") {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      let order
      try {
        order = JSON.parse(body)
      } catch {
        return json(res, 400, { error: "body must be JSON" })
      }
      const product = products.find((candidate) => candidate.id === order.productId)
      if (product === undefined || !(order.qty > 0)) {
        // Validation failures group nicely in `procdeck http --digest`.
        return json(res, 422, { error: "need a known productId and a positive qty", got: order })
      }
      return json(res, 201, {
        orderId: nextOrder++,
        product: product.name,
        total: product.price * order.qty
      })
    })
    return
  }

  json(res, 404, { error: `no route for ${req.method} ${pathname}` })
}).listen(port, () => console.log(`api listening on :${port}`))
