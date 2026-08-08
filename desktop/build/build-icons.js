// Second half of `npm run icons` (the first half, generate-icon.py, builds
// build/icon-master.png from the brand source art). This turns that master
// PNG into the three platform-specific formats electron-builder needs.
const iconGen = require('icon-gen')
const path = require('node:path')

const dir = __dirname

iconGen(path.join(dir, 'icon-master.png'), dir, {
    report: true,
    ico: { name: 'icon', sizes: [16, 24, 32, 48, 64, 128, 256] },
    icns: { name: 'icon', sizes: [16, 32, 64, 128, 256, 512, 1024] },
    favicon: false,
})
    .then((results) => {
        console.log('generated:', results)
        // electron-builder's linux target wants a plain PNG, not the icns/ico set.
        const sharp = require('node:child_process')
        const { execFileSync } = sharp
        execFileSync('python3', ['-c', `
from PIL import Image
Image.open("${path.join(dir, 'icon-master.png')}").resize((512, 512)).save("${path.join(dir, 'icon.png')}")
`])
        console.log('generated:', path.join(dir, 'icon.png'))
    })
    .catch((err) => {
        console.error('icon generation failed:', err)
        process.exit(1)
    })
