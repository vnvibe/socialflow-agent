/**
 * Shared posting utilities for post-page, post-group, post-profile handlers
 * Dùng session pool + human simulation để tránh checkpoint
 */
const { delay, humanClick, humanType, humanBrowse, humanMouseMove } = require('../../browser/human')
const { downloadFromR2 } = require('../../lib/r2')
const path = require('path')
const fs = require('fs')
const os = require('os')

// Cache R2 public URL (loaded from DB on first use)
let _r2PublicUrl = process.env.R2_PUBLIC_URL || null
let _r2PublicUrlLoaded = !!process.env.R2_PUBLIC_URL

async function getR2PublicUrl(supabase) {
  if (_r2PublicUrlLoaded) return _r2PublicUrl
  try {
    const { data } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'r2_storage')
      .single()
    let val = data?.value
    if (typeof val === 'string') try { val = JSON.parse(val) } catch {}
    _r2PublicUrl = val?.public_url || null
    console.log(`[POST] R2 public URL from DB: ${_r2PublicUrl || '(not set)'}`)
  } catch (e) {
    console.log(`[POST] Could not load R2 public URL from DB: ${e.message}`)
  }
  _r2PublicUrlLoaded = true
  return _r2PublicUrl
}

// ============================================================
// CHECK ACCOUNT STATUS - detect checkpoint/ban/session expired
// ============================================================
async function checkAccountStatus(page, supabase, account_id) {
  const { getBlockDetectionScript, reasonToStatus } = require('../../lib/block-detector')
  const status = await page.evaluate(getBlockDetectionScript())

  if (status.blocked) {
    console.log(`[POST] Account ${account_id} BLOCKED: ${status.reason} - ${status.detail}`)

    await supabase.from('accounts').update({
      status: reasonToStatus(status.reason),
    }).eq('id', account_id)

    // Save debug screenshot
    try {
      const debugDir = path.join(__dirname, '..', '..', 'debug')
      if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true })
      await page.screenshot({ path: path.join(debugDir, `post-blocked-${account_id}-${Date.now()}.png`), fullPage: false })
    } catch {}
  }

  return status
}

// ============================================================
// OPEN COMPOSER - try nhiều selectors cho composer button
// ============================================================

const PAGE_COMPOSER_SELECTORS = [
  // New Page management UI (Meta Business Suite style)
  '[aria-label="Create post"]',
  '[aria-label="Tạo bài viết"]',
  '[role="button"]:has-text("Create post")',
  '[role="button"]:has-text("Tạo bài viết")',
  // Classic page timeline
  '[data-pagelet="ProfileComposer"] [role="button"]',
  '[role="button"]:has-text("What\'s on your mind")',
  '[role="button"]:has-text("Bạn đang nghĩ gì")',
  // Generic text button
  'text=Bạn đang nghĩ gì?',
  // New Pages Experience - composer trigger in feed
  '[role="button"][aria-label*="post"]',
  '[role="button"][aria-label*="bài viết"]',
  // Generic text that might be on the composer placeholder
  'span:has-text("Viết gì đó cho")',
  'span:has-text("Write something")',
]

const GROUP_COMPOSER_SELECTORS = [
  '[role="button"]:has-text("Write something")',
  '[role="button"]:has-text("Viết gì đó")',
  '[role="button"]:has-text("Bạn viết gì đi")',
  '[role="button"]:has-text("What\'s on your mind")',
  '[role="button"]:has-text("Bạn đang nghĩ gì")',
  '[data-testid="post-composer-trigger"]',
  '[role="button"]:has-text("Create post")',
  '[role="button"]:has-text("Tạo bài viết")',
]

const PROFILE_COMPOSER_SELECTORS = [
  '[aria-label="Create a post"]',
  '[aria-label="Tạo bài viết"]',
  '[data-pagelet="ProfileComposer"] [role="button"]',
  '[role="button"]:has-text("What\'s on your mind")',
  '[role="button"]:has-text("Bạn đang nghĩ gì")',
  '[data-pagelet="Stories"] ~ div [role="button"]:has-text("What")',
]

