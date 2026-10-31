/**
 * Rasterizes the icon SVGs into the app icon assets.
 * Uses Electron itself as the renderer, so no native image tooling is needed.
 *
 *   npm run build:icons
 *
 * Outputs resources/icon.png (1024) and, on macOS, resources/icon.icns.
 *
 * Two source SVGs are used: the detailed mark for 128px and up, and a
 * simplified one for 16-64px where fine detail would smear into a blob.
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const outDir = path.join(root, 'resources')
const iconsetDir = path.join(outDir, 'icon.iconset')
const detailedSvg = path.join(root, 'src/renderer/public/icon.svg')
const smallSvg = path.join(outDir, 'icon-small.svg')

const BASE = 1024
/** Sizes at or below this use the simplified artwork. */
const SMALL_MAX = 64

// Sizes required to assemble a macOS .icns via iconutil.
const ICONSET_NAMES = {
  16: ['icon_16x16.png'],
  32: ['icon_16x16@2x.png', 'icon_32x32.png'],
  64: ['icon_32x32@2x.png'],
  128: ['icon_128x128.png'],
  256: ['icon_128x128@2x.png', 'icon_256x256.png'],
  512: ['icon_256x256@2x.png', 'icon_512x512.png'],
  1024: ['icon_512x512@2x.png']
}

function createRenderWindow() {
  return new BrowserWindow({
    width: BASE,
    height: BASE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true }
  })
}

/**
 * Render one SVG at full size into the given window.
 * The window is reused across calls on purpose: creating a second offscreen
 * window after destroying the first makes loadFile fail with ERR_FAILED.
 */
async function renderSvg(win, svgFile, tag) {
  const svg = fs.readFileSync(svgFile, 'utf8')
  const tmpFile = path.join(app.getPath('temp'), `aws-console-hub-icon-${tag}.html`)
  // Written to a temp file rather than a data: URL, which fails on long SVGs.
  fs.writeFileSync(
    tmpFile,
    `<!doctype html><meta charset="utf-8">
     <style>html,body{margin:0;background:transparent}svg{display:block;width:${BASE}px;height:${BASE}px}</style>
     ${svg}`
  )
  try {
    await win.loadFile(tmpFile)
    const image = await win.webContents.capturePage()
    if (image.isEmpty()) throw new Error(`rendered ${tag} icon is empty`)
    return image
  } finally {
    fs.rmSync(tmpFile, { force: true })
  }
}

app.whenReady().then(async () => {
  const win = createRenderWindow()
  try {
    fs.mkdirSync(iconsetDir, { recursive: true })

    const detailed = await renderSvg(win, detailedSvg, 'detailed')
    const small = await renderSvg(win, smallSvg, 'small')

    // On a Retina display capturePage returns 2x pixels, so always resize to an
    // exact target rather than writing the captured bitmap directly.
    const at = (image, n) => image.resize({ width: n, height: n, quality: 'best' }).toPNG()

    fs.writeFileSync(path.join(outDir, 'icon.png'), at(detailed, BASE))
    console.log(`wrote resources/icon.png (${BASE}x${BASE})`)

    for (const [size, names] of Object.entries(ICONSET_NAMES)) {
      const n = Number(size)
      const png = at(n <= SMALL_MAX ? small : detailed, n)
      for (const name of names) fs.writeFileSync(path.join(iconsetDir, name), png)
    }
    console.log('wrote resources/icon.iconset')

    if (process.platform === 'darwin') {
      execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', path.join(outDir, 'icon.icns')])
      console.log('wrote resources/icon.icns')
    }
  } catch (err) {
    console.error(err)
    process.exitCode = 1
  } finally {
    win.destroy()
    app.quit()
  }
})
