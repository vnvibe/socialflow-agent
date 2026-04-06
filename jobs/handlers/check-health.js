const { getPage, releaseSession } = require('../../browser/session-pool')
const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')

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
      // Strategy: find largest avatar image on page
      let pic = null

      // 1. Try page source JSON patterns (best quality)
      const picPatterns = [
        /"profilePicLarge"\s*:\s*\{\s*"uri"\s*:\s*"([^"]+)"/,
        /"profilePic160"\s*:\s*\{\s*"uri"\s*:\s*"([^"]+)"/,
        /"profile_picture"\s*:\s*\{\s*"uri"\s*:\s*"([^"]+)"/,
        /"profilePhoto"\s*:\s*\{\s*"image"\s*:\s*\{\s*"uri"\s*:\s*"([^"]+)"/,
      ]
      for (const p of picPatterns) {
        const m = src.match(p)
        if (m) { pic = m[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/'); break }
      }

      // 2. Try SVG images — pick LARGEST one (skip nav bar 36x36)
      if (!pic) {
        const svgImages = document.querySelectorAll('svg image')
        let bestPic = null
        let bestSize = 0
        for (const img of svgImages) {
          const href = img.getAttribute('xlink:href') || img.getAttribute('href')
          if (!href || !href.includes('scontent')) continue
          const svg = img.closest('svg')
          const w = parseInt(svg?.style?.width || svg?.getAttribute('width') || '0')
          if (w > bestSize) { bestSize = w; bestPic = href }
        }
        if (bestPic) pic = bestPic
      }

      // 3. Try regular img tags with scontent URLs (profile sections)
      if (!pic) {
        const imgs = document.querySelectorAll('img[src*="scontent"]')
        let bestImg = null
        let bestW = 0
        for (const img of imgs) {
          const w = img.naturalWidth || img.width || parseInt(img.getAttribute('width') || '0')
          if (w > bestW && w > 50) { bestW = w; bestImg = img.src }
        }
        if (bestImg) pic = bestImg
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

    // If healthy but no avatar found from feed → visit profile page for large avatar
    if (status === 'healthy' && !result.pic && result.userId) {
      try {
        console.log(`[CHECK] No avatar from feed — visiting profile for large avatar`)
        await page.goto(`https://www.facebook.com/profile.php?id=${result.userId}`, {
          waitUntil: 'domcontentloaded', timeout: 15000
        })
        await page.waitForTimeout(3000)

        const profilePic = await page.evaluate(() => {
          // Profile page has larger avatar — look for profilePicLarge in source
          const src = document.documentElement.innerHTML
          const patterns = [
            /"profilePicLarge"\s*:\s*\{\s*"uri"\s*:\s*"([^"]+)"/,
            /"profilePic320"\s*:\s*\{\s*"uri"\s*:\s*"([^"]+)"/,
            /"profilePic160"\s*:\s*\{\s*"uri"\s*:\s*"([^"]+)"/,
          ]
          for (const p of patterns) {
            const m = src.match(p)
            if (m) return m[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/')
          }
          // Fallback: largest img on profile page
          const imgs = document.querySelectorAll('image[xlink\\:href*="scontent"], img[src*="scontent"]')
          let best = null, bestW = 0
          for (const img of imgs) {
            const href = img.getAttribute('xlink:href') || img.src
            const svg = img.closest('svg')
            const w = parseInt(svg?.style?.width || img.naturalWidth || img.width || '0')
            if (w > bestW && w > 80) { bestW = w; best = href }
          }
          return best
        })

        if (profilePic) {
          result.pic = profilePic
          console.log(`[CHECK] Got large avatar from profile page`)
        }
      } catch (profErr) {
        console.warn(`[CHECK] Profile visit for avatar failed: ${profErr.message}`)
      }
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
      console.log(`[CHECK] Avatar scraped: ${result.pic.substring(0, 80)}...`)
      // Upload avatar to R2 for permanent storage (Facebook CDN URLs expire)
      const hasR2 = !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY)
      console.log(`[CHECK] R2 config: ${hasR2 ? 'OK' : 'MISSING'} (R2_ACCOUNT_ID=${process.env.R2_ACCOUNT_ID ? 'set' : 'unset'}, R2_PUBLIC_URL=${process.env.R2_PUBLIC_URL ? 'set' : 'unset'})`)

      if (hasR2) {
        try {
          const avatarUrl = await uploadAvatarToR2(account_id, result.pic)
          if (avatarUrl) {
            updates.avatar_url = avatarUrl
            console.log(`[CHECK] ✓ Avatar uploaded to R2: ${avatarUrl}`)
          } else {
            updates.avatar_url = result.pic
            console.log(`[CHECK] ⚠ R2 upload returned null, saved CDN URL`)
          }
        } catch (avatarErr) {
          console.warn(`[CHECK] ✗ Avatar R2 upload failed: ${avatarErr.message}`)
          updates.avatar_url = result.pic
          console.log(`[CHECK] Fallback: saved CDN URL`)
        }
      } else {
        updates.avatar_url = result.pic
        console.log(`[CHECK] R2 not configured, saved CDN URL directly`)
      }
    } else {
      console.log(`[CHECK] No avatar found in page`)
    }
    if (result.userId) {
      updates.fb_user_id = result.userId
    }

    // Auto-recovery: if now healthy but was disabled by error → re-enable
    // ONLY for checkpoint/expired/at_risk, NOT for manually disabled accounts
    const oldStatus = account.status
    const wasAutoDisabled = ['checkpoint', 'expired', 'at_risk'].includes(oldStatus)
    if (status === 'healthy' && account.is_active === false && wasAutoDisabled) {
      updates.is_active = true
      console.log(`[HEALTH] ✓ Auto-recovered nick ${account_id.slice(0, 8)}: ${oldStatus} → healthy, re-enabled`)
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

/**
 * Download avatar from Facebook CDN and upload to R2
 * Returns R2 public URL or null on failure
 */
async function uploadAvatarToR2(accountId, fbAvatarUrl) {
  if (!fbAvatarUrl || !accountId) return null

  // Ensure R2 env vars are set
  if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID) {
    return null // R2 not configured, skip silently
  }

  const tmpDir = path.join(__dirname, '..', '..', 'tmp')
  fs.mkdirSync(tmpDir, { recursive: true })
  const tmpPath = path.join(tmpDir, `avatar-${accountId}.jpg`)

  try {
    console.log(`[CHECK] Avatar download: ${fbAvatarUrl.substring(0, 60)}... → ${tmpPath}`)
    // Download avatar image from Facebook CDN
    await new Promise((resolve, reject) => {
      const urlObj = new URL(fbAvatarUrl)
      const client = urlObj.protocol === 'https:' ? https : http
      const req = client.get(fbAvatarUrl, { timeout: 8000 }, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          client.get(res.headers.location, { timeout: 8000 }, (res2) => {
            const ws = fs.createWriteStream(tmpPath)
            res2.pipe(ws)
            ws.on('finish', resolve)
            ws.on('error', reject)
          }).on('error', reject)
          return
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`))
        const ws = fs.createWriteStream(tmpPath)
        res.pipe(ws)
        ws.on('finish', resolve)
        ws.on('error', reject)
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    })

    // Check file was written and has content
    const stat = fs.statSync(tmpPath)
    console.log(`[CHECK] Avatar downloaded: ${stat.size} bytes`)
    if (stat.size < 500) { // too small = probably error page
      fs.unlinkSync(tmpPath)
      return null
    }

    // Upload to R2
    const { uploadToR2 } = require('../../lib/r2')
    const r2Key = `avatars/${accountId}.jpg`
    await uploadToR2(tmpPath, r2Key)

    // Build public URL
    const publicUrl = process.env.R2_PUBLIC_URL
      ? `${process.env.R2_PUBLIC_URL.replace(/\/$/, '')}/${r2Key}`
      : r2Key

    // Cleanup tmp
    try { fs.unlinkSync(tmpPath) } catch {}

    return publicUrl
  } catch (err) {
    // Cleanup on error
    try { fs.unlinkSync(tmpPath) } catch {}
    throw err
  }
}

module.exports = checkHealthHandler