async function openComposer(page, targetType) {
  const selectorsMap = {
    page: PAGE_COMPOSER_SELECTORS,
    group: GROUP_COMPOSER_SELECTORS,
    profile: PROFILE_COMPOSER_SELECTORS,
  }
  const selectors = selectorsMap[targetType] || PAGE_COMPOSER_SELECTORS

  // Helper: try all selectors once
  async function trySelectors() {
    for (const selector of selectors) {
      try {
        const el = page.locator(selector).first()
        const isVisible = await el.isVisible({ timeout: 2000 }).catch(() => false)
        if (isVisible) {
          const box = await el.boundingBox()
          if (box) {
            const x = box.x + box.width * (0.3 + Math.random() * 0.4)
            const y = box.y + box.height * (0.3 + Math.random() * 0.4)
            await page.mouse.move(x, y, { steps: Math.floor(Math.random() * 10) + 5 })
            await delay(200, 500)
            await page.mouse.click(x, y)
            await delay(1500, 3000)
            console.log(`[POST] Composer opened with: ${selector}`)
            return true
          }
        }
      } catch {}
    }

    // Text-based fallback
    const textPatterns = [/Bạn đang nghĩ gì/i, /Viết gì đó/i, /Bạn viết gì/i, /Write something/i, /What.*on your mind/i]
    for (const pat of textPatterns) {
      try {
        const textBtn = page.getByText(pat).first()
        if (await textBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
          await textBtn.click()
          await delay(1500, 3000)
          console.log(`[POST] Composer opened with text pattern: ${pat}`)
          return true
        }
      } catch {}
    }

    // Last resort: generic contenteditable
    try {
      const all = page.locator('[contenteditable="true"]')
      const count = await all.count()
      for (let i = 0; i < count; i++) {
        const el = all.nth(i)
        const isVisible = await el.isVisible({ timeout: 1500 }).catch(() => false)
        if (isVisible) {
          const box = await el.boundingBox().catch(() => null)
          if (box && box.width > 200 && box.height > 30) {
            await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 5 })
            await delay(200, 500)
            await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5)
            await delay(1000, 2000)
            console.log(`[POST] Composer opened with generic contenteditable #${i} (${Math.round(box.width)}x${Math.round(box.height)})`)
            return true
          }
        }
      }
    } catch {}

    return false
  }

  // Attempt 1: scroll to top and try
  await page.evaluate(() => window.scrollTo(0, 0))
  await delay(500, 1000)
  if (await trySelectors()) return true

  // Attempt 2: scroll down slowly to find composer (cover photo may push it off screen)
  console.log('[POST] Composer not found at top, scrolling down to find it...')
  for (let scrollY = 300; scrollY <= 1500; scrollY += 300) {
    await page.evaluate((y) => window.scrollTo(0, y), scrollY)
    await delay(800, 1200)
    if (await trySelectors()) return true
  }

  // Attempt 3: click on the "Thảo luận" / "Discussion" tab first (group-specific)
  if (targetType === 'group') {
    console.log('[POST] Trying Discussion tab to reveal composer...')
    const tabTexts = ['Thảo luận', 'Discussion', 'Bài viết', 'Posts']
    for (const txt of tabTexts) {
      try {
        const tab = page.getByRole('tab', { name: txt }).first()
        if (await tab.isVisible({ timeout: 1500 }).catch(() => false)) {
          await tab.click()
          await delay(2000, 3000)
          console.log(`[POST] Clicked tab: ${txt}`)
          // Scroll to top after tab switch
          await page.evaluate(() => window.scrollTo(0, 0))
          await delay(1000, 1500)
          if (await trySelectors()) return true
          // Scroll down again
          for (let scrollY = 300; scrollY <= 900; scrollY += 300) {
            await page.evaluate((y) => window.scrollTo(0, y), scrollY)
            await delay(800, 1200)
            if (await trySelectors()) return true
          }
          break
        }
      } catch {}
    }
    // Also try link-style tabs (not role=tab)
    for (const txt of tabTexts) {
      try {
        const link = page.getByText(txt, { exact: true }).first()
        if (await link.isVisible({ timeout: 1500 }).catch(() => false)) {
          await link.click()
          await delay(2000, 3000)
          console.log(`[POST] Clicked link tab: ${txt}`)
          await page.evaluate(() => window.scrollTo(0, 0))
          await delay(1000, 1500)
          if (await trySelectors()) return true
          break
        }
      } catch {}
    }
  }

  // Attempt 4 (group): Handle marketplace-style groups with "Chọn loại bài niêm yết" dialog
  if (targetType === 'group') {
    console.log('[POST] Checking for marketplace listing dialog...')
    try {
      // Check if the listing type dialog is visible
      const listingDialog = page.getByText(/Chọn loại bài niêm yết|Choose listing type|Tạo bài niêm yết mới|Create new listing/i).first()
      if (await listingDialog.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('[POST] Marketplace group detected — clicking "Mặt hàng cần bán"...')
        // Click first option: "Mặt hàng cần bán" / "Item for sale"
        const itemBtn = page.getByText(/Mặt hàng cần bán|Item for sale/i).first()
        if (await itemBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await itemBtn.click()
          await delay(2000, 3000)
          console.log('[POST] Clicked "Mặt hàng cần bán" — marketplace group requires listing form')
          // These groups need price, location etc — skip with clear error
          throw new Error('SKIP_MARKETPLACE: Group yêu cầu điền form niêm yết (giá, địa chỉ...), không hỗ trợ đăng tự động')
        }
        // If no item button, just skip
        throw new Error('SKIP_MARKETPLACE: Group mua bán yêu cầu chọn loại bài niêm yết, không hỗ trợ đăng tự động')
      }
    } catch (e) {
      if (e.message.startsWith('SKIP_MARKETPLACE')) throw e
    }

    // Also check: "Bạn bán gì?" / "Tạo bài niêm yết" buttons on the page (not in dialog)
    try {
      const sellTexts = [/Bạn bán gì/i, /What are you selling/i, /Tạo bài niêm yết/i, /Create listing/i]
      for (const pat of sellTexts) {
        const btn = page.getByText(pat).first()
        if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
          console.log(`[POST] Marketplace group detected (text: ${pat}) — skipping`)
          throw new Error('SKIP_MARKETPLACE: Group mua bán yêu cầu niêm yết, không hỗ trợ đăng tự động')
        }
      }
    } catch (e) {
      if (e.message.startsWith('SKIP_MARKETPLACE')) throw e
    }
  }

  // Save debug screenshot before failing
  try {
    const debugDir = path.join(__dirname, '..', '..', 'debug')
    if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true })
    await page.screenshot({ path: path.join(debugDir, `composer-not-found-${Date.now()}.png`), fullPage: true })
    console.log('[POST] Full-page screenshot saved for debugging')
  } catch {}

  throw new Error('Could not find composer button - all selectors failed')
}

