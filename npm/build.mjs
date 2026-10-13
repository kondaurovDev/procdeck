// Assembles the npm packages of a release from GoReleaser's output:
//
//   node npm/build.mjs <version> <goreleaser dist dir>
//
// writes npm/dist/@procdeck/<os>-<arch> (one binary each) and npm/dist/procdeck
// (the launcher, depending on all four as optional dependencies), and prints
// the package directories in publish order — platforms first, so the
// launcher never points at a version that is not there yet.

import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as path from "node:path"

const [version, dist] = process.argv.slice(2)
if (version === undefined || dist === undefined) {
  console.error("usage: node npm/build.mjs <version> <goreleaser dist dir>")
  process.exit(1)
}

const repo = path.join(import.meta.dirname, "..")
const out = path.join(import.meta.dirname, "dist")
rmSync(out, { recursive: true, force: true })

const template = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "procdeck", "package.json"), "utf8")
)
/** Go's names for an architecture → npm's (`cpu` in package.json). */
const cpus = { amd64: "x64", arm64: "arm64" }

const artifacts = JSON.parse(readFileSync(path.join(dist, "artifacts.json"), "utf8"))
const binaries = artifacts.filter((artifact) => artifact.type === "Binary")
if (binaries.length === 0) {
  console.error(`no binaries in ${dist}/artifacts.json`)
  process.exit(1)
}

const written = []
const optional = {}
for (const binary of binaries) {
  const cpu = cpus[binary.goarch]
  if (cpu === undefined) throw new Error(`no npm cpu for GOARCH ${binary.goarch}`)
  const name = `@procdeck/${binary.goos}-${cpu}`
  const dir = path.join(out, name)
  mkdirSync(path.join(dir, "bin"), { recursive: true })
  const target = path.join(dir, "bin", "procdeck")
  copyFileSync(path.join(repo, binary.path), target)
  chmodSync(target, 0o755)
  copyFileSync(path.join(repo, "license"), path.join(dir, "license"))
  writeFileSync(
    path.join(dir, "readme.md"),
    `# ${name}\n\nThe procdeck binary for ${binary.goos} on ${cpu}. Install [procdeck](https://www.npmjs.com/package/procdeck) instead — it picks this package for you.\n`
  )
  writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify(
      {
        name,
        version,
        description: `The procdeck binary for ${binary.goos}-${cpu}.`,
        license: template.license,
        repository: template.repository,
        os: [binary.goos],
        cpu: [cpu],
        files: ["bin"],
        // Yarn PnP: a binary must live on disk, not in a zip.
        preferUnplugged: true
      },
      null,
      2
    )}\n`
  )
  optional[name] = version
  written.push(dir)
}

const launcher = path.join(out, "procdeck")
mkdirSync(path.join(launcher, "bin"), { recursive: true })
copyFileSync(
  path.join(import.meta.dirname, "procdeck", "bin", "procdeck.js"),
  path.join(launcher, "bin", "procdeck.js")
)
chmodSync(path.join(launcher, "bin", "procdeck.js"), 0o755)
copyFileSync(
  path.join(import.meta.dirname, "procdeck", "CHANGELOG.md"),
  path.join(launcher, "CHANGELOG.md")
)
for (const file of ["readme.md", "license", "schema.json"]) {
  copyFileSync(path.join(repo, file), path.join(launcher, file))
}
const { private: _private, ...published } = template
writeFileSync(
  path.join(launcher, "package.json"),
  `${JSON.stringify({ ...published, version, optionalDependencies: optional }, null, 2)}\n`
)
written.push(launcher)

console.log(written.join("\n"))
