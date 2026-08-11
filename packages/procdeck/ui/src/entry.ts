import { Runtime } from "foldkit"
import { Model } from "./model.ts"
import { init, update } from "./update.ts"
import { subscriptions } from "./subscription.ts"
import { view } from "./view.ts"
import "@xterm/xterm/css/xterm.css"
import "./styles.css"

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  subscriptions,
  container: document.getElementById("root"),
})

Runtime.run(application)