// ============================================================
// TYPE CAPTION - type vào contenteditable trong dialog
// ============================================================
async function typeCaption(page, caption) {
  // Try multiple selectors for the composer text area
  const composerSelectors = [
    '[role="dialog"] [contenteditable="true"]',
    '[role="dialog"] [role="textbox"]',
    '[data-testid="post-composer-input"]',
    '[aria-label="Create a public post…"]',
    '[aria-label="Tạo bài viết công khai…"]',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"][data-lexical-editor="true"]',
  ]

  let textArea = null
  for (const selector of composerSelectors) {
    try {
      const el = page.locator(selector).first()
      const visible = await el.isVisible({ timeout: 3000 }).catch(() => false)
      if (visible) {
        textArea = el
        console.log(`[POST] Found text area with: ${selector}`)
        break
      }
    } catch {}
  }

  // Last fallback: any visible contenteditable
  if (!textArea) {
    const all = page.locator('[contenteditable="true"]')
    const count = await all.count()
    for (let i = 0; i < count; i++) {
      const el = all.nth(i)
      const visible = await el.isVisible().catch(() => false)
      if (visible) {
        const box = await el.boundingBox().catch(() => null)
        // Skip tiny elements (likely not a text area)
        if (box && box.width > 100 && box.height > 30) {
          textArea = el
          console.log(`[POST] Fallback: using contenteditable #${i} (${Math.round(box.width)}x${Math.round(box.height)})`)
          break
        }
      }
    }
  }

  if (!textArea) {
    throw new Error('Could not find composer text area - all selectors failed')
  }

  await delay(500, 1000)

  // Click vào text area trước
  const box = await textArea.boundingBox()
  if (box) {
    await page.mouse.click(
      box.x + box.width * 0.5,
      box.y + box.height * 0.5
    )
    await delay(300, 600)
  }

  // Type từng ký tự chậm như người thật
  for (const char of caption) {
    await page.keyboard.type(char)
    // Thay đổi tốc độ: nhanh hơn với space/newline, chậm hơn với ký tự thường
    if (char === ' ' || char === '\n') {
      await delay(30, 100)
    } else {
      await delay(40, 180)
    }

    // Pause ngẫu nhiên giả vờ suy nghĩ
    if (Math.random() < 0.03) {
      await delay(500, 1500)
    }
  }

  console.log(`[POST] Typed caption (${caption.length} chars)`)
  await delay(500, 1000)
}

