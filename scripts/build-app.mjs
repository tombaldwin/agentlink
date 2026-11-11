#!/usr/bin/env node
// Builds nattermatic.app for macOS: nattermatic as a single executable (Node's single-executable
// feature, on the official Node.js binary), in an app bundle signed with hardened runtime.
//
// Why an app: macOS asks before a program may reach other machines on the local network, and a
// background `node` started at login is blocked without being asked. As a signed app, nattermatic
// gets its own prompt ("Allow nattermatic to find devices on local networks?"), and the permission
// covers nattermatic only, not every program run by node.
//
//   npm run build:app                                    this Mac's architecture
//   npm run build:app -- --arch x64                      the other one (runs under Rosetta to build)
//   npm run build:app -- --sign "Developer ID Application: …" --notarize <keychain profile>
//
// --sign defaults to the first "Developer ID Application" identity in the keychain, else the first
// "Apple Development" one (fine for your own Macs; others need Developer ID and notarization).
// --notarize takes a profile saved with `xcrun notarytool store-credentials`.
// Output: dist/nattermatic-<version>-macos-<arch>.zip (and .sha256), with the app in dist/<arch>/.
//
// The icon is edited in Icon Composer (assets/app-icon/nattermatic.icon). Its compiled forms are committed,
// so building needs no particular Xcode; after changing it, rebuild them with:
//   xcrun actool assets/app-icon/nattermatic.icon --compile assets/app-icon --app-icon nattermatic \
//     --include-all-app-icons --platform macosx --target-device mac --minimum-deployment-target 13.5 \
//     --output-partial-info-plist /tmp/icon.plist
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

// The Node.js release the app is built on. Bump deliberately (the checksum is checked against
// nodejs.org's SHASUMS256.txt, and the binary must be signed by the Node.js project).
const NODE_VERSION = 'v24.22.2'
const NODE_TEAM = 'HX7739G8FX'      // the Node.js project's Apple Developer team
// Permanent: macOS keys the Local Network permission (and the keychain) to it.
const BUNDLE_ID = 'io.github.tombaldwin.nattermatic'
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

const args = process.argv.slice(2)
const opt = (/** @type {string} */ name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined }
const arch = opt('arch') || process.arch
if (!['arm64', 'x64'].includes(arch)) throw new Error(`--arch must be arm64 or x64, not ${arch}`)
if (process.platform !== 'darwin') throw new Error('the app is built on macOS')

