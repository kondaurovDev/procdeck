import { readFileSync } from "node:fs"
import * as path from "node:path"

/**
 * Lives at the top of src/ on purpose: `../package.json` resolves from here
 * in dev (node runs the .ts files directly) *and* from the flat dist/ bundle
 * — both sit one level under the package root.
 */
export const VERSION = (
  JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")) as {
    version: string
  }
).version