// ============================================================
// UPLOAD MEDIA - download from R2 + upload via file input
// ============================================================
async function uploadMedia(page, media, supabase) {
  if (!media) return false

  // Ưu tiên: source_url (full URL) > processed_path > original_path
  const mediaPath = media.source_url || media.url || media.processed_path || media.original_path
  if (!mediaPath) {
    console.log('[POST] No media path found in:', JSON.stringify({ source_url: media.source_url, url: media.url, processed_path: media.processed_path, original_path: media.original_path }))
    return false
  }

  // Download from R2 to local temp
  const ext = mediaPath.match(/\.[^.]+$/)?.[0] || '.jpg'
  const tmpDir = path.join(os.tmpdir(), 'socialflow-uploads')
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })
  const localPath = path.join(tmpDir, `${media.id}_upload${ext}`)

  try {
    // Determine download URL
    let downloadUrl = mediaPath
    if (!mediaPath.startsWith('http://') && !mediaPath.startsWith('https://')) {
      // R2 key — convert to public URL
      const r2PublicUrl = supabase ? await getR2PublicUrl(supabase) : process.env.R2_PUBLIC_URL
      if (r2PublicUrl) {
        downloadUrl = `${r2PublicUrl.replace(/\/$/, '')}/${mediaPath}`
        console.log(`[POST] Built R2 public URL: ${downloadUrl}`)
      } else {
        // Fallback: try S3 SDK download
        console.log(`[POST] Downloading from R2 via SDK: ${mediaPath}`)
        try {
          await downloadFromR2(mediaPath, localPath)
          console.log(`[POST] Downloaded from R2 (${Math.round(fs.statSync(localPath).size / 1024)}KB)`)
          downloadUrl = null
        } catch (sdkErr) {
          console.log(`[POST] R2 SDK download failed: ${sdkErr.message}`)
          throw new Error(`Cannot download media: no R2_PUBLIC_URL configured and S3 SDK failed. Set R2_PUBLIC_URL env or add public_url to system_settings.r2_storage`)
        }
      }
    }

    if (downloadUrl) {
      console.log(`[POST] Downloading media: ${downloadUrl}`)
      const axios = require('axios')
      const response = await axios.get(downloadUrl, { responseType: 'arraybuffer', timeout: 60000 })
      fs.writeFileSync(localPath, Buffer.from(response.data))
      console.log(`[POST] Downloaded via HTTP (${Math.round(response.data.length / 1024)}KB)`)
    }

    // Tìm và click nút Photo/Video trước
    const photoVideoSelectors = [
      '[aria-label="Photo/video"]',
      '[aria-label="Ảnh/video"]',
      '[aria-label="Photo/Video"]',
      '[role="dialog"] [role="button"]:has-text("Photo")',
      '[role="dialog"] [role="button"]:has-text("Ảnh")',
    ]

    let clickedMediaBtn = false
    for (const selector of photoVideoSelectors) {
      try {
        const btn = page.locator(selector).first()
        const isVisible = await btn.isVisible({ timeout: 2000 }).catch(() => false)
        if (isVisible) {
          await btn.scrollIntoViewIfNeeded().catch(() => {})
          const box = await btn.boundingBox()
          if (box) {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 })
            await delay(200, 500)
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
            await delay(1000, 2000)
            console.log(`[POST] Clicked photo/video button: ${selector}`)
            clickedMediaBtn = true
            break
          }
        }
      } catch {}
    }

    // Fallback: click by text “Thêm ảnh/video”
    if (!clickedMediaBtn) {
      try {
        const textBtn = page.getByText(/Thêm ảnh\/video|Photo\/video/i).first()
        if (await textBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await textBtn.scrollIntoViewIfNeeded().catch(() => {})
          await textBtn.click({ delay: 100 })
          await delay(1000, 2000)
          console.log('[POST] Clicked media button by text fallback')
          clickedMediaBtn = true
        }
      } catch {}
    }

    // Upload file - try dialog-scoped first, then global
    const fileInput = page.locator('[role="dialog"] input[type="file"], input[type="file"][accept*="image"], input[type="file"][accept*="video"]').first()
    await fileInput.waitFor({ timeout: 10000 }).catch(() => {})

    // Fallback: try all file inputs
    const fileInputs = page.locator('input[type="file"]')
    const count = await fileInputs.count()
    let uploaded = false

    for (let i = 0; i < count; i++) {
      try {
        await fileInputs.nth(i).setInputFiles(localPath)
        uploaded = true
        console.log(`[POST] Media uploaded via file input #${i}`)
        break
      } catch {}
    }

    if (!uploaded) {
      console.log('[POST] WARNING: Could not upload media - no file input found')
      await saveDebugScreenshot(page, 'upload-media-failed').catch(() => {})
      return false
    }

    // Đợi upload hoàn tất
    await delay(3000, 6000)

    // Đợi thêm nếu video (processing)
    if (ext === '.mp4' || ext === '.mov' || ext === '.avi') {
      console.log('[POST] Video detected, waiting for processing...')
      await delay(5000, 10000)
    }

    return true
  } catch (err) {
    console.log(`[POST] Media upload failed: ${err.message}`)
    return false
  } finally {
    // Cleanup temp file
    try { fs.unlinkSync(localPath) } catch {}
  }
}

