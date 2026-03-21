const { launchBrowser, saveAndClose } = require('../../browser/launcher')

async function checkHealthHandler(payload, supabase) {
  const { account_id } = payload

  const { data: account } = await supabase
    .from('accounts')
    .select('*, proxies(*)')
    .eq('id', account_id)
    .single()

  if (!account) throw new Error('Account not found')

  const proxy = account.proxies ? {
    type: account.proxies.type || 'http',
    host: account.proxies.host,
    port: account.proxies.port,
    username: account.proxies.username,
    password: account.proxies.password
  } : null

  let browser, context
  try {
    const session = await launchBrowser({ ...account, proxy })
    browser = session.browser
    context = session.context

    const page = await context.newPage()

    // Set cookies - must include secure:true for HTTPS and sameSite for cross-site
    const cookies = account.cookie_string.split(';').map(c => {
      const [name, ...rest] = c.trim().split('=')
      return name ? {
        name: name.trim(),
        value: rest.join('=').trim(),
        domain: '.facebook.com',
        path: '/',
        secure: true,
        sameSite: 'None'
      } : null
    }).filter(Boolean)
    await context.addCookies(cookies)
    console.log(`[CHECK] Loaded ${cookies.length} cookies`)

    // Navigate to Facebook
    console.log(`[CHECK] Opening Facebook for ${account.username || account_id}...`)
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    // Wait for page to fully render (Facebook never reaches networkidle due to constant polling)
    await page.waitForTimeout(5000)

    const url = page.url()
    console.log(`[CHECK] Final URL: ${url}`)

    // Detect status using reliable indicators
    const result = await page.evaluate(() => {
      const src = document.documentElement.innerHTML

      // 1. Check if logged in via reliable JSON data
      const loggedInMatch = src.match(/"is_logged_in"\s*:\s*(true|false)/)
      const isLoggedIn = loggedInMatch ? loggedInMatch[1] === 'true' : null

      // 2. Check for USER_ID in page data (most reliable)
      const userIdMatch = src.match(/"USER_ID"\s*:\s*"(\d+)"/)
      const userId = userIdMatch ? userIdMatch[1] : null
      const hasUserId = userId && userId !== '0'

      // 3. Check URL-based indicators
      const currentUrl = window.location.href.toLowerCase()
      const urlPath = new URL(currentUrl).pathname
      const isCheckpointUrl = urlPath.includes('/checkpoint')
      const isLoginUrl = urlPath.includes('/login') || currentUrl.includes('login.php')

      // 4. Check for checkpoint-specific elements
      const checkpointForm = document.querySelector('form[action*="checkpoint"]')
      const securityCheck = document.querySelector('#checkpoint_title, [data-testid="checkpoint"]')

      // 5. Get fb_dtsg
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

      // 6. Get profile name - multiple strategies
      let name = null
      // From USER data in page source
      const nameMatch = src.match(/"NAME"\s*:\s*"([^"]+)"/)
      if (nameMatch) name = nameMatch[1]
      if (!name) {
        const shortNameMatch = src.match(/"shortName"\s*:\s*"([^"]+)"/)
        if (shortNameMatch) name = shortNameMatch[1]
      }
      // From profile link
      if (!name) {
        const links = document.querySelectorAll('a[href]')
        for (const link of links) {
          const href = link.getAttribute('href')
          if (href && (href.includes('/me') || (userId && href.includes(`/${userId}`)))) {
            const text = link.textContent?.trim()
            if (text && text.length > 1 && text.length < 50 && !text.includes('\n')) {
              name = text
              break
            }
          }
        }
      }
      // From userInfoData
      if (!name) {
        const m = src.match(/"userInfoFieldName"\s*:\s*"([^"]+)"/)
        if (m) name = m[1]
      }

      // 7. Get profile picture
      let pic = null
      const picMatch = src.match(/"profilePicLarge"\s*:\s*\{\s*"uri"\s*:\s*"([^"]+)"/)
      if (picMatch) pic = picMatch[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/')
      if (!pic) {
        const picMatch2 = src.match(/"profilePic160"\s*:\s*\{\s*"uri"\s*:\s*"([^"]+)"/)
        if (picMatch2) pic = picMatch2[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/')
      }
      if (!pic) {
        const picMatch3 = src.match(/"profile_picture"\s*:\s*\{\s*"uri"\s*:\s*"([^"]+)"/)
        if (picMatch3) pic = picMatch3[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/')
      }
      // From navigation avatar
      if (!pic) {
        const svgImages = document.querySelectorAll('svg image')
        for (const img of svgImages) {
          const href = img.getAttribute('xlink:href') || img.getAttribute('href')
          if (href && href.includes('scontent')) {
            pic = href
            break
          }
        }
      }

      // Decode unicode in name
      if (name) {
        try {
          name = name.replace(/\\u[\dA-Fa-f]{4}/g, m => String.fromCharCode(parseInt(m.slice(2), 16)))
        } catch {}
      }

      return {
        isLoggedIn,
        hasUserId,
        userId,
        isCheckpointUrl,
        isLoginUrl,
        hasCheckpointForm: !!checkpointForm,
        hasSecurityCheck: !!securityCheck,
        dtsg,
        name,
        pic,
        title: document.title
      }
    })

    console.log(`[CHECK] Detection: loggedIn=${result.isLoggedIn}, userId=${result.hasUserId}, checkpoint=${result.isCheckpointUrl}, login=${result.isLoginUrl}`)
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
    } else if (result.hasUserId || result.isLoggedIn === true || result.dtsg) {
      status = 'healthy'
    }

    // Save storage state
    await saveAndClose(browser, context, session.storageFile)
    browser = null

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
    await supabase.from('accounts').update({
      status: 'unknown',
      last_checked_at: new Date()
    }).eq('id', account_id)

    console.error(`[CHECK] Error for ${account.username || account_id}:`, err.message)
    // Re-throw so poller marks job as 'failed' and can retry
    throw err
  } finally {
    if (browser) {
      try { await browser.close() } catch {}
    }
  }
}

module.exports = checkHealthHandler
