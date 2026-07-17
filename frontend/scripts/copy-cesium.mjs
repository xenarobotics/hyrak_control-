/**
 * Copy CesiumJS static assets to public/cesium
 * Run via: node scripts/copy-cesium.mjs
 */
import { cpSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const cesiumPkg = dirname(require.resolve('cesium/package.json'))
const cesiumBuild = join(cesiumPkg, 'Build', 'Cesium')
const dest = join(dirname(import.meta.url.replace('file:///', '')), '..', 'public', 'cesium')

const folders = ['Workers', 'ThirdParty', 'Assets', 'Widgets']

mkdirSync(dest, { recursive: true })

for (const folder of folders) {
  const src = join(cesiumBuild, folder)
  const target = join(dest, folder)
  if (existsSync(src)) {
    mkdirSync(target, { recursive: true })
    cpSync(src, target, { recursive: true })
    console.log(`✓ Copied ${folder}`)
  } else {
    console.warn(`⚠ ${src} not found, skipping`)
  }
}

// Copy main Cesium.js bundle for script-tag loading
const cesiumJs = join(cesiumBuild, 'Cesium.js')
if (existsSync(cesiumJs)) {
  cpSync(cesiumJs, join(dest, 'Cesium.js'))
  console.log('✓ Copied Cesium.js')
}

console.log('Done copying Cesium assets to public/cesium/')