// ============================================================
// SUBMIT POST - click nút Post với nhiều fallback selectors
// ============================================================
const POST_BUTTON_SELECTORS = [
  // Dialog-scoped (classic composer)
  '[role="dialog"] [aria-label="Post"]',
  '[role="dialog"] [aria-label="Đăng"]',
  '[role="dialog"] button:has-text("Post")',
  '[role="dialog"] button:has-text("Đăng")',
  '[role="dialog"] [role="button"]:has-text("Post")',
  '[role="dialog"] [role="button"]:has-text("Đăng")',
  '[data-testid="post-button"]',
  // Non-dialog (management UI / inline composer)
  '[aria-label="Post"]',
  '[aria-label="Đăng"]',
  '[role="button"]:has-text("Post"):not([aria-label*="Create"])',
  '[role="button"]:has-text("Đăng"):not([aria-label*="Tạo"])',
  'button:has-text("Publish")',
  'button:has-text("Xuất bản")',
  '[role="button"]:has-text("Publish")',
  '[role="button"]:has-text("Xuất bản")',
]

async function submitPost(page) {
  await delay(1000, 2000)
  await humanMouseMove(page)

  for (const selector of POST_BUTTON_SELECTORS) {
    try {
      const btn = page.locator(selector).first()
      const isVisible = await btn.isVisible({ timeout: 2000 }).catch(() => false)
      if (isVisible) {
        const box = await btn.boundingBox()
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 })
          await delay(300, 600)
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
          console.log(`[POST] Clicked submit: ${selector}`)
          await delay(3000, 6000)
          return true
        }
      }
    } catch {}
  }

  throw new Error('Could not find Post button - all selectors failed')
}

// ============================================================
// SAVE PUBLISH HISTORY
// ============================================================
async function savePublishHistory(supabase, {
  job_id, content_id, account_id, target_type, target_fb_id,
  target_name, caption, status, error_message, campaign_id, fb_post_id
}) {
  // Construct post_url from fb_post_id
  let post_url = null
  if (fb_post_id) {
    if (target_type === 'group' && target_fb_id) {
      post_url = `https://www.facebook.com/groups/${target_fb_id}/posts/${fb_post_id}`
    } else {
      post_url = `https://www.facebook.com/${fb_post_id}`
    }
  }

  const { data } = await supabase.from('publish_history').insert({
    job_id,
    content_id,
    account_id,
    target_type,
    target_fb_id,
    target_name,
    final_caption: caption || null,
    status: status || 'success',
    published_at: status === 'success' ? new Date() : null,
    ...(error_message && { error_message }),
    ...(campaign_id && { campaign_id }),
    ...(fb_post_id && { fb_post_id }),
    ...(post_url && { post_url }),
  }).select().single()
  return data
}

