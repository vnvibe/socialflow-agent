const { getPage, releaseSession } = require('../../browser/session-pool')

async function checkHealthHandler(payload, supabase) {
  const { account_id } = payload

  const { data: account } = await supabase
    .from('accounts')
    .select('*, proxies(*)')
    .eq('id', account_id)
    .single()

  if (!account) throw new Error('Account not found')

  let page
  try {
    const session = await getPage(account)
    page = session.page

    // Navigate to Facebook
    console.log(`[CHECK] Opening Facebook for ${account.username || account_id}...`)
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    // Wait for page to fully render (Facebook never reaches networkidle due to constant polling)
    await page.waitForTimeout(5000)

    const url = page.url()
    console.log(`[CHECK] Final URL: ${url}`)

    // Detect status — combine DOM checks + source parsing (FB changes frequently)
    const result = await page.evaluate(() => {
      const src = document.documentElement.innerHTML
      const currentUrl = window.location.href.toLowerCase()
      const urlPath = new URL(currentUrl).pathname

      // === URL checks ===
      const isCheckpointUrl = urlPath.includes('/checkpoint')
      const isLoginUrl = urlPath.includes('/login') || currentUrl.includes('login.php')
      const checkpointForm = document.querySelector('form[action*="checkpoint"]')
      const securityCheck = document.querySelector('#checkpoint_title, [data-testid="checkpoint"]')

      // === Login detection (multiple strategies) ===
      let isLoggedIn = null
      let userId = null

      // Strategy 1: JSON in source
      const loggedInMatch = src.match(/"is_logged_in"\s*:\s*(true|false)/)
      if (loggedInMatch) isLoggedIn = loggedInMatch[1] === 'true'

      const userIdMatch = src.match(/"USER_ID"\s*:\s*"(\d+)"/)
      if (userIdMatch && userIdMatch[1] !== '0') userId = userIdMatch[1]

      // Strategy 2: actorID in source (FB 2025+)
      if (!userId) {
        const actorMatch = src.match(/"actorID"\s*:\s*"(\d+)"/)
        if (actorMatch) userId = actorMatch[1]
      }

      // Strategy 3: DOM elements that only exist when logged in
      const hasNavBar = !!document.querySelector('[role="navigation"]')
      const hasComposer = !!document.querySelector('[role="main"] [contenteditable="true"]')
      const hasProfileLink = !!document.querySelector('a[href*="/me"], a[aria-label*="profile"], a[aria-label*="trang cá nhân"]')
      const hasNotifIcon = !!document.querySelector('[aria-label="Notifications"], [aria-label="Thông báo"]')
      const hasMessengerIcon = !!document.querySelector('[aria-label="Messenger"]')
      const hasSearchBox = !!document.querySelector('input[placeholder*="Tìm kiếm"], input[placeholder*="Search"]')

      // If we see nav + messenger + search → definitely logged in
      const domLoggedIn = (hasNavBar && hasMessengerIcon && hasSearchBox) || hasComposer || hasProfileLink
      if (isLoggedIn === null && domLoggedIn) isLoggedIn = true

      const hasUserId = !!userId

      // === fb_dtsg ===
      let dtsg = null
      const dtsgEl = document.querySelector('input[name="fb_dtsg"]')
      if (dtsgEl) dtsg = dtsgEl.value
      if (!dtsg) {
        const m = src.match(/"DTSGInitialData"[^}]*"token"\s*:\s*"([^"]+)"/)
        if (m) dtsg = m[1]
      }
      if (!dtsg) {
        const m2 = src.match(/\["DTSGInitData",\s*\[\],\s*\{"token"\s*:\s*"([^"]+)"/)
        if (m2) dtsg = m2[1]
      }
      // More dtsg patterns
      if (!dtsg) {
        const m3 = src.match(/"dtsg"\s*:\s*\{"token"\s*:\s*"([^"]+)"/)
        if (m3) dtsg = m3[1]
      }

      // === Profile name ===
      let name = null
      // From source JSON
      const namePatterns = [
        /"NAME"\s*:\s*"([^"]+)"/,
        /"shortName"\s*:\s*"([^"]+)"/,
        /"userInfoFieldName"\s*:\s*"([^"]+)"/,
        /"profileName"\s*:\s*"([^"]+)"/,
      ]
      for (const p of namePatterns) {
        const m = src.match(p)
        if (m && m[1] !== 'Messenger' && m[1].length > 1) { name = m[1]; break }
      }
      // From profile avatar's aria-label (most reliable in current FB)
      if (!name) {
        const avatarLink = document.querySelector('[aria-label][role="link"] image, a[aria-label] svg image')
        if (avatarLink) {
          const parent = avatarLink.closest('[aria-label]')
          if (parent) {
            const label = parent.getAttribute('aria-label')
            if (label && label.length > 1 && label.length < 40 && label !== 'Messenger') name = label
          }
        }
      }
      // From navigation bar - last avatar link
      if (!name) {
        const navImages = document.querySelectorAll('[role="navigation"] a[aria-label] image, [role="banner"] a[aria-label] image')
        for (const img of navImages) {
          const a = img.closest('a[aria-label]')
          if (a) {
            const label = a.getAttribute('aria-label')
            if (label && !['Messenger', 'Facebook', 'Thông báo', 'Notifications', 'Menu', 'Trang chủ', 'Home'].includes(label)) {
              name = label
            }
          }
        }
      }

      // === Profile picture ===
      let pic = null
      const picPatterns = [
        /"profilePicLarge"\s*:\s*\{\s*"uri"\s*:\s*"([^"]+)"/,
        /"profilePic160"\s*:\s*\{\s*"uri"\s*:\s*"([^"]+)"/,
        /"profile_picture"\s*:\s*\{\s*"uri"\s*:\s*"([^"]+)"/,
      ]
      for (const p of picPatterns) {
        const m = src.match(p)
        if (m) { pic = m[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/'); break }
      }
      if (!pic) {
        const svgImages = document.querySelectorAll('svg image')
        for (const img of svgImages) {
          const href = img.getAttribute('xlink:href') || img.getAttribute('href')
          if (href && href.includes('scontent')) { pic = href; break }
        }
      }

      // Decode unicode
      if (name) {
        try { name = name.replace(/\\u[\dA-Fa-f]{4}/g, m => String.fromCharCode(parseInt(m.slice(2), 16))) } catch {}
      }

      return {
        isLoggedIn, hasUserId, userId,
        isCheckpointUrl, isLoginUrl,
        hasCheckpointForm: !!checkpointForm, hasSecurityCheck: !!securityCheck,
        dtsg, name, pic,
        title: document.title,
        domSignals: { hasNavBar, hasComposer, hasProfileLink, hasNotifIcon, hasMessengerIcon, hasSearchBox }
      }
    })

    const ds = result.domSignals || {}
    console.log(`[CHECK] Detection: loggedIn=${result.isLoggedIn}, userId=${result.hasUserId}, checkpoint=${result.isCheckpointUrl}, login=${result.isLoginUrl}`)
    console.log(`[CHECK] DOM: nav=${ds.hasNavBar}, composer=${ds.hasComposer}, messenger=${ds.hasMessengerIcon}, search=${ds.hasSearchBox}`)
    console.log(`[CHECK] Profile: name=${result.name}, hasPic=${!!result.pic}, hasDtsg=${!!result.dtsg}`)

    // Determine status based on reliable indicators
    let status = 'unknown'
    let reason = null

    if (result.isCheckpointUrl || result.hasCheckpointForm || result.hasSecurityCheck) {
      status = 'checkpoint'
      reason = 'CHECKPOINT'
    } else if (result.isLoginUrl && !result.hasUserId) {
      status = 'expired'
      reason = 'SESSION_EXPIRED'
    } else if (result.isLoggedIn === false && !result.hasUserId) {
      status = 'expired'
      reason = 'SESSION_EXPIRED'
    } else if (!result.hasUserId && !result.dtsg && result.isLoggedIn === null) {
      // No user data at all → cookie expired or invalid
      status = 'expired'
      reason = 'SESSION_EXPIRED'
    } else if (result.hasUserId || result.isLoggedIn === true || result.dtsg) {
      status = 'healthy'
    }

    // Release session back to pool (keep browser open for reuse)
    // Keep page on FB for session reuse
    releaseSession(account_id)

    // Build update object
    const updates = {
      status,
      last_checked_at: new Date()
    }
    if (result.dtsg) {
      updates.fb_dtsg = result.dtsg
      updates.dtsg_expires_at = new Date(Date.now() + 6 * 60 * 60 * 1000)
    }
    if (result.name) {
      updates.username = result.name
    }
    if (result.pic) {
      updates.avatar_url = result.pic
    }
    if (result.userId) {
      updates.fb_user_id = result.userId
    }

    await supabase.from('accounts').update(updates).eq('id', account_id)

    console.log(`[CHECK] Result: ${status}${reason ? ` (${reason})` : ''} | name=${result.name || 'N/A'} | avatar=${result.pic ? 'YES' : 'NO'}`)
    return { status, reason, username: result.name }
  } catch (err) {
    if (page) {
      // Keep page on FB for session reuse
      releaseSession(account_id)
    }
    await supabase.from('accounts').update({
      status: 'unknown',
      last_checked_at: new Date()
    }).eq('id', account_id)

    console.error(`[CHECK] Error for ${account.username || account_id}:`, err.message)
    throw err
  }
}

module.exports = checkHealthHandler
