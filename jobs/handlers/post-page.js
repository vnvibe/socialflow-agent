/**
 * Post to Facebook Page handler
 * Dùng session pool + human simulation để tránh checkpoint
 */
const { getPage, releaseSession } = require('../../browser/session-pool')
const { delay, humanBrowse, humanMouseMove } = require('../../browser/human')
const { downloadFromR2, getSignedUrlForDownload } = require('../../lib/r2')
const axios = require('axios')
const {
  checkAccountStatus, openComposer, typeCaption,
  uploadMedia, submitPost, savePublishHistory,
  updateAccountStats, saveDebugScreenshot,
  ensureDailyReset, checkDailyLimit,
  setupPostIdInterceptor, getInterceptedPostId,
  ensureNotCancelled,
} = require('./post-utils')

async function clickPageSwitches(page) {
  // Handles multiple possible "Switch" buttons to enter page mode
  const switchSelectors = [
    '[role="button"]:has-text("Chuyển")',
    '[role="button"]:has-text("Chuyển ngay")',
    '[role="button"]:has-text("Switch")',
    'text=Chuyển sang Trang',
    'text=Switch to Page',
  ]

  for (const selector of switchSelectors) {
    try {
      const btn = page.locator(selector).first()
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await btn.scrollIntoViewIfNeeded().catch(() => {})
        await btn.click({ delay: 80 })
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
        console.log(`[POST-PAGE] Clicked switch button: ${selector}`)
      }
    } catch {}
  }
}