const run = (/** @type {string} */ cmd, /** @type {string[]} */ a, quiet = false) =>
  execFileSync(cmd, a, { encoding: 'utf8', stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'] })
const step = (/** @type {string} */ m) => console.log(`• ${m}`)
const sha256 = (/** @type {string | Buffer} */ x) => crypto.createHash('sha256').update(x).digest('hex')

const DIST = path.join(ROOT, 'dist')
const CACHE = path.join(DIST, 'cache')
const WORK = path.join(DIST, `build-${arch}`)
fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(WORK, { recursive: true })
fs.mkdirSync(CACHE, { recursive: true })

// ---- 1. the official Node.js binary, checksum-verified and signed by the Node.js project ----
const nodeName = `node-${NODE_VERSION}-darwin-${arch}`
const tarball = path.join(CACHE, `${nodeName}.tar.gz`)
const sums = await (await fetch(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`)).text()
const want = sums.split('\n').map(l => l.trim().split(/\s+/)).find(([, f]) => f === `${nodeName}.tar.gz`)?.[0]
if (!want) throw new Error(`no checksum for ${nodeName} on nodejs.org`)
if (!fs.existsSync(tarball) || sha256(fs.readFileSync(tarball)) !== want) {
  step(`downloading ${nodeName}`)
  const res = await fetch(`https://nodejs.org/dist/${NODE_VERSION}/${nodeName}.tar.gz`)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  fs.writeFileSync(tarball, Buffer.from(await res.arrayBuffer()))
}
if (sha256(fs.readFileSync(tarball)) !== want) throw new Error(`${nodeName}.tar.gz failed its checksum`)
run('tar', ['xzf', tarball, '-C', WORK, `${nodeName}/bin/node`, `${nodeName}/LICENSE`])
const nodeBin = path.join(WORK, nodeName, 'bin', 'node')
// codesign -dv reports on stderr
const teamId = (run('sh', ['-c', 'codesign -dv "$1" 2>&1', 'sh', nodeBin], true).match(/TeamIdentifier=(\S+)/) || [])[1] || ''
if (teamId !== NODE_TEAM) throw new Error(`${nodeName} is not signed by the Node.js project (team ${teamId || 'none'})`)
step(`Node.js ${NODE_VERSION} (${arch}) verified`)

// ---- 2. what the executable carries: the bundled program, install.sh, and the npm package ----
// The npm package is what this machine hands to machines that join through one of its invites.
step('packing the npm package')
const tgzName = run('npm', ['pack', '--silent', '--pack-destination', WORK], true).trim().split('\n').pop() || ''
fs.renameSync(path.join(WORK, tgzName), path.join(WORK, 'nattermatic.tgz'))

step('bundling')
const esbuild = await import('esbuild')
const mainJs = path.join(WORK, 'nattermatic.cjs')
const { metafile } = await esbuild.build({
  metafile: true,
  entryPoints: [path.join(ROOT, 'bin', 'natter.js')],
  bundle: true, platform: 'node', format: 'cjs', target: 'node24', outfile: mainJs,
  // import.meta is only used when running from an npm install (src/self.js), never in the executable
  logOverride: { 'empty-import-meta': 'silent' },
  legalComments: 'none',
})
// the shebang line has no meaning inside the executable
fs.writeFileSync(mainJs, fs.readFileSync(mainJs, 'utf8').replace(/^#!.*\n/, ''))

const blob = path.join(WORK, 'sea.blob')
fs.writeFileSync(path.join(WORK, 'sea-config.json'), JSON.stringify({
  main: mainJs, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false,
  assets: { 'install.sh': path.join(ROOT, 'install.sh'), 'nattermatic.tgz': path.join(WORK, 'nattermatic.tgz') },
}))
// the blob must be made by the same Node binary it goes into (x64 runs under Rosetta)
run(nodeBin, ['--experimental-sea-config', path.join(WORK, 'sea-config.json')], true)

// ---- 3. the app bundle ----
const appDir = path.join(DIST, arch, 'nattermatic.app')
fs.rmSync(path.dirname(appDir), { recursive: true, force: true })
fs.mkdirSync(path.join(appDir, 'Contents', 'MacOS'), { recursive: true })
const exe = path.join(appDir, 'Contents', 'MacOS', 'nattermatic')
fs.copyFileSync(nodeBin, exe)
fs.chmodSync(exe, 0o755)
run('codesign', ['--remove-signature', exe])
step('injecting the program into the executable')
run(process.execPath, [path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'), exe, 'NODE_SEA_BLOB', blob,
  '--sentinel-fuse', SEA_FUSE, '--macho-segment-name', 'NODE_SEA'], true)

// the licences of everything the executable carries, which they require us to pass on
const licenceOf = (/** @type {string} */ dir) => {
  const f = fs.readdirSync(dir).find(n => /^licen[cs]e/i.test(n))
  if (!f) throw new Error(`no licence file in ${dir}: add its notice to the app by hand`)
  return fs.readFileSync(path.join(dir, f), 'utf8').trim()
}
const packages = [...new Set(Object.keys(metafile.inputs).map(f => f.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//)?.[1]).filter(d => d !== undefined))].sort()
const line = '-'.repeat(72)
const resources = path.join(appDir, 'Contents', 'Resources')
fs.mkdirSync(resources)
for (const f of ['Assets.car', 'nattermatic.icns']) fs.copyFileSync(path.join(ROOT, 'assets', 'app-icon', f), path.join(resources, f))
fs.writeFileSync(path.join(appDir, 'Contents', 'Resources', 'THIRD_PARTY_NOTICES.txt'), [
  `nattermatic ${PKG.version}\n\n${licenceOf(ROOT)}`,
  `Node.js ${NODE_VERSION}\n\n${fs.readFileSync(path.join(WORK, nodeName, 'LICENSE'), 'utf8').trim()}`,
  ...packages.map(d => {
    const p = JSON.parse(fs.readFileSync(path.join(ROOT, d, 'package.json'), 'utf8'))
    return `${p.name} ${p.version}\n\n${licenceOf(path.join(ROOT, d))}`
  }),
].join(`\n\n${line}\n\n`) + '\n')
step(`licence notices for Node.js and ${packages.length} packages`)

const esc = (/** @type {string} */ s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const plist = (/** @type {Record<string, string | boolean>} */ d) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
${Object.entries(d).map(([k, v]) => `  <key>${k}</key>${typeof v === 'boolean' ? (v ? '<true/>' : '<false/>') : `<string>${esc(v)}</string>`}`).join('\n')}
</dict></plist>
`
fs.writeFileSync(path.join(appDir, 'Contents', 'Info.plist'), plist({
  CFBundleIdentifier: BUNDLE_ID,
  CFBundleName: 'nattermatic',
  CFBundleDisplayName: 'nattermatic',
  CFBundleExecutable: 'nattermatic',
  CFBundleIconFile: 'nattermatic',           // nattermatic.icns, for macOS before Liquid Glass
  CFBundleIconName: 'nattermatic',           // in Assets.car, the layered icon
  CFBundlePackageType: 'APPL',
  CFBundleShortVersionString: PKG.version,
  CFBundleVersion: PKG.version,
  CFBundleInfoDictionaryVersion: '6.0',
  LSMinimumSystemVersion: '13.5',          // Node.js 24's minimum
  LSUIElement: true,                       // no Dock icon or menu bar: it's a background tool
  NSLocalNetworkUsageDescription: 'nattermatic connects to your other machines on this network so the AI agents on them can message each other.',
}))

// ---- 4. sign (hardened runtime; V8 needs JIT and writable-executable memory) ----
const identity = opt('sign') || (() => {
  const ids = run('security', ['find-identity', '-v', '-p', 'codesigning'], true)
  return (ids.match(/"(Developer ID Application: [^"]+)"/) || ids.match(/"(Apple Development: [^"]+)"/) || [])[1]
})()
if (!identity) throw new Error('no signing identity: pass --sign "<identity>" (see `security find-identity -v -p codesigning`)')
const ent = path.join(WORK, 'entitlements.plist')
fs.writeFileSync(ent, plist({ 'com.apple.security.cs.allow-jit': true, 'com.apple.security.cs.allow-unsigned-executable-memory': true }))
step(`signing as ${identity}`)
run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--entitlements', ent, '--sign', identity, appDir], true)
run('codesign', ['--verify', '--strict', '--verbose=2', appDir], true)

// it runs, and carries its files
const version = run(exe, ['--version'], true).trim()
if (version !== PKG.version) throw new Error(`the built app reports version ${version}, expected ${PKG.version}`)
const check = run(exe, ['mcp', '--check'], true).trim()
if (check !== 'ok') throw new Error(`the built app's adapter check failed: ${check}`)

// ---- 5. notarize and staple (Developer ID only), then the release zip ----
const zip = path.join(DIST, `nattermatic-${PKG.version}-macos-${arch}.zip`)
const ditto = () => { fs.rmSync(zip, { force: true }); run('ditto', ['-c', '-k', '--keepParent', appDir, zip]) }
ditto()
const profile = opt('notarize')
if (profile) {
  if (!identity.startsWith('Developer ID Application')) throw new Error('notarizing needs a Developer ID Application identity')
  step('notarizing (this takes a few minutes)')
  execFileSync('xcrun', ['notarytool', 'submit', zip, '--keychain-profile', profile, '--wait'], { stdio: 'inherit' })
  run('xcrun', ['stapler', 'staple', appDir])
  ditto()                                  // the zip people download carries the stapled ticket
  run('sh', ['-c', 'spctl --assess --type execute --verbose "$1" 2>&1', 'sh', appDir])
}
const digest = sha256(fs.readFileSync(zip))
fs.writeFileSync(`${zip}.sha256`, `${digest}  ${path.basename(zip)}\n`)
console.log(`\n${path.relative(ROOT, zip)}\n  sha256 ${digest}\n  signed by ${identity}${profile ? ', notarized' : ' (not notarized: runs on your own Macs only)'}`)