// ============================================================
// INTERCEPT POST ID — setup GraphQL response listener BEFORE submit
// Call setupPostIdInterceptor() before submitPost(), then getInterceptedPostId() after
// ============================================================
function setupPostIdInterceptor(page) {
  const state = { postId: null, postUrl: null, handler: null }

  state.handler = async (response) => {
    try {
      const url = response.url()
      if (!url.includes('/api/graphql')) return
      if (response.status() !== 200) return
      const text = await response.text().catch(() => '')
      if (!text || text.length < 100) return

      // Look for post creation response patterns
      for (const line of text.split('\n')) {
        if (!line.trim().startsWith('{')) continue
        try {
          const json = JSON.parse(line)
          const id = findCreatedPostId(json)
          if (id) {
            state.postId = id
            console.log(`[POST] GraphQL intercepted post ID: ${id}`)
            break
          }
        } catch {}
      }
    } catch {}
  }

  page.on('response', state.handler)
  return state
}

function findCreatedPostId(obj, depth = 0) {
  if (!obj || depth > 12 || typeof obj !== 'object') return null

  // Pattern 1: story_create response (most common)
  if (obj.story?.id || obj.story?.post_id || obj.story?.legacy_story_id) {
    const id = obj.story.post_id || obj.story.legacy_story_id || obj.story.id
    const numId = extractNumericId(id)
    if (numId) return numId
  }

  // Pattern 2: Direct post creation result
  if (obj.post_id || obj.legacy_story_id) {
    const numId = extractNumericId(obj.post_id || obj.legacy_story_id)
    if (numId) return numId
  }

  // Pattern 3: composerPublishPost / story_publish mutations
  if (obj.data?.story_create?.story || obj.data?.composerPublishPost?.story) {
    const story = obj.data.story_create?.story || obj.data.composerPublishPost?.story
    const id = story.post_id || story.legacy_story_id || story.id
    const numId = extractNumericId(id)
    if (numId) return numId
  }

  // Pattern 4: node with feedback containing post id
  if (obj.id && obj.feedback && typeof obj.id === 'string') {
    const numId = extractNumericId(obj.id)
    if (numId) return numId
  }

  // Recurse into children
  const skip = new Set(['extensions', 'page_info', 'cursor', 'logging', 'tracking'])
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findCreatedPostId(item, depth + 1)
      if (found) return found
    }
  } else {
    for (const k of Object.keys(obj)) {
      if (skip.has(k)) continue
      if (typeof obj[k] === 'object') {
        const found = findCreatedPostId(obj[k], depth + 1)
        if (found) return found
      }
    }
  }
  return null
}

function extractNumericId(id) {
  if (!id) return null
  const str = String(id)
  // Already numeric
  if (/^\d{10,}$/.test(str)) return str
  // Base64 encoded (UzpfS...)
  if (str.startsWith('UzpfS') || str.length > 20) {
    try {
      const decoded = Buffer.from(str, 'base64').toString('utf8')
      const nums = decoded.match(/(\d{10,})/g)
      if (nums?.length > 0) return nums[nums.length - 1]
    } catch {}
  }
  // Colon-separated like "S:_I123:456"
  const colonMatch = str.match(/(\d{10,})/)
  if (colonMatch) return colonMatch[1]
  return null
}

