/**
 * Dev-only: give the app its real name in the macOS Dock and menu bar.
 *
 *   node scripts/dev-app-name.js      (run automatically by `npm run dev`)
 *
 * In development the process runs inside node_modules' stock Electron.app, and
 * macOS takes the Dock tooltip / menu bar title from that bundle's Info.plist —
 * neither `productName` in package.json nor `app.setName()` can override it, so
 * it otherwise reads "Electron". Patching the local bundle is the only fix that
 * works without packaging. Idempotent, and safe to re-run after a reinstall.
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

if (process.platform !== 'darwin') process.exit(0)

const root = path.join(__dirname, '..')
const { productName, name } = require(path.join(root, 'package.json'))
const appName = productName || name
const bundle = path.join(root, 'node_modules/electron/dist/Electron.app')
const plist = path.join(bundle, 'Contents/Info.plist')

if (!fs.existsSync(plist)) {
  console.warn('dev-app-name: no local Electron bundle, skipping')
  process.exit(0)
}

const plistBuddy = (command) =>
  execFileSync('/usr/libexec/PlistBuddy', ['-c', command, plist], { encoding: 'utf8' }).trim()

/** Set the key, adding it first if the stock plist does not carry it. */
function setString(key, value) {
  try {
    plistBuddy(`Set :${key} ${value}`)
  } catch {
    plistBuddy(`Add :${key} string ${value}`)
  }
}

if (plistBuddy('Print :CFBundleName') === appName) process.exit(0)

setString('CFBundleName', appName)
setString('CFBundleDisplayName', appName)
// LaunchServices caches the old name against the bundle's mtime.
fs.utimesSync(bundle, new Date(), new Date())
console.log(`dev-app-name: Electron.app now shows as "${appName}"`)
