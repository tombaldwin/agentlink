// How agentlink runs itself and finds the files it ships with. Two forms:
// - an npm install: `node bin/agentlink.js`, with the package directory beside it;
// - a single executable (the macOS app): Node's single-executable feature, where the executable is
//   the whole program and the files it ships with (install.sh, the npm package it hands to
//   machines that join through it) are embedded in it.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sea from 'node:sea'

/** Running as a single executable? */
export const SEA = (() => { try { return sea.isSea() } catch { return false } })()

// A single executable can't be given Node's --no-warnings flag; node:sqlite's experimental warning
// would otherwise be printed on every command.
if (SEA) process.removeAllListeners('warning')

/** The package directory (npm installs only). */
export const PKG_ROOT = SEA ? '' : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** The program's entry point: bin/agentlink.js, or the executable itself. */
export const BIN = SEA ? process.execPath : path.join(PKG_ROOT, 'bin', 'agentlink.js')

/**
 * A file agentlink ships with (install.sh, the npm package). For an npm install, `name` is
 * relative to the package directory; a single executable has it embedded under the same name.
 * @param {string} name @returns {Buffer}
 */
export function readAsset(name) {
  return SEA ? Buffer.from(sea.getAsset(name)) : fs.readFileSync(path.join(PKG_ROOT, name))
}
