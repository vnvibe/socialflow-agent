/**
 * Campaign Handler: Group Monitor (campaign_group_monitor)
 * Scans a monitored group's feed, evaluates posts against brand keywords,
 * and inserts high-scoring opportunities into group_opportunities.
 * Does NOT interact — only reads and evaluates.
 */

const { getPage, releaseSession } = require('../../browser/session-pool')
const { delay, humanScroll, humanBrowse } = require('../../browser/human')
const { checkAccountStatus, saveDebugScreenshot } = require('./post-utils')
const { evaluateOpportunities } = require('../../lib/ai-brain')
const { scrollAndExtractPosts } = require('./scan-group')
const { ActivityLogger } = require('../../lib/activity-logger')
const R = require('../../lib/randomizer')

async function campaignGroupMonitor(payload, supabase) {
  const {
    monitored_group_id, account_id, campaign_id, owner_id,
    group_fb_id, group_name, group_url,
    brand_keywords, brand_name, brand_voice,
    opportunity_threshold, scan_lookback_minutes,
  } = payload

  const startTime = Date.now()

  const logger = new ActivityLogger(supabase, {
    campaign_id,
    account_id,
    job_id: payload.job_id,
    owner_id: owner_id || payload.created_by,
  })

  // Load account
  const { data: account } = await supabase
    .from('accounts')
    .select('*, proxies(*)')
    .eq('id', account_id)
    .single()
  if (!account) throw new Error('Account not found')

  // Load existing post IDs to dedup (last 24h)
  const { data: existing } = await supabase
    .from('group_opportunities')
    .select('post_fb_id')
    .eq('monitored_group_id', monitored_group_id)
    .gte('detected_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString())

  const seenPostIds = new Set((existing || []).map(r => r.post_fb_id))

  // DEDUP THẬT (03/09): trước đây chỉ dedup theo group_opportunities — bảng đó
  // rỗng vĩnh viễn nên MỌI phiên chấm lại đúng những bài cũ (đo 24h: 420 lượt
  // "mới" nhưng toàn bài trùng, đốt AI call vô ích). Nay mọi bài đã chấm được
  // ghi vào group_post_scores (upsert phía dưới) và lọc ở đây.
  try {
    const { data: scored } = await supabase
      .from('group_post_scores')
      .select('fb_post_id')
      .eq('fb_group_id', group_fb_id)
      .limit(1000)
    for (const r of (scored || [])) seenPostIds.add(r.fb_post_id)
  } catch {}

  let page, session
  try {
    // Acquire browser session — GIỐNG scan-group, KHÔNG ép headless (02/09):
    // diag đo được cùng extractor, scan-group (mặc định + humanBrowse) ra
    // links:6/bài:3, monitor (headless:true, quét khô) ra links:0/body 3.6k —
    // feed nhóm lớn không chịu render đủ trong môi trường đó.
    const result = await getPage(account)
    page = result.page
    session = result.session

    // Check account status
    const status = await checkAccountStatus(page, supabase, account_id)
    if (status.blocked) throw new Error(`Account blocked: ${status.reason}`)

    // Navigate to group
    const url = group_url || `https://www.facebook.com/groups/${group_fb_id}`
    console.log(`[GROUP-MONITOR] Scanning "${group_name}" (${url})`)

    // LỖI CÂM LỊCH SỬ (tìm ra 02/09): chỗ này từng gọi
    //   scanGroupPosts(page, {groupUrl, ...})
    // nhưng scanGroupPosts của ai-brain có chữ ký ({posts, ...}) — hàm CHẤM ĐIỂM
    // danh sách bài có sẵn, không phải hàm quét DOM. Truyền page vào → posts
    // destructure ra undefined → return [] NGAY, success=true, scanned=0,
    // duration 0s. Vì thế group_opportunities = 0 từ khi tính năng ra đời.
    // Nó cũng KHÔNG hề goto — phải tự điều hướng rồi quét bằng
    // scrollAndExtractPosts (mượn từ scan-group.js, đã qua thực chiến).
    // sorting_setting=CHRONOLOGICAL (02/09): nhóm 29K đổ bộ vào tab Featured
    // (bodySample: header + composer + 2 bài ghim, 0 link bài) → quét trắng dù
    // là member thật. Ép vào feed Thảo luận mới-nhất — vừa né Featured vừa lấy
    // bài tươi cho việc chào hàng.
    const gotoUrl = url + (url.includes('?') ? '&' : '?') + 'sorting_setting=CHRONOLOGICAL'
    await page.goto(gotoUrl, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await delay(3000, 5000)
    // Lướt như người trước khi quét — scan-group làm vậy và feed render đủ;
    // bỏ bước này thì nhóm lớn trả links:0 (diag 02/09).
    await humanBrowse(page, 2)
    // Nhóm lớn (29K) tải feed GraphQL chậm qua proxy — diag đo body dừng ngay
    // sau composer, "Related groups: No recommendations" = feed chưa về. Nudge
    // 1 cú scroll để kích lazy-load rồi CHỜ LÌ tới 30s cho link bài đầu tiên;
    // hết 30s vẫn trắng thì extract như cũ để diag ghi nhận.
    await page.mouse.wheel(0, 600).catch(() => {})
    await page.waitForSelector(
      '[role="feed"] a[href*="/posts/"], [role="feed"] a[href*="permalink"], [role="feed"] a[href*="story_fbid"]',
      { timeout: 30000 }
    ).catch(() => {})
    // EXTRACTOR CHÍNH = feed-dom (02/09). Screenshot debug cho thấy feed nhóm
    // 29K CÓ bài render đầy đủ nhưng link bài dạng lazy href="#" → selector
    // a[href*="/posts/"] của scrollAndExtractPosts đếm 0 vĩnh viễn. feed-dom
    // là bộ quét newsfeed chạy thật hằng ngày, đã xử cạm bẫy href lazy/giải id.
    // Giữ scrollAndExtractPosts làm fallback cho nhóm nhỏ kiểu cũ.
    let viaFeedDom = true
    const feedDom = require('../../browser/feed-dom')
    let rawFeed = []
    try {
      let thu = 0
      rawFeed = await feedDom.scrollAndCollect(page, {
        scrolls: 10,
        dwellMs: [2500, 4500],
        shouldStop: () => thu >= 30 || (Date.now() - startTime) > 5 * 60 * 1000,
        onBatch: (fresh) => { thu += fresh.length },
      })
    } catch (e) {
      console.warn(`[GROUP-MONITOR] feed-dom lỗi: ${e.message} — fallback extractor cũ`)
    }
    let rawPosts
    if (rawFeed.length) {
      rawPosts = rawFeed
        .filter(p => p.fbPostId && !String(p.fbPostId).startsWith('syn_') && (p.text || '').length >= 20)
        .slice(0, 30)
        .map(p => ({
          fb_post_id: p.fbPostId,
          content_text: p.text,
          author_name: p.author || null,
          post_url: p.link || null,
          reactions: 0,
          comments: 0,
        }))
    } else {
      viaFeedDom = false
      rawPosts = await scrollAndExtractPosts(page, 30)
    }
    // Chẩn đoán DOM khi quét trắng (đo 02/09: "Hosting, Server, Vps giá rẻ"
    // 36s mà scanned=0) — extractor đã ghi window.__scanDiag, phải moi ra kết
    // quả job thì mới đo được từ DB thay vì đoán mò.
    let scanDiag = null
    if (!rawPosts.length) {
      // Chụp màn hình khi quét trắng (02/09) — mọi diag chữ đã cạn manh mối,
      // cần nhìn tận mắt trang đang hiển thị gì.
      const shot = await saveDebugScreenshot(page, `monitor-empty-${group_fb_id}`)
      scanDiag = await page.evaluate(() => ({
        ...(window.__scanDiag || {}),
        // 250 ký tự đầu của trang — cho biết đang nhìn thấy GÌ khi 0 bài
        // (preview-wall? tab Featured? checkpoint?). Nhóm 29K member thật mà
        // links=0 (02/09) — thiếu mẫu này thì chỉ đoán mò.
        bodySample: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 250),
      })).catch(() => null)
      if (scanDiag && shot) scanDiag.screenshot = shot
      console.warn(`[GROUP-MONITOR] 0 bài — diag: ${JSON.stringify(scanDiag)}`)
    }
    // Map về shape phần dưới của handler + evaluateOpportunities đang đọc
    // (fb_id, body, author, url, reactions, comments).
    const posts = rawPosts.map(p => ({
      fb_id: p.fb_post_id,
      body: p.content_text,
      author: p.author_name,
      url: p.post_url,
      reactions: p.reactions || 0,
      comments: p.comments || 0,
    })).filter(p => p.fb_id && (p.body || '').length >= 20)

    console.log(`[GROUP-MONITOR] Found ${posts.length} posts in "${group_name}"`)

    // Filter out already-seen posts
    const newPosts = posts.filter(p => p.fb_id && !seenPostIds.has(p.fb_id))
    console.log(`[GROUP-MONITOR] ${newPosts.length} new posts (${seenPostIds.size} already tracked)`)

    if (newPosts.length === 0) {
      // Update stats even if no new posts — kèm GIÃN NHỊP QUÉT (06/09): nhóm
      // trắng bài thì lần sau quét thưa hơn, khỏi đốt browser vô ích.
      await supabase.from('monitored_groups').update({
        total_scans: supabase.rpc ? undefined : undefined, // increment below
        last_scanned_at: new Date().toISOString(),
        scan_interval_minutes: nhipQuetThichUng(0, payload.scan_interval_minutes),
      }).eq('id', monitored_group_id)

      // Increment total_scans via raw update
      await supabase.rpc('increment_field', {
        table_name: 'monitored_groups',
        field_name: 'total_scans',
        row_id: monitored_group_id,
      }).catch(() => {
        // Fallback: simple update
        supabase.from('monitored_groups').update({
          total_scans: (payload._current_scans || 0) + 1,
        }).eq('id', monitored_group_id)
      })

      logger.log('scan', {
        target_type: 'group',
        target_name: group_name,
        target_id: group_fb_id,
        result_status: 'success',
        details: { total_posts: posts.length, new_posts: 0 },
      })
      await logger.flush()

      return {
        success: true,
        scanned: posts.length,
        new: 0,
        opportunities: 0,
        duration_seconds: Math.round((Date.now() - startTime) / 1000),
        ...(scanDiag ? { scan_diag: scanDiag } : {}),
      }
    }

    // AI evaluate posts against brand keywords
    let evaluations = []
    try {
      evaluations = await evaluateOpportunities(newPosts, {
        brandKeywords: brand_keywords || [],
        brandName: brand_name || '',
        threshold: opportunity_threshold || 7,
        ownerId: owner_id,
      })
    } catch (err) {
      console.warn(`[GROUP-MONITOR] AI evaluation failed: ${err.message} — using keyword fallback`)
      // Simple keyword fallback: check if post contains any brand keyword
      evaluations = newPosts
        .map(p => {
          const text = (p.body || p.text || '').toLowerCase()
          const matched = (brand_keywords || []).filter(kw => text.includes(kw.toLowerCase()))
          if (matched.length === 0) return null
          return {
            post: p,
            score: Math.min(6 + matched.length, 10),
            reason: `Keyword match: ${matched.join(', ')}`,
            matchedKeywords: matched,
          }
        })
        .filter(Boolean)
    }

    // Ghi MỌI bài đã chấm vào group_post_scores — vừa là sổ dedup cho phiên
    // sau, vừa đo được phân bố điểm thật (03/09).
    for (const e of evaluations) {
      try {
        await supabase.from('group_post_scores').upsert({
          owner_id,
          campaign_id,
          fb_group_id: group_fb_id,
          group_name: group_name || '',
          fb_post_id: e.post.fb_id || e.post.id,
          post_url: e.post.url || null,
          post_author: e.post.author || '',
          post_text: (e.post.body || e.post.text || '').substring(0, 500),
          ai_score: e.score || 0,
          ad_reason: (e.reason || '').slice(0, 200) || null,
          commented: false,
        }, { onConflict: 'owner_id,fb_post_id' })
      } catch {}
    }

    // Filter by threshold and insert opportunities
    const qualifiedOpps = evaluations.filter(e => e.score >= (opportunity_threshold || 7))
    const maxScore = evaluations.length ? Math.max(...evaluations.map(e => e.score || 0)) : null
    console.log(`[GROUP-MONITOR] ${qualifiedOpps.length}/${evaluations.length} opportunities meet threshold (>=${opportunity_threshold}), max=${maxScore}`)

    if (qualifiedOpps.length > 0) {
      const rows = qualifiedOpps.map(e => ({
        owner_id,
        monitored_group_id,
        campaign_id,
        post_fb_id: e.post.fb_id || e.post.id,
        post_content: (e.post.body || e.post.text || '').substring(0, 2000),
        post_author: e.post.author || e.post.authorName || null,
        post_url: e.post.url || e.post.permalink || null,
        post_created_at: e.post.created_at || e.post.timestamp || null,
        post_reactions: e.post.reactions || e.post.reactionCount || 0,
        post_comments: e.post.comments || e.post.commentCount || 0,
        opportunity_score: e.score,
        opportunity_reason: e.reason,
        matched_keywords: e.matchedKeywords || [],
        status: 'pending',
      }))

      // Upsert to handle race conditions (unique on monitored_group_id + post_fb_id)
      const { error: insertErr } = await supabase
        .from('group_opportunities')
        .upsert(rows, { onConflict: 'monitored_group_id,post_fb_id', ignoreDuplicates: true })

      if (insertErr) {
        console.error(`[GROUP-MONITOR] Insert opportunities error:`, insertErr.message)
      }
    }

    // Update monitored_groups stats + NHỊP QUÉT THÍCH ỨNG theo độ màu mỡ (06/09)
    const nhipMoi = nhipQuetThichUng(newPosts.length, payload.scan_interval_minutes)
    await supabase.from('monitored_groups').update({
      last_scanned_at: new Date().toISOString(),
      total_scans: (payload._current_scans || 0) + 1,
      total_opportunities: (payload._current_opps || 0) + qualifiedOpps.length,
      scan_interval_minutes: nhipMoi,
    }).eq('id', monitored_group_id)
    if (nhipMoi !== (payload.scan_interval_minutes || 120)) {
      console.log(`[GROUP-MONITOR] "${group_name}": ${newPosts.length} bài mới → nhịp quét ${payload.scan_interval_minutes || 120} → ${nhipMoi} phút`)
    }

    logger.log('scan', {
      target_type: 'group',
      target_name: group_name,
      target_id: group_fb_id,
      result_status: 'success',
      details: {
        total_posts: posts.length,
        new_posts: newPosts.length,
        evaluated: evaluations.length,
        opportunities: qualifiedOpps.length,
      },
    })

    return {
      success: true,
      scanned: posts.length,
      new: newPosts.length,
      opportunities: qualifiedOpps.length,
      evaluated: evaluations.length,
      max_score: maxScore,
      duration_seconds: Math.round((Date.now() - startTime) / 1000),
      extractor: viaFeedDom ? 'feed_dom' : 'legacy',
      ...(scanDiag ? { scan_diag: scanDiag } : {}),
    }
  } finally {
    if (account_id) {
      await releaseSession(account_id, supabase).catch(err =>
        console.warn(`[GROUP-MONITOR] Release session error: ${err.message}`)
      )
    }
    await logger.flush()
  }
}


/**
 * NHỊP QUÉT THÍCH ỨNG (06/09) — nhóm nghèo bài thì quét thưa ra.
 *
 * Đo 7 ngày: 302 phiên quét (~5,4 giờ browser) chỉ ra 2 cơ hội. Hai nhóm chợ
 * VPS — mục tiêu chính — chỉ nhả 0,6-0,7 bài mới mỗi phiên nhưng vẫn bị quét
 * 50+ lần vì nhịp cố định 120 phút cho mọi nhóm. Phí browser, phí quota nick,
 * và tăng dấu vết truy cập bất thường.
 *
 * Nhóm màu mỡ quét dày, nhóm im lìm giãn dần tới 6 tiếng; có bài mới trở lại
 * là siết nhịp ngay (hồi phục nhanh, backoff chậm).
 */
function nhipQuetThichUng(soBaiMoi, nhipHienTai = 120) {
  if (soBaiMoi >= 8) return 90
  if (soBaiMoi >= 3) return 120
  if (soBaiMoi >= 1) return 180
  return Math.min(360, Math.round((nhipHienTai || 120) * 1.5))   // trắng bài → giãn 1,5 lần, trần 6h
}

module.exports = campaignGroupMonitor
