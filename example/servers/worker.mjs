// A background worker buying things from the api on a timer — pure
// server-to-server traffic, no browser anywhere. It flows through the api's
// public assigned port (`${port:api}`), where procdeck's HTTP observer
// captures it: `procdeck http api` shows these requests landing on the api,
// statuses and bodies included — the part DevTools can never see.
//
// Every third order is broken on purpose, so `procdeck http --digest` always
// has a 422 group to show, and `procdeck errors api` stays interesting.

const apiUrl = process.env.API_URL
let cycle = 0

const order = async () => {
  cycle += 1
  const products = await (await fetch(`${apiUrl}/products`)).json()
  const sabotage = cycle % 3 === 0
  const pick = products[cycle % products.length]
  const payload = sabotage
    ? { productId: 999, qty: 0 } // no such product, no such quantity
    : { productId: pick.id, qty: 1 + (cycle % 2) }
  const response = await fetch(`${apiUrl}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
  const label = sabotage ? "broken-on-purpose order" : `order for ${pick.name}`
  console.log(`${label} → ${response.status} ${await response.text()}`)
}

console.log(`worker up, buying from ${apiUrl} every 5s`)
setInterval(() => order().catch((cause) => console.error(`api unreachable: ${cause}`)), 5000)
