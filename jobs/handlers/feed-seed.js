/**
 * feed-seed.js — Chọn bài trên newsfeed và sinh comment.
 *
 * KHÔNG tự bấm DOM để comment. Thay vào đó: phát hiện bài → sinh comment bằng AI
 * → kiểm duyệt → ENQUEUE job `comment_post`. Lý do:
 *   1. comment-post.js đã có luồng comment qua m.facebook.com đã kiểm chứng,
 *      kèm retry và xác minh sau submit. Viết lại là nhân đôi rủi ro.
 *   2. Comment được RẢI RA theo thời gian thay vì dồn trong 1 phiên — đúng thứ
 *      cần cho an toàn (hard-limits đặt 45 phút giữa 2 comment feed).
 *
 * Quảng cáo động: mỗi bài do feed-ad-strategy quyết định — hợp thì cài quảng cáo
 * mềm, không thì comment như user bình thường.
 */

const { getPage, releaseSession } = require('../../browser/session-pool')
const { humanMouseMove } = require('../../browser/human')
const { getBlockDetectionScript, reasonToStatus } = require('../../lib/block-detector')
const { checkHardLimit, checkWarmup, getNickAgeDays } = require('../../lib/hard-limits')
const feedDom = require('../../browser/feed-dom')
const { buildExclusionContext, screenPost } = require('../../lib/feed-filter')
const { decideAdStrategy, buildCommentParams } = require('../../lib/feed-ad-strategy')
const aiBrain = require('../../lib/ai-brain')
const R = require('../../lib/randomizer')

const FEED_URL = 'https://www.facebook.com/'