async function postPageHandler(payload, supabase) {
  const { content_id, target_id, account_id, campaign_id, spin_mode } = payload

  // Fetch data
  const [{ data: content }, { data: account }, { data: page }] = await Promise.all([
    supabase.from('contents').select('*, media(*)').eq('id', content_id).single(),
    supabase.from('accounts').select('*, proxies(*)').eq('id', account_id).single(),
    supabase.from('fanpages').select('*').eq('id', target_id).single(),
  ])

  if (!content || !account || !page) throw new Error('Missing content, account or page')

  // Daily limit check
  await ensureDailyReset(supabase, account)
  checkDailyLimit(account)

  // Prepare caption (apply spin if needed)
  let caption = content.caption || ''
  if (spin_mode === 'basic' && content.spin_template) {
    // Basic spintax: {option1|option2|option3} → pick random
    caption = content.spin_template.replace(/\{([^}]+)\}/g, (_, opts) => {
      const options = opts.split('|')
      return options[Math.floor(Math.random() * options.length)]
    })
  }

  // Append hashtags
  if (content.hashtags?.length) {
    caption += '\n\n' + content.hashtags.map(h => h.startsWith('#') ? h : `#${h}`).join(' ')
  }

  // =========================================================================
  // COOKIE/BROWSER POSTING ONLY (post_page job type)
  // Graph API posting is handled by post-page-graph.js (post_page_graph job type)
  // =========================================================================
  let browserPage
  try {
    // Get page from session pool (reuse browser)
    const session = await getPage(account)
    browserPage = session.page

    console.log(`[POST-PAGE] Posting to page: ${page.name} (${page.fb_page_id})`)

    // Navigate to page
    await browserPage.goto(`https://www.facebook.com/${page.fb_page_id}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
    await delay(3000, 5000)

    // Check checkpoint
    const status = await checkAccountStatus(browserPage, supabase, account_id)
    if (status.blocked) {
      await savePublishHistory(supabase, {
        job_id: payload.job_id, content_id, account_id,
        target_type: 'page', target_fb_id: page.fb_page_id,
        target_name: page.name, status: 'failed',
        error_message: status.detail, campaign_id,
      })
      throw new Error(`Account blocked: ${status.detail}`)
    }

    // Handle profile switch dialog if user is acting as themselves instead of the Page
    try {
      console.log(`[POST-PAGE] Looking for profile switch prompts...`)
      let switched = false

      // METHOD 1: Generic Facebook switch banner/button on the page
      // Use multiple resilient locator strategies to combat Facebook's DOM nested spans and whitespaces
      const switchLocators = [
        browserPage.getByRole('button', { name: 'Chuyển', exact: true }),
        browserPage.getByRole('button', { name: 'Switch', exact: true }),
        browserPage.locator('div[role="button"], button').filter({ hasText: /^\s*(Chuyển|Chuyển ngay|Switch|Switch now)\s*$/i })
      ]

      for (const locator of switchLocators) {
        const btn = locator.first()
        if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
          console.log(`[POST-PAGE] Found primary profile switch button for page, clicking...`)
          // Facebook triggers a full page reload or soft-navigation when switching profiles
          await Promise.all([
            btn.click(),
            browserPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
          ])
          switched = true
          break
        }
      }

      // METHOD 2: Fallback to Top-Right Account Menu switcher if Method 1 fails or button missing
      if (!switched) {
        console.log(`[POST-PAGE] Primary switch button not found or failed, attempting Account Menu fallback...`)
        
        // 1. Click Profile icon in top right
        const accountMenuBtn = browserPage.locator('div[role="button"][aria-label="Tài khoản"], div[role="button"][aria-label="Account"], svg[aria-label="Tài khoản"], svg[aria-label="Account"]').first()
        if (await accountMenuBtn.isVisible({ timeout: 3000 })) {
          await accountMenuBtn.click()
          await delay(2000, 3000)
          
          // 2. Look for "Xem tất cả trang cá nhân" / "See all profiles" button
          const seeAllBtn = browserPage.locator('div[role="button"], span').filter({
            hasText: /(Xem tất cả trang cá nhân|See all profiles)/i
          }).first()
          
          if (await seeAllBtn.isVisible({ timeout: 3000 })) {
            await seeAllBtn.click()
            await delay(2000, 3000)
          }

          // 3. Click the specific Page name in the list
          const pageSelectorBtn = browserPage.locator(`div[role="button"], div[role="radio"], span`).filter({
             hasText: new RegExp(`^${page.name}$`, 'i') // exact match for page name
          }).first()

          if (await pageSelectorBtn.isVisible({ timeout: 3000 })) {
             console.log(`[POST-PAGE] Found page ${page.name} in account menu, switching...`)
             await Promise.all([
               pageSelectorBtn.click(),
               browserPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
             ])
             switched = true
          } else {
             console.log(`[POST-PAGE] Could not find page name in account menu either. Clicking away...`)
             await browserPage.mouse.click(10, 10) // Click away to close menu
          }
        }
      }

      if (switched) {
        console.log(`[POST-PAGE] Profile Switched successfully! Waiting for new UI to settle...`)
        await delay(3000, 5000)
      } else {
        console.log(`[POST-PAGE] No profile switch logic succeeded. Assuming already act as Page or cannot switch.`)
      }

    } catch (e) {
      console.log(`[POST-PAGE] Error during profile switch fallback logic:`, e.message)
    }

    // Detect management UI redirect ("Quản lý trang" / Page Management)
    const isManagementUI = await browserPage.evaluate(() => {
      const text = (document.body?.innerText || '').substring(0, 5000)
      const url = window.location.href
      return (
        /quản lý trang|page management|manage your page/i.test(text) ||
        url.includes('/manage') ||
        url.includes('/settings') ||
        // New Pages Experience: sidebar with management options
        !!document.querySelector('[aria-label="Page management"]') ||
        !!document.querySelector('[data-pagelet="page_actions"]')
      )
    })

    if (isManagementUI) {
      console.log('[POST-PAGE] Detected management UI, trying to find feed/composer...')

      // Strategy 1: Try scrolling down to find feed & composer in management UI
      await browserPage.mouse.wheel(0, 800)
      await delay(1500, 2500)

      // Strategy 2: If no composer found, try switching to page timeline view
      const hasComposer = await browserPage.locator('[contenteditable="true"]').first()
        .isVisible({ timeout: 3000 }).catch(() => false)

      if (!hasComposer) {
        console.log('[POST-PAGE] No composer in management UI, switching to page timeline...')
        // Try public page URL variants
        const pageUrls = [
          `https://www.facebook.com/profile.php?id=${page.fb_page_id}`,
          `https://www.facebook.com/${page.fb_page_id}/?sk=wall`,
        ]
        for (const url of pageUrls) {
          try {
            await browserPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
            await delay(2000, 4000)
            const found = await browserPage.locator('[contenteditable="true"]').first()
              .isVisible({ timeout: 5000 }).catch(() => false)
            if (found) {
              console.log(`[POST-PAGE] Found composer at: ${url}`)
              break
            }
          } catch {}
        }
      }
    }

    // Debug: log current URL and save screenshot before composer attempt
    const currentUrl = browserPage.url()
    console.log(`[POST-PAGE] Current URL before composer: ${currentUrl}`)
    await saveDebugScreenshot(browserPage, `post-page-precomposer-${account_id}`)

    await ensureNotCancelled(payload.job_id, supabase, 'before composer')

    // Extra: click any visible page-switch buttons before composer
    await clickPageSwitches(browserPage)

    // Handle page switch confirmation dialog if present
    try {
      const switchDialog = browserPage.getByRole('dialog').filter({ hasText: /Chuyển trang cá nhân|Switch profile/i })
      const confirmBtn = switchDialog.getByRole('button', { name: /Chuyển|Switch/i })
      if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('[POST-PAGE] Found profile switch confirmation dialog, confirming switch...')
        await Promise.all([
          confirmBtn.click(),
          browserPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
        ])
      }
    } catch (e) {
      console.log('[POST-PAGE] No confirmation dialog or error handling it:', e.message)
    }

    await ensureNotCancelled(payload.job_id, supabase, 'before openComposer')

    // Mở composer
    await openComposer(browserPage, 'page')

    // Type caption
    await typeCaption(browserPage, caption)

    // Upload media nếu có
    if (content.media) {
      await ensureNotCancelled(payload.job_id, supabase, 'before uploadMedia')
      const mediaUploaded = await uploadMedia(browserPage, content.media, supabase)
      if (!mediaUploaded) {
        console.log('[POST-PAGE] WARNING: Media upload failed — retrying once...')
        await delay(2000, 3000)
        const retry = await uploadMedia(browserPage, content.media, supabase)
        if (!retry) {
          throw new Error('Khong the tai anh/video len. Vui long thu lai.')
        }
      }
      await ensureNotCancelled(payload.job_id, supabase, 'after uploadMedia')
    }

    // Setup GraphQL interceptor BEFORE submit to capture post ID
    const interceptor = setupPostIdInterceptor(browserPage)

    // Submit post
    await ensureNotCancelled(payload.job_id, supabase, 'before submitPost')
    await submitPost(browserPage)
    await ensureNotCancelled(payload.job_id, supabase, 'after submitPost')

    // Wait & verify: let Facebook finish uploading/processing before closing
    await browserPage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})

    // Wait for composer dialog to close (success) or timeout
    const dialogLocator = browserPage.locator('[role="dialog"][aria-label*="Tạo bài viết" i], [role="dialog"][aria-label*="Create post" i]')
    const dialogClosed = await dialogLocator.waitFor({ state: 'detached', timeout: 30000 }).then(() => true).catch(() => false)
    if (!dialogClosed) {
      console.log('[POST-PAGE] Composer still open after submit; keeping page a bit longer')
    }

    // Extra human-like wait to avoid checkpoint sensitivity
    await delay(5000, 10000)
    await ensureNotCancelled(payload.job_id, supabase, 'post-submit wait')

    // Capture fb_post_id from GraphQL response (with DOM fallback)
    const fbPostId = await getInterceptedPostId(browserPage, interceptor, 10000)
    if (fbPostId) console.log(`[POST-PAGE] Captured fb_post_id: ${fbPostId}`)
    else console.log('[POST-PAGE] WARNING: Could not capture fb_post_id')

    // Save success to publish_history
    await savePublishHistory(supabase, {
      job_id: payload.job_id, content_id, account_id,
      target_type: 'page', target_fb_id: page.fb_page_id,
      target_name: page.name, caption, status: 'success',
      campaign_id, fb_post_id: fbPostId,
    })

    // Update account stats
    await updateAccountStats(supabase, account_id, account)

    // Update page last_posted_at
    await supabase.from('fanpages').update({
      last_posted_at: new Date(),
    }).eq('id', target_id)

    const postUrl = fbPostId ? `https://www.facebook.com/${fbPostId}` : null
    console.log(`[POST-PAGE] Success! Posted to ${page.name}${postUrl ? ` → ${postUrl}` : ''}`)
    return { success: true, page_name: page.name, post_url: postUrl, fb_post_id: fbPostId }

  } catch (err) {
    console.error(`[POST-PAGE] Error posting to ${page?.name}: ${err.message}`)

    // Save debug screenshot (guard in case helper unavailable)
    if (browserPage && typeof saveDebugScreenshot === 'function') {
      await saveDebugScreenshot(browserPage, `post-page-error-${account_id}`)
    }

    // Save failure to publish_history (only if not already saved by checkpoint check)
    if (!err.message.includes('Account blocked')) {
      await savePublishHistory(supabase, {
        job_id: payload.job_id, content_id, account_id,
        target_type: 'page', target_fb_id: page?.fb_page_id,
        target_name: page?.name, status: 'failed',
        error_message: err.message, campaign_id,
      })
    }

    throw err
  } finally {
    // Close tab but keep browser open
    if (browserPage) await browserPage.close().catch(() => {})
    releaseSession(account_id)
  }
}

module.exports = postPageHandler
