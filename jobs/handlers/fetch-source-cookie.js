/**
 * Fetch posts from monitored source using desktop FB + GraphQL intercept
 * Gives: post ID, author, time, content, real permalink URLs
 * Engagement not available from GraphQL group feed — use Apify for that
 * Uses session pool (single browser instance)
 */
const { getPage, releaseSession } = require('../../browser/session-pool')
const { delay, humanMouseMove } = require('../../browser/human')
const { checkAccountStatus, saveDebugScreenshot } = require('./post-utils')

async function fetchSourceCookieHandler(payload, supabase) {
  const { account_id, source_url, source_id, source_type, owner_id } = payload

  if (!account_id) throw new Error('account_id required')
  if (!source_url) throw new Error('source_url required')

  const { data: account } = await supabase.from('accounts').select('*, proxies(*)')
    .eq('id', account_id).single()
  if (!account) throw new Error('Account not found')

  let browserPage

  try {
    const session = await getPage(account)
    browserPage = session.page

    // Check checkpoint
    await browserPage.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await delay(2000, 3000)
    const status = await checkAccountStatus(browserPage, supabase, account_id)
    if (status.blocked) throw new Error(`Account blocked: ${status.detail}`)

    // Setup GraphQL interceptor
    const capturedPosts = []
    const graphqlHandler = async (response) => {
      try {
        const url = response.url()
        if (!url.includes('/api/graphql')) return
        if (response.status() !== 200) return
        const text = await response.text().catch(() => '')
        if (!text || text.length < 200) return
        const posts = extractPostsFromGraphQL(text)
        if (posts.length > 0) capturedPosts.push(...posts)
      } catch {}
    }
    browserPage.on('response', graphqlHandler)

    // Navigate to source
    console.log(`[FETCH-COOKIE] Navigating to ${source_url}`)
    await browserPage.goto(source_url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await delay(4000, 6000)

    if (browserPage.url().includes('/login') || browserPage.url().includes('/checkpoint')) {
      throw new Error('Redirected to login/checkpoint — cookie expired')
    }

    // Detect source name
    let detectedName = null
    try {
      detectedName = await browserPage.evaluate(() => {
        const h1 = document.querySelector('h1')
        return h1?.textContent?.trim() || document.title?.replace(/ \| Facebook$/, '').trim() || null
      })
    } catch {}

    const uniqueCount = () => new Set(capturedPosts.map(p => p.fb_post_id)).size
    console.log(`[FETCH-COOKIE] Source: ${detectedName || '?'}, GraphQL: ${uniqueCount()} unique`)

    // Switch to "Bài viết mới" sort
    try {
      const sortClicked = await browserPage.evaluate(() => {
        for (const span of document.querySelectorAll('span')) {
          const text = span.textContent?.trim()
          if (['Phù hợp nhất', 'Most relevant', 'Most Relevant'].includes(text)) {
            const btn = span.closest('[role="button"]') || span.closest('div[tabindex]') || span
            btn.click()
            return text
          }
        }
        return null
      })
      if (sortClicked) {
        console.log(`[FETCH-COOKIE] Clicked sort: "${sortClicked}"`)
        await delay(1500, 2500)
        const sorted = await browserPage.evaluate(() => {
          for (const el of document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"], [role="menu"] span, [role="dialog"] span')) {
            if (['Bài viết mới', 'New posts', 'Newest'].includes(el.textContent?.trim())) {
              el.click(); return el.textContent.trim()
            }
          }
          for (const span of document.querySelectorAll('div[style*="position"] span, div[role] span')) {
            if (['Bài viết mới', 'New posts', 'Newest'].includes(span.textContent?.trim())) {
              (span.closest('[role="button"]') || span.closest('[tabindex]') || span).click()
              return span.textContent.trim()
            }
          }
          return null
        })
        if (sorted) {
          console.log(`[FETCH-COOKIE] Switched to: "${sorted}"`)
          capturedPosts.length = 0
          await delay(4000, 6000)
        }
      }
    } catch {}

    // Scroll to trigger more GraphQL
    const TARGET = 10
    let noNew = 0, lastCount = uniqueCount()
    for (let i = 0; i < 15 && uniqueCount() < TARGET; i++) {
      await browserPage.evaluate(() => window.scrollBy(0, 500 + Math.floor(Math.random() * 400)))
      await delay(2500, 4000)
      if (Math.random() < 0.3) await humanMouseMove(browserPage)
      const cur = uniqueCount()
      if (cur > lastCount) {
        noNew = 0
        console.log(`[FETCH-COOKIE] Scroll ${i + 1}: ${cur} unique (+${cur - lastCount})`)
      } else {
        noNew++
        if (noNew >= 4) { console.log(`[FETCH-COOKIE] No new posts, stopping at ${cur}`); break }
      }
      lastCount = cur
    }

    await delay(2000, 3000)
    browserPage.removeListener('response', graphqlHandler)

    // Deduplicate
    const seen = new Set()
    let allPosts = []
    for (const p of capturedPosts) {
      if (!p.fb_post_id || seen.has(p.fb_post_id)) continue
      seen.add(p.fb_post_id)
      allPosts.push(p)
    }

    // DOM fallback
    if (allPosts.length < TARGET) {
      const domPosts = await extractDesktopDOM(browserPage)
      for (const p of domPosts) {
        if (!seen.has(p.fb_post_id)) { seen.add(p.fb_post_id); allPosts.push(p) }
      }
    }

    // Decode base64 IDs and build URLs
    const groupIdMatch = browserPage.url().match(/groups\/([^/?]+)/)
    const groupId = groupIdMatch ? groupIdMatch[1] : null
    for (const post of allPosts) {
      if (post.fb_post_id?.startsWith('UzpfS')) {
        try {
          const decoded = Buffer.from(post.fb_post_id, 'base64').toString('utf8')
          const nums = decoded.match(/(\d{10,})/g)
          if (nums?.length > 0) {
            post.fb_post_id = nums[nums.length - 1]
            if (groupId) post.post_url = `https://www.facebook.com/groups/${groupId}/posts/${post.fb_post_id}/`
          }
        } catch {}
      }
      // Fix any post_url that doesn't contain /posts/ or /permalink/ (e.g. author profile URL)
      const hasValidUrl = post.post_url && (post.post_url.includes('/posts/') || post.post_url.includes('/permalink/'))
      if (!hasValidUrl) {
        if (groupId && /^\d{10,}$/.test(post.fb_post_id)) {
          post.post_url = `https://www.facebook.com/groups/${groupId}/posts/${post.fb_post_id}/`
        } else if (groupId) {
          post.post_url = `https://www.facebook.com/groups/${groupId}`
        }
      }
    }

    const topPosts = allPosts.slice(0, TARGET)
    for (const p of topPosts) {
      const urlOk = p.post_url?.includes('/posts/') || p.post_url?.includes('/permalink/') ? '✓' : '✗'
      console.log(`[FETCH-COOKIE] Post: ${p.author_name || '?'} — ID: ${p.fb_post_id?.substring(0, 18)} — URL:${urlOk} — ${p.content_text?.substring(0, 50)}...`)
    }

    if (source_id) {
      await supabase.from('monitored_sources').update({
        last_fetched_at: new Date().toISOString(),
        next_fetch_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }).eq('id', source_id)
    }

    const enriched = topPosts.map(p => ({
      ...p,
      source_id: source_id || null,
      source_name: detectedName || source_url,
      source_type: source_type || 'page',
    }))

    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000
    const recent = enriched.filter(p => !p.posted_at || new Date(p.posted_at).getTime() > oneDayAgo)

    console.log(`[FETCH-COOKIE] Final: ${recent.length} posts within 24h`)
    return { posts: recent, total: recent.length, source_name: detectedName }

  } catch (err) {
    console.error(`[FETCH-COOKIE] Error: ${err.message}`)
    if (browserPage) await saveDebugScreenshot(browserPage, `fetch-cookie-error-${account_id}`).catch(() => {})
    throw err
  } finally {
    await delay(3000, 5000)
    releaseSession(account_id)
  }
}

// ============================================
// GraphQL parsing
// ============================================

function extractPostsFromGraphQL(text) {
  const posts = []
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    try { findPosts(JSON.parse(line), posts) } catch {}
  }
  return posts
}

