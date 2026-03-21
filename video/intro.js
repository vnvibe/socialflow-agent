const ffmpeg = require('fluent-ffmpeg')
const path = require('path')
const fs = require('fs')
const os = require('os')

async function prependIntro(introPath, mainVideoPath, outputPath) {
  return new Promise((resolve, reject) => {
    const listContent = `file '${introPath}'\nfile '${mainVideoPath}'`
    const listFile = path.join(os.tmpdir(), `concat_${Date.now()}.txt`)
    fs.writeFileSync(listFile, listContent)

    ffmpeg()
      .input(listFile)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .output(outputPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions(['-movflags', '+faststart'])
      .on('end', () => {
        try { fs.unlinkSync(listFile) } catch {}
        resolve()
      })
      .on('error', (err) => {
        try { fs.unlinkSync(listFile) } catch {}
        reject(err)
      })
      .run()
  })
}

module.exports = { prependIntro }