async function feedSeed(payload, supabase) {
  const { account_id, max_comments, dry_run = false, job_id } = payload || {}
  if (!account_id) throw new Error('account_id is required for feedSeed')
  // Nhất quán với các handler khác trong dự án (campaign-nurture, campaign-post...)
  const bypassSafety = !!(payload.bypass_safety_limits || payload.force_now || payload.kpi_boost)

  // ── 1. Nick + ngách ──
  const { data: account } = await supabase
    .from('accounts').select('*, proxies(*)').eq('id', account_id).single()
  if (!account) throw new Error('Account not found')

  const { data: profiles } = await supabase
    .from('niche_profiles').select('*').eq('account_id', account_id).limit(1)
  const niche = (profiles && profiles[0]) || null
  if (!niche) throw new Error('SKIP_no_niche_profile')
  if (!niche.farming_enabled) throw new Error('SKIP_farming_disabled')

  // ── 2. Hạn mức ──
  const nickAge = getNickAgeDays(account)
  const warm = checkWarmup('feed_comment', nickAge, bypassSafety)
  if (!warm.allowed) {
    // fb_created_at trống → nick Facebook lâu năm bị tính là 0 ngày tuổi.
    // Báo rõ để người dùng biết cách xử lý thay vì chỉ thấy "SKIP_warmup".
    if (!account.fb_created_at) {
      console.warn(`[FEED-SEED] Nick ${account.username}: fb_created_at TRỐNG → bị tính ${nickAge} ngày tuổi. Nếu đây là nick Facebook lâu năm, hãy điền fb_created_at.`)
    }
    throw new Error(`SKIP_warmup_${warm.phase}`)
  }

  const budget = account.daily_budget?.feed_comment || { used: 0 }
  const chk = checkHardLimit('feed_comment', budget.used, 0, bypassSafety)
  if (!chk.allowed) throw new Error('SKIP_feed_comment_limit_reached')

  // Quota quảng cáo hôm nay (dùng cho feed-ad-strategy).
  //
  // BUG CŨ 1: lọc `.not('ad_strategy','is',null)` — nhưng file này ghi
  // ad_strategy = strategy HOẶC 'organic' cho MỌI comment, không bao giờ NULL.
  // → đếm cả comment thường (kể cả row skipped) → chạm trần 2 sau 2 lần thử
  // → decideAdStrategy luôn trả 'organic' → quảng cáo KHÔNG BAO GIỜ chạy.
  // BUG CŨ 2: mốc ngày cắt 'YYYY-MM-DD' bị Postgres hiểu là 00:00 UTC = 07:00 VN
  // → cửa sổ đếm lệch 7 tiếng.
  const vnMidnightUtc = (() => {
    const vn = new Date(Date.now() + 7 * 3600 * 1000)
    return new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()) - 7 * 3600 * 1000).toISOString()
  })()
  const { data: adToday } = await supabase.from('feed_actions')
    .select('id').eq('account_id', account_id).eq('action_type', 'comment')
    .neq('ad_strategy', 'organic')      // chỉ đếm comment CÓ quảng cáo
    .eq('status', 'done')               // và đã đăng thật, không tính lượt hụt
    .gte('created_at', vnMidnightUtc)
  const adCommentsToday = (adToday || []).length

  const limit = Math.min(max_comments || 2, chk.remaining)
  if (limit <= 0) throw new Error('SKIP_no_comment_quota')

  let sessionRow = null
  const stats = { scanned: 0, candidates: 0, generated: 0, rejected: 0, queued: 0, ads: 0 }
  const actionRows = []

  try {
    const sess = await getPage(account)
    const page = sess.page

    const { data: created } = await supabase.from('feed_sessions').insert({
      user_id: account.owner_id, account_id, job_id: job_id || null,
      session_kind: 'feed_seed', status: 'running',
    }).select('id')
    sessionRow = created && created[0]

    console.log(`[FEED-SEED] ${account.username} — tối đa ${limit} comment, quảng cáo đã dùng ${adCommentsToday}/${niche.daily_ad_comments ?? 2}${dry_run ? ' (CHẠY THỬ)' : ''}`)

    await page.goto(FEED_URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await R.sleepRange(4000, 7000)

    const blocked = await page.evaluate(getBlockDetectionScript())
    if (blocked.blocked) {
      await supabase.from('accounts')
        .update({ status: reasonToStatus(blocked.reason), is_active: false }).eq('id', account_id)
      throw new Error(`Account blocked: ${blocked.reason}`)
    }
    await humanMouseMove(page)

    // ── 3. Ngữ cảnh loại trừ ──
    const { data: ownNicks } = await supabase.from('accounts').select('fb_user_id')
    const { data: commented } = await supabase.from('feed_actions')
      .select('target_fb_post_id').eq('account_id', account_id)
      .eq('action_type', 'comment').limit(500)
    const { data: exclusions } = await supabase.from('feed_exclusions')
      .select('*').eq('user_id', account.owner_id).eq('is_active', true)

    const exCtx = buildExclusionContext({
      ownNickFbIds: (ownNicks || []).map(x => x.fb_user_id).filter(Boolean),
      commentedPostIds: (commented || []).map(x => x.target_fb_post_id).filter(Boolean),
      exclusions: exclusions || [],
    })

    // ── 4. Thu thập ứng viên. CHỈ nhận bài có permalink —
    //     comment_post cần post_url để điều hướng sang m.facebook.com. ──
    const candidates = []
    await feedDom.scrollAndCollect(page, {
      scrolls: 30,
      dwellMs: [4000, 7000],
      shouldStop: () => candidates.length >= limit * 6,
      onBatch: (fresh) => {
        for (const p of fresh) {
          stats.scanned++
          if (!p.link || !p.fbPostId || String(p.fbPostId).startsWith('syn_')) continue
          if (!p.canComment) continue
          const sc = screenPost({
            fbPostId: p.fbPostId, authorFbId: p.authorFbId,
            authorType: p.authorType, text: p.text, isAd: p.isAd,
          }, exCtx, niche)
          if (!sc.eligible) continue
          candidates.push({ post: p, tier: sc.tier, matched: sc.matched })
        }
      },
    })

    // Ưu tiên bài ngành, rồi tới bài dài (nhiều ngữ cảnh cho AI hơn)
    candidates.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier === 'niche' ? -1 : 1
      return b.post.text.length - a.post.text.length
    })
    stats.candidates = candidates.length
    console.log(`[FEED-SEED] ${stats.scanned} bài quét → ${candidates.length} ứng viên (ngành: ${candidates.filter(c => c.tier === 'niche').length})`)

    // ── 5. Sinh comment + kiểm duyệt + xếp hàng ──
    let adUsed = adCommentsToday
    // Mốc thời gian cộng dồn cho các job comment_post (xem chú thích chỗ dùng).
    let nextCommentAt = Date.now()
    for (const cand of candidates) {
      if (stats.queued >= limit) break
      const { post } = cand

      // Quyết định quảng cáo cho ĐÚNG bài này. Truyền nickAge để trần AUTO
      // (daily_ad_comments=null) nới đúng theo tuổi nick.
      const decision = decideAdStrategy(
        { text: post.text }, niche, { adCommentsToday: adUsed, nickAge }, null
      )
      const cp = buildCommentParams(decision, niche)

      // Sinh comment
      const gen = await aiBrain.generateSmartComment({
        postText: post.text,
        postAuthor: post.author,
        group: { name: 'Bảng tin' },        // ai-brain cần trường này; feed không thuộc nhóm nào
        campaign: null,
        nick: { username: account.username, created_at: account.created_at, mission: niche.persona },
        // Bài hạng CHUNG không được chấm theo chủ đề ngành — nếu truyền niche.niche
        // thì quality gate loại comment hợp lý chỉ vì "không liên quan VPS/Hosting".
        topic: cand.tier === 'niche' ? niche.niche : 'trò chuyện thân thiện',
        ownerId: account.owner_id,
        language: 'vi',
        adStrategy: cp.adStrategy,
        hasAdOpportunity: cp.hasAdOpportunity,
        matchedProduct: cp.matchedProduct,
        brandConfig: cp.brandConfig,
      })

      // AI có lúc trả rác: chuỗi "empty", "null", 1-2 từ vô nghĩa. Quality gate
      // KHÔNG chặn được (nhánh too_short trả object thiếu score → lọt heuristic_pass),
      // nên phải chặn ngay tại đây. Đã quan sát thật: AI trả đúng chữ "empty".
      const badOutput = !gen || !gen.text ||
        gen.text.trim().length < 15 ||
        /^(empty|null|undefined|n\/a|none|không|khong)\.?$/i.test(gen.text.trim())

      if (badOutput) {
        stats.rejected++
        actionRows.push({
          user_id: account.owner_id, session_id: sessionRow?.id, account_id,
          action_type: 'comment', target_fb_post_id: post.fbPostId, post_url: post.link,
          post_snippet: post.text.slice(0, 200), is_suggested: post.isSuggested,
          comment_text: gen && gen.text ? gen.text.slice(0, 100) : null,
          status: 'skipped',
          skip_reason: `ai_bad_output:${gen && gen.text ? gen.text.trim().slice(0, 20) : 'empty'}`,
        })
        continue
      }
      stats.generated++

      // Kiểm duyệt — cổng cuối trước khi cho lên Facebook
      const verdict = await aiBrain.qualityGateComment({
        comment: gen.text,
        postText: post.text,
        group: { name: 'Bảng tin' },
        topic: niche.niche,
        nick: { username: account.username, created_at: account.created_at },
        ownerId: account.owner_id,
        brandConfig: cp.brandConfig,
      })

      const baseRow = {
        user_id: account.owner_id, session_id: sessionRow?.id, account_id,
        action_type: 'comment', target_fb_post_id: post.fbPostId,
        target_fb_user_id: post.authorFbId, post_url: post.link,
        post_snippet: post.text.slice(0, 200), is_suggested: post.isSuggested,
        matched_keyword: cand.matched || null,
        comment_text: gen.text,
        ai_moderator_verdict: verdict || null,   // JSONB — giữ nguyên object
        ad_strategy: decision.isAd ? decision.strategy : 'organic',
        matched_product: decision.product ? decision.product.name : null,
        ad_score: decision.score || null,
      }

      if (!verdict || !verdict.approved) {
        stats.rejected++
        actionRows.push({ ...baseRow, status: 'skipped', skip_reason: `quality_gate:${verdict?.reason || 'no_verdict'}` })
        continue
      }

      if (dry_run) {
        actionRows.push({ ...baseRow, status: 'skipped', skip_reason: 'dry_run' })
        stats.queued++
        if (decision.isAd) { stats.ads++; adUsed++ }
        continue
      }

      // Xếp hàng job comment_post — rải ra, KHÔNG dồn cục.
      // 45-90 phút giữa 2 comment (hard-limits feed_comment: minGap 2700s).
      //
      // BUG CŨ: `delayMin` random LẠI mỗi vòng rồi NHÂN với chỉ số
      // (queued * delayMin) → comment #2 có thể +90 phút, #3 chỉ +90 phút
      // (2×45) → hai job TRÙNG mốc, phá vỡ chính min-gap đang viện dẫn.
      // Nay CỘNG DỒN: mỗi job cách job trước 45-90 phút thật sự.
      nextCommentAt += (45 + Math.floor(Math.random() * 46)) * 60 * 1000
      const scheduledAt = new Date(nextCommentAt)

      const { error: insErr } = await supabase.from('jobs').insert({
        type: 'comment_post',
        status: 'pending',
        created_by: account.owner_id,
        scheduled_at: scheduledAt.toISOString(),
        priority: 40,
        payload: {
          account_id,
          post_url: post.link,
          fb_post_id: post.fbPostId,
          comment_text: gen.text,
          source_name: 'newsfeed',
          owner_id: account.owner_id,
        },
      })

      if (insErr) {
        actionRows.push({ ...baseRow, status: 'failed', error_message: String(insErr.message || insErr).slice(0, 200) })
        continue
      }

      actionRows.push({ ...baseRow, status: 'done' })
      stats.queued++
      if (decision.isAd) { stats.ads++; adUsed++ }
      console.log(`[FEED-SEED] Xếp hàng #${stats.queued} (${decision.isAd ? '📢 ' + decision.strategy : '💬 organic'}) lúc ${scheduledAt.toLocaleTimeString('vi-VN')}: "${gen.text.slice(0, 60)}..."`)
    }

    // ── 6. Ghi log ──
    if (actionRows.length) {
      let saved = 0
      for (let i = 0; i < actionRows.length; i += 100) {
        const chunk = actionRows.slice(i, i + 100)
        try {
          const { error } = await supabase.from('feed_actions').insert(chunk)
          if (error) console.warn(`[FEED-SEED] Ghi log lỗi: ${error.message || error}`)
          else saved += chunk.length
        } catch (e) { console.warn(`[FEED-SEED] Ghi log ném lỗi: ${e.message}`) }
      }
      console.log(`[FEED-SEED] Đã ghi ${saved}/${actionRows.length} bản ghi`)
    }

    if (sessionRow) {
      await supabase.from('feed_sessions').update({
        finished_at: new Date().toISOString(),
        posts_scanned: stats.scanned,
        posts_commented: stats.queued,
        status: 'done',
      }).eq('id', sessionRow.id)
    }

    console.log(`[FEED-SEED] Xong: quét ${stats.scanned}, ứng viên ${stats.candidates}, sinh ${stats.generated}, loại ${stats.rejected}, xếp hàng ${stats.queued} (quảng cáo ${stats.ads})`)
    return {
      success: true,
      posts_scanned: stats.scanned,
      candidates: stats.candidates,
      generated: stats.generated,
      rejected: stats.rejected,
      queued: stats.queued,
      ads: stats.ads,
      zero_action: stats.queued === 0,
    }
  } catch (err) {
    if (sessionRow) {
      try {
        await supabase.from('feed_sessions').update({
          finished_at: new Date().toISOString(),
          posts_scanned: stats.scanned,
          posts_commented: stats.queued,
          status: String(err.message).startsWith('SKIP_') ? 'aborted' : 'failed',
          error_message: err.message.slice(0, 300),
        }).eq('id', sessionRow.id)
      } catch {}
    }
    throw err
  } finally {
    await releaseSession(account_id, supabase)
  }
}

module.exports = feedSeed