function findPosts(obj, posts, depth = 0) {
  if (!obj || depth > 15 || typeof obj !== 'object') return
  const post = tryExtractPost(obj)
  if (post) { posts.push(post); return }
  if (Array.isArray(obj)) { for (const item of obj) findPosts(item, posts, depth + 1) }
  else {
    const skip = new Set(['extensions', 'page_info', 'cursor', 'label', 'logging', 'all_subtext', 'page_insights'])
    for (const k of Object.keys(obj)) { if (!skip.has(k)) findPosts(obj[k], posts, depth + 1) }
  }
}

function deepFind(obj, key, maxDepth = 10) {
  if (!obj || maxDepth <= 0 || typeof obj !== 'object') return undefined
  if (obj[key] !== undefined) return obj[key]
  for (const k of Object.keys(obj)) {
    if (typeof obj[k] === 'object') { const f = deepFind(obj[k], key, maxDepth - 1); if (f !== undefined) return f }
  }
  return undefined
}

function tryExtractPost(obj) {
  if (!obj || typeof obj !== 'object') return null
  const msg = obj.message?.text || obj.story?.message?.text ||
    obj.node?.story?.message?.text || obj.node?.message?.text ||
    obj.comet_sections?.content?.story?.message?.text ||
    obj.node?.comet_sections?.content?.story?.message?.text ||
    obj.snippet?.text || (typeof obj.message === 'string' && obj.message.length > 10 ? obj.message : null)
  if (!msg || msg.length < 10) return null

  const id = obj.post_id || obj.story_id || obj.id || obj.legacy_story_id ||
    obj.node?.id || obj.story?.id || obj.node?.post_id || obj.node?.legacy_story_id || obj.story?.legacy_story_id
  if (!id) return null

  let authorName = null, authorId = null
  for (const a of [obj.author, obj.actor, obj.actors?.[0], obj.story?.actors?.[0], obj.node?.story?.actors?.[0],
    obj.comet_sections?.context_layout?.story?.comet_sections?.actor_photo?.story?.actors?.[0],
    obj.node?.comet_sections?.context_layout?.story?.comet_sections?.actor_photo?.story?.actors?.[0],
    obj.node?.comet_sections?.context_layout?.story?.actors?.[0]]) {
    if (a?.name) { authorName = a.name; authorId = a.id; break }
  }
  if (!authorName) { const a = deepFind(obj, 'actors'); if (Array.isArray(a) && a[0]?.name) { authorName = a[0].name; authorId = a[0].id } }
  if (!authorName) { const o = deepFind(obj, 'owner'); if (o?.name) { authorName = o.name; authorId = o.id } }

  let postedAt = null
  const ts = obj.created_time || obj.creation_time || obj.node?.created_time || obj.story?.creation_time || obj.node?.story?.creation_time || obj.node?.creation_time
  if (ts) postedAt = new Date((ts > 1e12 ? ts : ts * 1000)).toISOString()
  if (!postedAt) { const dt = deepFind(obj, 'creation_time', 6) || deepFind(obj, 'created_time', 6); if (dt && typeof dt === 'number') postedAt = new Date((dt > 1e12 ? dt : dt * 1000)).toISOString() }

  // Find post URL — must contain /posts/ or /permalink/, NOT author profile URL
  let postUrl = null
  const candidateUrls = [
    obj.url, obj.permalink_url, obj.story?.url, obj.node?.url, obj.node?.story?.url,
    obj.comet_sections?.context_layout?.story?.comet_sections?.metadata?.[0]?.story?.url,
    obj.node?.comet_sections?.context_layout?.story?.comet_sections?.metadata?.[0]?.story?.url
  ]
  for (const u of candidateUrls) {
    if (u && typeof u === 'string' && (u.includes('/posts/') || u.includes('/permalink/'))) {
      postUrl = u; break
    }
  }
  // Deep search fallback
  if (!postUrl) {
    const allUrls = []
    function collectUrls(o, d) {
      if (!o || d > 8 || typeof o !== 'object') return
      if (o.url && typeof o.url === 'string' && (o.url.includes('/posts/') || o.url.includes('/permalink/'))) {
        allUrls.push(o.url)
      }
      for (const k of Object.keys(o)) {
        if (typeof o[k] === 'object') collectUrls(o[k], d + 1)
      }
    }
    collectUrls(obj, 0)
    if (allUrls.length > 0) postUrl = allUrls[0]
  }
  // Final fallback: build from group + post_id
  if (!postUrl) {
    const numericId = String(id).match(/^\d{10,}$/) ? id : null
    if (numericId) {
      postUrl = `https://www.facebook.com/${numericId}`
    } else {
      postUrl = `https://www.facebook.com/${id}`
    }
  }

  return { fb_post_id: String(id), author_name: authorName, author_fb_id: authorId ? String(authorId) : null,
    content_text: msg.substring(0, 2000), post_url: postUrl, reactions: 0, comments: 0, shares: 0, posted_at: postedAt }
}

