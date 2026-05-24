/**
 * Standalone DOM test — opens Việt's browser profile, navigates to a group,
 * tests scrape/click/type strategies, prints detailed stdout. No Electron,
 * no agent, no Hermes calls — comment text is hardcoded for safety.
 *
 * Usage:  node test-comment.js [groupUrl]
 *
 * Default group: Claude Code & OpenClaw & Vibe Coding (Việt's, skips=0)
 */

const { chromium } = require('playwright')
const path = require('path')
const os = require('os')
const fs = require('fs')

const NICK_ID = '2cdd5c69-6ba1-461a-8709-60644c64d4a0'  // Việt
const GROUP_URL = process.argv[2] || 'https://www.facebook.com/groups/2753636021674871'
const TEST_COMMENT = 'Hay quá cảm ơn bạn chia sẻ!'  // template, no Hermes

const log = (...a) => console.log('[TEST]', ...a)

;(async () => {
  const userDataDir = path.join(os.homedir(), '.socialflow', 'profiles', NICK_ID, 'browser-data')
  if (!fs.existsSync(userDataDir)) {
    log('FATAL: profile dir not found:', userDataDir)
    process.exit(1)
  }
  log('userDataDir:', userDataDir)
  log('Group URL:', GROUP_URL)

  // Clear stale lock
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(userDataDir, f)) } catch {}
  }

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1366, height: 768 },
    locale: 'vi-VN',
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-notifications'],
  })
  log('Browser launched')

  let page = context.pages()[0]
  if (!page) page = await context.newPage()
  if (page.url() === 'about:blank') {
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)
  }

  log('Current URL:', page.url())
  log('Navigating to group...')
  await page.goto(GROUP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
  log('Initial wait 8s for FB lazy-load...')
  await page.waitForTimeout(8000)

  log('Scrolling to load feed...')
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 500)
    await page.waitForTimeout(1500)
  }
  await page.waitForTimeout(2000)

  // ── DIAG: count selectors ──
  const counts = await page.evaluate(() => ({
    role_article: document.querySelectorAll('[role="article"]').length,
    story_message: document.querySelectorAll('[data-ad-rendering-role="story_message"]').length,
    like_button_modern: document.querySelectorAll('[data-ad-rendering-role="like_button"]').length,
    comment_button_modern: document.querySelectorAll('[data-ad-rendering-role="comment_button"]').length,
    share_button_modern: document.querySelectorAll('[data-ad-rendering-role="share_button"]').length,
    aria_thich: document.querySelectorAll('[aria-label="Thích"][role="button"]').length,
    aria_viet_binhluan: document.querySelectorAll('[role="button"][aria-label*="Viết bình luận"]').length,
    aria_binhluan_input: document.querySelectorAll('[contenteditable="true"][role="textbox"][aria-label*="Bình luận"]').length,
    body_len: document.body.innerText.length,
    url: location.href,
  }))
  log('DOM counts:')
  for (const [k, v] of Object.entries(counts)) log(`  ${k} = ${v}`)

  // Save DOM snapshot to local file
  const dumpDir = path.join(os.homedir(), '.socialflow', 'test-dumps')
  fs.mkdirSync(dumpDir, { recursive: true })
  const ts = Date.now()
  await page.screenshot({ path: path.join(dumpDir, `test-${ts}.png`), fullPage: false })
  fs.writeFileSync(path.join(dumpDir, `test-${ts}.html`), await page.content())
  log(`Screenshot + HTML saved to ${dumpDir} (ts=${ts})`)

  if (counts.comment_button_modern === 0 && counts.aria_viet_binhluan === 0) {
    log('FAIL: no comment button found via either modern selector or aria-label.')
    log('Browser staying open. Inspect manually then Ctrl+C.')
    await new Promise(() => {}) // hang for inspection
    return
  }

  // ── Find first commentable post (upstream main strategy) ──
  // Strategy 1: walk up from story_message via .closest()
  // Strategy 2: feed-scoped aria-posinset / role=article / FeedUnit pagelet
  log('Locating first commentable post (upstream main strategy)...')
  const post = await page.evaluate(() => {
    const candidates = []
    const seen = new Set()

    // Strategy 1: walk up from story_message markers
    for (const marker of document.querySelectorAll('[data-ad-rendering-role="story_message"]')) {
      const wrap = marker.closest('div[role="article"], div[data-pagelet^="FeedUnit"], div[aria-posinset]')
        || marker.parentElement?.parentElement?.parentElement
      if (wrap && !seen.has(wrap)) { seen.add(wrap); candidates.push(wrap) }
    }

    // Strategy 2: feed-scoped articles with aria-posinset
    const feed = document.querySelector('div[role="feed"]')
    if (feed) {
      for (const el of feed.querySelectorAll('div[aria-posinset], div[role="article"], div[data-pagelet^="FeedUnit"]')) {
        if (!seen.has(el)) { seen.add(el); candidates.push(el) }
      }
    }

    if (candidates.length === 0) return { ok: false, reason: 'no candidates from either strategy' }

    // For each candidate, find comment button + extract metadata
    for (const wrap of candidates) {
      const cmtBtnInner = wrap.querySelector('[data-ad-rendering-role="comment_button"]')
      let cmtClickable = null
      if (cmtBtnInner) {
        cmtClickable = cmtBtnInner.closest('[role="button"]') || cmtBtnInner
      } else {
        // Fallback: aria-label search
        for (const b of wrap.querySelectorAll('[role="button"]')) {
          const lab = (b.getAttribute('aria-label') || '').toLowerCase()
          if (lab.includes('bình luận') || lab.includes('comment')) { cmtClickable = b; break }
        }
      }
      if (!cmtClickable) continue

      cmtClickable.setAttribute('data-test-cmt', '1')
      const bodyEl = wrap.querySelector('[data-ad-rendering-role="story_message"], [data-ad-preview="message"], [data-ad-comet-preview="message"]')
      const body = bodyEl?.innerText?.trim() || ''
      const author = (wrap.querySelector('h2 a strong, h3 a strong, h2 a, h3 a, strong a')?.textContent || '').trim()
      return {
        ok: true,
        candidates_count: candidates.length,
        body: body.substring(0, 200),
        author,
        cmtBtnLabel: cmtClickable.getAttribute('aria-label'),
        wrap_aria_posinset: wrap.getAttribute('aria-posinset'),
        wrap_pagelet: wrap.getAttribute('data-pagelet'),
        wrap_role: wrap.getAttribute('role'),
      }
    }
    return { ok: false, reason: 'no candidate had comment button', candidates_count: candidates.length }
  })
  log('First post:', JSON.stringify(post, null, 2))

  if (!post.ok) {
    log('Browser staying open for inspection.')
    await new Promise(() => {})
    return
  }

  // ── Click comment button ──
  log('Clicking comment button...')
  const clickResult = await page.evaluate(() => {
    const btn = document.querySelector('[data-test-cmt="1"]')
    if (!btn) return { ok: false }
    btn.scrollIntoView({ block: 'center' })
    const rect = btn.getBoundingClientRect()
    const opts = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }
    btn.dispatchEvent(new MouseEvent('mousedown', opts))
    btn.dispatchEvent(new MouseEvent('mouseup', opts))
    btn.dispatchEvent(new MouseEvent('click', opts))
    return { ok: true }
  })
  log('Click result:', clickResult)
  await page.waitForTimeout(2500)

  // ── Find comment input ──
  log('Looking for comment input...')
  const inputInfo = await page.evaluate(() => {
    const sels = [
      '[contenteditable="true"][role="textbox"][aria-label*="Bình luận"]',
      '[contenteditable="true"][role="textbox"][aria-label*="comment" i]',
      '[contenteditable="true"][role="textbox"][data-lexical-editor="true"]',
      '[contenteditable="true"][role="textbox"]',
    ]
    for (const sel of sels) {
      const el = document.querySelector(sel)
      if (el) {
        const rect = el.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          el.setAttribute('data-test-input', '1')
          return { ok: true, sel, label: el.getAttribute('aria-label') }
        }
      }
    }
    return { ok: false }
  })
  log('Input found:', JSON.stringify(inputInfo))

  if (!inputInfo.ok) {
    log('FAIL: no input. Browser open for inspection.')
    await new Promise(() => {})
    return
  }

  // ── Type comment ──
  // FB opens modal on image-post comment-click; modal image intercepts
  // pointer-events on input. Use focus() via evaluate (skip pointer check).
  log('Focusing input via evaluate (bypass pointer intercept)...')
  await page.evaluate(() => {
    const el = document.querySelector('[data-test-input="1"]')
    if (el) {
      el.scrollIntoView({ block: 'center' })
      el.focus()
      // Place cursor inside contenteditable
      const sel = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      sel.removeAllRanges()
      sel.addRange(range)
    }
  })
  await page.waitForTimeout(800)

  log('Typing test comment...')
  await page.keyboard.type(TEST_COMMENT, { delay: 80 })
  await page.waitForTimeout(2000)

  log('Pressing Enter to submit...')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(4000)

  // ── Verify ──
  const verify = await page.evaluate((expected) => {
    const el = document.querySelector('[data-test-input="1"]')
    const stillThere = !!el
    const content = el?.textContent || ''
    // Check if our comment appears in feed
    const inFeed = (document.body.innerText || '').includes(expected)
    return { stillThere, content, inFeed }
  }, TEST_COMMENT)
  log('Verify:', JSON.stringify(verify, null, 2))
  if (verify.inFeed) {
    log('✅ SUCCESS: comment appears in feed.')
  } else if (verify.content === '' || verify.content === '\n') {
    log('⚠️ Input cleared but comment not visible in feed yet (FB delay or filter).')
  } else {
    log('❌ Submit may have failed. Comment text still in input:', verify.content.substring(0, 100))
  }

  log('Done. Browser staying open for inspection. Ctrl+C to close.')
  await new Promise(() => {})
})().catch(e => {
  console.error('[TEST] FATAL:', e.stack || e.message)
  process.exit(1)
})
