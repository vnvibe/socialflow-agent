const fs = require('fs')
const ffmpeg = require('fluent-ffmpeg')

async function extractAndTranscribe(videoPath, settings) {
  const audioPath = videoPath.replace(/\.[^.]+$/, '_audio.mp3')
  await extractAudio(videoPath, audioPath)

  const groqConfig = settings?.providers?.groq
  if (!groqConfig?.api_key) throw new Error('Groq API key required for Whisper transcription')

  const OpenAI = require('openai')
  const client = new OpenAI({
    apiKey: groqConfig.api_key,
    baseURL: 'https://api.groq.com/openai/v1'
  })

  const audioBuffer = fs.readFileSync(audioPath)
  const { File } = await import('node:buffer')
  const audioFile = new File([audioBuffer], 'audio.mp3', { type: 'audio/mpeg' })

  const transcript = await client.audio.transcriptions.create({
    file: audioFile,
    model: 'whisper-large-v3',
    language: settings?.language || 'vi',
    response_format: 'verbose_json',
    timestamp_granularities: ['segment']
  })

  const srtContent = transcriptToSRT(transcript.segments || [])
  const srtPath = videoPath.replace(/\.[^.]+$/, '.srt')
  fs.writeFileSync(srtPath, srtContent, 'utf-8')

  try { fs.unlinkSync(audioPath) } catch {}

  return {
    srtPath,
    text: transcript.text,
    language: transcript.language,
    segments: transcript.segments
  }
}

function transcriptToSRT(segments) {
  return segments.map((seg, i) => {
    return `${i + 1}\n${formatTime(seg.start)} --> ${formatTime(seg.end)}\n${seg.text.trim()}\n`
  }).join('\n')
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.round((seconds % 1) * 1000)
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`
}

function pad(n, len = 2) { return String(n).padStart(len, '0') }

async function extractAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .output(audioPath)
      .audioCodec('libmp3lame')
      .noVideo()
      .on('end', resolve)
      .on('error', reject)
      .run()
  })
}

module.exports = { extractAndTranscribe, transcriptToSRT }