// ============================================
// Desktop DOM fallback
// ============================================

async function extractDesktopDOM(page) {
  return await page.evaluate(() => {
    const results = []
    for (const article of document.querySelectorAll('[role="article"]')) {
      const text = article.innerText || ''
      if (text.length < 30) continue
      let fbPostId = null, postUrl = null
      for (const a of article.querySelectorAll('a[href]')) {
        const m = a.href?.match(/\/posts\/(\d+)/) || a.href?.match(/story_fbid=(\d+)/) ||
          a.href?.match(/permalink\/(\d+)/) || a.href?.match(/pfbid([a-zA-Z0-9]{20,})/) || a.href?.match(/\/(\d{10,})(?:\/|$|\?)/)
        if (m) { fbPostId = m[1]; postUrl = a.href.split('?')[0]; break }
      }
      if (!fbPostId) { const h = text.substring(0, 100).split('').reduce((a, c) => ((a << 5) - a) + c.charCodeAt(0), 0); fbPostId = 'dom_' + Math.abs(h).toString(36) }
      const strong = article.querySelector('h2 a, h3 a, a > strong, h2 span a')
      const authorName = strong?.textContent?.trim()?.substring(0, 60) || null
      const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 10 && !l.match(/^(Like|Comment|Share|Thích|Bình luận|Chia sẻ)$/i)).slice(0, 8)
      const contentText = lines.join('\n').substring(0, 2000)
      if (contentText.length < 20) continue
      results.push({ fb_post_id: fbPostId, author_name: authorName, author_fb_id: null, content_text: contentText, post_url: postUrl, reactions: 0, comments: 0, shares: 0, posted_at: null })
    }
    return results
  })
}

module.exports = fetchSourceCookieHandler
