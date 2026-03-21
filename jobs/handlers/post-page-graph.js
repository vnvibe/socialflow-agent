const axios = require('axios')
const { getSignedUrlForDownload } = require('../../lib/r2')
const { delay } = require('../../browser/human')

async function postPageGraphHandler(payload, supabase) {
  const { content_id, target_id, account_id } = payload

  // Fetch content + media + page
  const [{ data: content }, { data: page }, { data: account }] = await Promise.all([
    supabase.from('contents').select('*, media(*)').eq('id', content_id).single(),
    supabase.from('fanpages').select('id, fb_page_id, name, access_token').eq('id', target_id).single(),
    supabase.from('accounts').select('id, name').eq('id', account_id).single()
  ])

  if (!content) throw new Error('Content not found')
  if (!page) throw new Error('Page not found')
  if (!page.access_token) throw new Error('Page access_token missing')

  const message = buildMessage(content)
  const pageId = page.fb_page_id
  const token = page.access_token

  let fbPostId = null

  // If has media, upload photo/video
  if (content.media) {
    const mediaUrl = await signedOrDirectUrl(content.media)
    if (!mediaUrl) throw new Error('Media URL missing')

    if (content.media.type === 'video') {
      fbPostId = await uploadVideo(pageId, token, mediaUrl, message)
    } else {
      fbPostId = await uploadPhoto(pageId, token, mediaUrl, message)
    }
  } else {
    fbPostId = await createFeedPost(pageId, token, message, content.link_url)
  }

  // Save publish_history
  await supabase.from('publish_history').insert({
    job_id: payload.job_id,
    content_id,
    account_id,
    target_type: 'page',
    target_fb_id: pageId,
    target_name: page.name,
    final_caption: message,
    fb_post_id: fbPostId,
    post_url: fbPostId ? `https://www.facebook.com/${fbPostId}` : null,
    status: 'success'
  })

  return { success: true, page_name: page.name, fb_post_id: fbPostId }
}

function buildMessage(content) {
  let msg = content.caption || ''
  if (content.hashtags?.length) {
    const tags = content.hashtags.map(t => (t.startsWith('#') ? t : `#${t}`)).join(' ')
    msg = msg ? `${msg}\n\n${tags}` : tags
  }
  return msg
}

async function signedOrDirectUrl(media) {
  const path = media.processed_path || media.original_path
  if (!path) return null
  try {
    const signed = await getSignedUrlForDownload(path)
    return signed || media.source_url || path
  } catch {
    return media.source_url || path
  }
}

async function createFeedPost(pageId, token, message, link) {
  const params = new URLSearchParams()
  if (message) params.append('message', message)
  if (link) params.append('link', link)
  params.append('access_token', token)

  const { data } = await axios.post(`https://graph.facebook.com/v18.0/${pageId}/feed`, params)
  return data.id
}

async function uploadPhoto(pageId, token, url, caption) {
  const params = new URLSearchParams()
  params.append('url', url)
  if (caption) params.append('caption', caption)
  params.append('access_token', token)

  const { data } = await axios.post(`https://graph.facebook.com/v18.0/${pageId}/photos`, params)
  return data.id
}

async function uploadVideo(pageId, token, fileUrl, description) {
  const params = new URLSearchParams()
  params.append('file_url', fileUrl)
  if (description) params.append('description', description)
  params.append('access_token', token)

  const { data } = await axios.post(`https://graph.facebook.com/v18.0/${pageId}/videos`, params)
  return data.id
}

module.exports = postPageGraphHandler
