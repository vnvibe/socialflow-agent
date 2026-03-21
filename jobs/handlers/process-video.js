const { processVideo } = require('../../video/processor')

async function processVideoHandler(payload, supabase) {
  const { media_id, action, config, url } = payload

  if (action === 'download') {
    const axios = require('axios')
    const fs = require('fs')
    const path = require('path')
    const { uploadToR2 } = require('../../lib/r2')

    const { data: media } = await supabase.from('media').select('*').eq('id', media_id).single()
    if (!media) throw new Error('Media not found')

    const localPath = path.join(require('os').tmpdir(), `${media_id}_download.mp4`)

    const response = await axios({
      method: 'GET',
      url: url || media.source_url,
      responseType: 'stream',
      timeout: 120000
    })

    const writer = fs.createWriteStream(localPath)
    response.data.pipe(writer)

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve)
      writer.on('error', reject)
    })

    const stat = fs.statSync(localPath)
    const r2Key = `videos/original/${media.owner_id}/${media_id}.mp4`
    await uploadToR2(localPath, r2Key)

    await supabase.from('media').update({
      original_path: r2Key,
      file_size_bytes: stat.size,
      processing_status: 'raw'
    }).eq('id', media_id)

    fs.unlinkSync(localPath)
    return { r2Key, size: stat.size }
  }

  if (action === 'process') {
    return await processVideo(media_id, config, supabase)
  }

  throw new Error(`Unknown action: ${action}`)
}

module.exports = processVideoHandler
