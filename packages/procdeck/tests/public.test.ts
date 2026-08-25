import { expectTypeOf, test } from "vitest"
import type { Alert, Preflight, ProcdeckConfig, ProcSpec } from "../src/public.ts"
import type {
  Alert as SchemaAlert,
  Preflight as SchemaPreflight,
  ProcdeckConfig as SchemaConfig,
  ProcSpec as SchemaProcSpec
} from "../src/config.ts"

/**
 * The hand-written public types must stay identical to the ones the Effect
 * schema derives. These assertions are checked by `tsc`, so a field added to
 * the schema and forgotten here fails the build rather than shipping a config
 * type that silently rejects valid decks.
 */
test("public types mirror the schema", () => {
  expectTypeOf<Preflight>().toEqualTypeOf<SchemaPreflight>()
  expectTypeOf<Alert>().toEqualTypeOf<SchemaAlert>()
  expectTypeOf<ProcSpec>().toEqualTypeOf<SchemaProcSpec>()
  expectTypeOf<ProcdeckConfig>().toEqualTypeOf<SchemaConfig>()
})
