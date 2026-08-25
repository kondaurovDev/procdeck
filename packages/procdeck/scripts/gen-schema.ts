import { writeFile } from "node:fs/promises"
import * as path from "node:path"
import { Schema } from "effect"
import { ProcdeckConfigSchema } from "../src/config.ts"

/**
 * Generates the JSON Schema that `procdeck.config.json` files point at, from
 * the Effect schema that actually validates them. Generated at build time and
 * shipped in the package, so the two formats can never disagree — and so the
 * `description` annotations in `src/config.ts` become editor tooltips.
 *
 * Note that the cross-field rules (`shell` xor `cmd`, `needs` targets,
 * dependency cycles, `${port:id}` references) are filters that JSON Schema
 * cannot express: editors won't flag them, the loader still rejects them.
 */
const { schema, definitions } = Schema.toJsonSchemaDocument(ProcdeckConfigSchema)

const document = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://unpkg.com/procdeck/schema.json",
  title: "procdeck config",
  ...schema,
  ...(Object.keys(definitions).length > 0 ? { $defs: definitions } : {})
}

const out = path.join(import.meta.dirname, "..", "schema.json")
await writeFile(out, `${JSON.stringify(document, null, 2)}\n`)
console.log(`schema.json → ${out}`)