async function getInterceptedPostId(page, state, timeoutMs = 8000) {
  // Wait a bit for the GraphQL response to arrive
  const start = Date.now()
  while (!state.postId && (Date.now() - start) < timeoutMs) {
    await new Promise(r => setTimeout(r, 500))
  }

  // Remove listener
  if (state.handler) {
    page.removeListener('response', state.handler)
  }

  // If interceptor got it, return
  if (state.postId) return state.postId

  // Fallback: check URL
  try {
    const url = page.url()
    const urlMatch = url.match(/\/posts\/(\d+)/) || url.match(/story_fbid=(\d+)/) || url.match(/permalink\/(\d+)/)
    if (urlMatch) return urlMatch[1]
  } catch {}

  // Fallback: DOM scan for newest post link
  try {
    const postId = await page.evaluate(() => {
      const postLinks = document.querySelectorAll('a[href*="/posts/"], a[href*="story_fbid="]')
      for (const link of postLinks) {
        const href = link.href || ''
        const m = href.match(/\/posts\/(\d+)/) || href.match(/story_fbid=(\d+)/)
        if (m) return m[1]
      }
      return null
    })
    return postId
  } catch {}

  return null
}

// Legacy wrapper for backward compat
async function extractFbPostId(page) {
  // Simple DOM-only fallback (used when interceptor wasn't set up)
  try {
    const url = page.url()
    const urlMatch = url.match(/\/posts\/(\d+)/) || url.match(/story_fbid=(\d+)/) || url.match(/permalink\/(\d+)/)
    if (urlMatch) return urlMatch[1]

    const postId = await page.evaluate(() => {
      const postLinks = document.querySelectorAll('a[href*="/posts/"], a[href*="story_fbid="]')
      for (const link of postLinks) {
        const href = link.href || ''
        const m = href.match(/\/posts\/(\d+)/) || href.match(/story_fbid=(\d+)/)
        if (m) return m[1]
      }
      return null
    })
    return postId
  } catch {
    return null
  }
}

// ============================================================
// UPDATE ACCOUNT STATS
// ============================================================
async function updateAccountStats(supabase, account_id, account) {
  await supabase.from('accounts').update({
    last_used_at: new Date(),
    posts_today: (account.posts_today || 0) + 1,
    total_posts: (account.total_posts || 0) + 1,
  }).eq('id', account_id)
}

// ============================================================
// SAVE DEBUG SCREENSHOT
// ============================================================
async function saveDebugScreenshot(page, prefix) {
  try {
    const debugDir = path.join(__dirname, '..', '..', 'debug')
    if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true })
    const filepath = path.join(debugDir, `${prefix}-${Date.now()}.png`)
    await page.screenshot({ path: filepath, fullPage: false })
    console.log(`[POST] Debug screenshot saved: ${filepath}`)
    return filepath
  } catch {
    return null
  }
}

// ============================================================
// DAILY RESET — reset posts_today nếu qua ngày mới (VN timezone)
// ============================================================
async function ensureDailyReset(supabase, account) {
  const now = new Date()
  // Tính ngày hiện tại theo timezone VN (UTC+7)
  const vnDate = new Date(now.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10)
  const resetDate = account.daily_reset_at
    ? new Date(new Date(account.daily_reset_at).getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10)
    : null

  if (!resetDate || resetDate !== vnDate) {
    console.log(`[POST] Daily reset: ${account.posts_today || 0} → 0 (new day: ${vnDate})`)
    await supabase.from('accounts').update({
      posts_today: 0,
      daily_reset_at: now.toISOString(),
    }).eq('id', account.id)
    account.posts_today = 0
  }
}

// ============================================================
// CHECK DAILY LIMIT — throw nếu vượt max_daily_posts
// ============================================================
function checkDailyLimit(account) {
  if (account.max_daily_posts && account.posts_today >= account.max_daily_posts) {
    throw new Error(`Daily post limit reached (${account.posts_today}/${account.max_daily_posts})`)
  }
}

// ============================================================
// CANCEL CHECK HELPER
// ============================================================
async function ensureNotCancelled(jobId, supabase, context = '') {
  if (!jobId) return
  const { data } = await supabase
    .from('jobs')
    .select('status')
    .eq('id', jobId)
    .single()
  if (data?.status === 'cancelled') {
    throw new Error(`Job cancelled ${context ? `during ${context}` : ''}`)
  }
}

module.exports = {
  checkAccountStatus,
  openComposer,
  typeCaption,
  uploadMedia,
  submitPost,
  savePublishHistory,
  updateAccountStats,
  ensureDailyReset,
  checkDailyLimit,
  extractFbPostId,
  setupPostIdInterceptor,
  getInterceptedPostId,
  ensureNotCancelled,
  delay,
  saveDebugScreenshot,
}
