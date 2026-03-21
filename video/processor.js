const ffmpeg = require('fluent-ffmpeg')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { uploadToR2, downloadFromR2 } = require('../lib/r2')

async function processVideo(mediaId, config, supabase) {
  const { data: media } = await supabase.from('media').select('*').eq('id', mediaId).single()
  if (!media) throw new Error('Media not found')

  const inputPath = path.join(os.tmpdir(), `${mediaId}_input${path.extname(media.original_path)}`)
  await downloadFromR2(media.original_path, inputPath)

  const outputPath = path.join(os.tmpdir(), `${mediaId}_final.mp4`)
  await buildFFmpegCommand(inputPath, outputPath, config || {}, media)

  const r2Path = `videos/processed/${media.owner_id}/${mediaId}_final.mp4`
  await uploadToR2(outputPath, r2Path)

  await supabase.from('media').update({
    processed_path: r2Path,
    processing_status: 'done',
    processing_config: config
  }).eq('id', mediaId)

  try { fs.unlinkSync(inputPath) } catch {}
  try { fs.unlinkSync(outputPath) } catch {}

  return { r2Path }
}

async function buildFFmpegCommand(input, output, config, media) {
  return new Promise((resolve, reject) => {
    let cmd = ffmpeg(input)
    const filters = []

    // Subtitle
    if (config.subtitle?.enabled && media.subtitle_path) {
      const style = config.subtitle.style || {}
      const srtEscaped = media.subtitle_path.replace(/:/g, '\\:').replace(/\\/g, '/')
      filters.push(`subtitles=${srtEscaped}:force_style='FontSize=${style.size || 20},PrimaryColour=&H00FFFFFF'`)
    }

    // Watermark text
    if (config.watermark?.text) {
      const pos = config.watermark.position || 'bottomRight'
      const x = pos.includes('Right') ? 'W-tw-20' : '20'
      const y = pos.includes('bottom') ? 'H-th-20' : '20'
      filters.push(`drawtext=text='${config.watermark.text}':x=${x}:y=${y}:fontsize=22:fontcolor=white@${config.watermark.opacity || 0.8}`)
    }

    if (filters.length > 0) cmd = cmd.videoFilters(filters)

    // Music overlay
    if (config.music_path) {
      cmd = cmd.input(config.music_path)
      cmd = cmd.complexFilter([`[0:a][1:a]amix=inputs=2:weights=1 ${config.music_volume || 0.3}[aout]`])
      cmd = cmd.outputOptions(['-map', '0:v', '-map', '[aout]'])
    }

    cmd
      .output(output)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions(['-shortest', '-movflags', '+faststart'])
      .on('end', resolve)
      .on('error', reject)
      .on('progress', (progress) => {
        if (progress.percent) console.log(`[VIDEO] Processing: ${Math.round(progress.percent)}%`)
      })
      .run()
  })
}

async function checkFFmpeg() {
  return new Promise((resolve, reject) => {
    ffmpeg.getAvailableCodecs((err) => {
      if (err) reject(new Error('FFmpeg not found. Install FFmpeg first.'))
      else resolve()
    })
  })
}

module.exports = { processVideo, checkFFmpeg, buildFFmpegCommand }
