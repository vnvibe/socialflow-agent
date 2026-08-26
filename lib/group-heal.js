/**
 * group-heal.js — Tự gỡ BLOCK MỀM cho nhóm đã nguội.
 *
 * VÌ SAO CÓ FILE NÀY (đo thật 25/08): camp "Tino VPS" chỉ định ĐÚNG 1 nhóm, cả 2
 * nick của camp đều bị `is_blocked=true` ở đúng nhóm đó (pending_timeout,
 * consecutive_skips từ tháng 5) → campaign_nurture ném `SKIP_no_groups_joined`
 * MỖI LẦN → camp chết lâm sàng nhưng vẫn sinh ~12 job/ngày đốt tài nguyên suốt
 * nhiều tháng, không ai biết vì thông báo lỗi chung chung.
 *
 * Gốc rễ: `is_blocked` là cờ VĨNH VIỄN, trong khi phần lớn lý do block chỉ là
 * trạng thái TẠM THỜI của hệ (chờ duyệt lâu, mấy lần không tìm được bài hợp lệ,
 * chưa xác định được tư cách thành viên). Nhóm đó vài tháng sau thường đã dùng
 * lại được, nhưng không có đường quay lại.
 *
 * NGUYÊN TẮC AN TOÀN:
 *  - CHỈ gỡ lý do MỀM. Lý do CỨNG (user tự chặn `manual:`, bị từ chối vĩnh viễn,
 *    bị đá khỏi nhóm, spam) thì KHÔNG BAO GIỜ tự gỡ — kể cả khi rất cũ.
 *  - Phải NGUỘI đủ lâu (mặc định 7 ngày kể từ lần kiểm tra tư cách gần nhất).
 *  - Gỡ xong KHÔNG dùng ngay: đặt skip_until +12h và reset consecutive_skips,
 *    để nhóm quay lại hàng đợi một cách từ tốn.
 *  - Ghi vết vào ai_note để người vận hành truy được vì sao nhóm sống lại.
 */

/** Lý do CỨNG — không tự gỡ trong mọi trường hợp. Kiểm TRƯỚC lý do mềm. */
const HARD_BLOCK_RE = /manual|rejected|banned|removed|permanent|not related|spam|kick/i

/** Lý do MỀM — trạng thái tạm thời của hệ, hết nguội thì thử lại được. */
const SOFT_BLOCK_RE = /pending_timeout|pending_days|consecutive_skips|unknown_status|approaching threshold|persistently unavailable|timeout/i

function isSoftBlock(reason) {
  const r = String(reason || '')
  if (!r) return false                 // không rõ lý do → không đoán, giữ block
  if (HARD_BLOCK_RE.test(r)) return false
  return SOFT_BLOCK_RE.test(r)
}

/**
 * Gỡ block mềm đã nguội cho MỘT nick.
 *
 * @param {object} supabase
 * @param {string} accountId
 * @param {{minAgeDays?: number, limit?: number}} [opts]
 * @returns {Promise<{healed: number, groups: string[], skipped: number}>}
 */
async function healSoftBlocks(supabase, accountId, opts = {}) {
  const minAgeDays = opts.minAgeDays ?? 7
  const limit = opts.limit ?? 20
  const out = { healed: 0, groups: [], skipped: 0 }
  if (!accountId) return out

  try {
    const { data: blocked } = await supabase
      .from('fb_groups')
      .select('id, name, blocked_reason, membership_last_checked_at, created_at, is_member')
      .eq('account_id', accountId)
      .eq('is_blocked', true)
      .limit(limit)

    if (!blocked?.length) return out

    const cutoff = Date.now() - minAgeDays * 86400000
    for (const g of blocked) {
      if (!isSoftBlock(g.blocked_reason)) { out.skipped++; continue }
      // Mốc nguội: lần kiểm tra tư cách gần nhất, không có thì lấy ngày tạo.
      const marker = g.membership_last_checked_at || g.created_at
      if (marker && new Date(marker).getTime() > cutoff) { out.skipped++; continue }

      const note = `auto-heal ${new Date().toISOString().slice(0, 10)}: gỡ block mềm "${String(g.blocked_reason).slice(0, 40)}" sau ${minAgeDays}+ ngày nguội`
      const { error } = await supabase.from('fb_groups').update({
        is_blocked: false,
        blocked_reason: null,
        consecutive_skips: 0,
        // Không dùng ngay — cho nhóm quay lại hàng đợi từ tốn.
        skip_until: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
        ai_note: note,
      }).eq('id', g.id).eq('account_id', accountId)

      if (!error) {
        out.healed++
        out.groups.push(g.name || g.id)
      }
    }

    if (out.healed > 0) {
      console.log(`[GROUP-HEAL] Nick ${accountId.slice(0, 8)}: gỡ block mềm ${out.healed} nhóm (${out.groups.slice(0, 3).join(', ')}${out.groups.length > 3 ? '…' : ''}), giữ block ${out.skipped}`)
    }
  } catch (e) {
    console.warn(`[GROUP-HEAL] lỗi: ${e.message}`)
  }
  return out
}

/**
 * Vì sao nick không có nhóm nào dùng được — để thông báo lỗi nói đúng nguyên
 * nhân thay vì `SKIP_no_groups_joined` chung chung (che giấu suốt nhiều tháng).
 */
async function diagnoseNoGroups(supabase, accountId, designatedGroupIds = []) {
  try {
    const { data: all } = await supabase
      .from('fb_groups')
      .select('fb_group_id, is_member, pending_approval, is_blocked, blocked_reason, user_approved')
      .eq('account_id', accountId)
      .limit(200)

    const rows = all || []
    const inScope = designatedGroupIds.length
      ? rows.filter(g => designatedGroupIds.includes(String(g.fb_group_id)))
      : rows

    if (designatedGroupIds.length && inScope.length === 0) {
      return `SKIP_designated_groups_not_joined: nick chưa vào ${designatedGroupIds.length} nhóm được chỉ định`
    }

    const n = {
      total: inScope.length,
      member: inScope.filter(g => g.is_member === true).length,
      pending: inScope.filter(g => g.pending_approval === true).length,
      blocked: inScope.filter(g => g.is_blocked === true).length,
      unapproved: inScope.filter(g => g.user_approved === false).length,
    }
    const reasons = [...new Set(inScope.filter(g => g.is_blocked).map(g => String(g.blocked_reason || '?').slice(0, 30)))]
    const scope = designatedGroupIds.length ? 'nhóm CHỈ ĐỊNH' : 'nhóm'

    if (n.total === 0) return 'SKIP_no_groups_joined: nick chưa có nhóm nào'
    if (n.blocked >= n.total) {
      return `SKIP_all_groups_blocked: ${n.blocked}/${n.total} ${scope} bị block (${reasons.join(' | ')})`
    }
    if (n.member === 0 && n.pending > 0) {
      return `SKIP_groups_pending_approval: ${n.pending}/${n.total} ${scope} còn chờ duyệt`
    }
    if (n.unapproved >= n.total) {
      return `SKIP_groups_not_user_approved: ${n.unapproved}/${n.total} ${scope} chưa được duyệt thủ công`
    }
    return `SKIP_no_groups_joined: ${scope} tổng ${n.total}, member ${n.member}, block ${n.blocked}, chờ duyệt ${n.pending}`
  } catch {
    return 'SKIP_no_groups_joined'
  }
}

module.exports = { healSoftBlocks, diagnoseNoGroups, isSoftBlock, HARD_BLOCK_RE, SOFT_BLOCK_RE }
