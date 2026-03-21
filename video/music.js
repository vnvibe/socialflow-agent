const ffmpeg = require('fluent-ffmpeg')

async function mixMusic(videoPath, musicPath, outputPath, volume = 0.3) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(musicPath)
      .complexFilter([
        `[1:a]volume=${volume}[music]`,
        `[0:a][music]amix=inputs=2:duration=first[aout]`
      ])
      .outputOptions(['-map', '0:v', '-map', '[aout]', '-shortest', '-movflags', '+faststart'])
      .output(outputPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .on('end', resolve)
      .on('error', reject)
      .run()
  })
}

module.exports = { mixMusic }
