/**
 * Human behavior simulation utilities
 * Giả lập hành vi người dùng thật để tránh bị Facebook checkpoint
 */

const delay = (min, max) => new Promise(r => setTimeout(r, Math.random() * (max - min) + min))

/**
 * Di chuột đến vị trí random trên viewport
 */
async function humanMouseMove(page) {
  const viewport = page.viewportSize() || { width: 1366, height: 768 }
  const x = Math.floor(Math.random() * (viewport.width - 100)) + 50
  const y = Math.floor(Math.random() * (viewport.height - 100)) + 50
  const steps = Math.floor(Math.random() * 15) + 5 // 5-20 steps for natural movement
  await page.mouse.move(x, y, { steps })
  await delay(200, 600)
}

/**
 * Scroll từng bước nhỏ như người thật (100-400px mỗi lần)
 */
async function humanScroll(page) {
  const scrollAmount = Math.floor(Math.random() * 300) + 100 // 100-400px
  await page.mouse.wheel(0, scrollAmount)
  await delay(800, 2000)
}

/**
 * Scroll đến cuối trang theo kiểu người thật - nhiều bước nhỏ thay vì jump
 */
async function humanScrollToBottom(page, { maxScrolls = 50, onScroll, onBeforeCheck } = {}) {
  let lastHeight = 0
  let scrollCount = 0
  let noChangeCount = 0
  const MAX_NO_CHANGE = 4 // đợi 4 rounds trước khi kết luận hết

  while (scrollCount < maxScrolls) {
    // Mỗi "round" scroll 3-6 lần nhỏ
    const smallScrolls = Math.floor(Math.random() * 4) + 3
    for (let i = 0; i < smallScrolls; i++) {
      await humanScroll(page)
      if (Math.random() < 0.3) {
        await humanMouseMove(page)
      }
    }

    scrollCount += smallScrolls

    // Callback TRƯỚC check height — cho phép caller detect data mới từ DOM / click load more
    // Trả về true nếu có data mới → reset no-change counter
    let externalNewData = false
    if (onBeforeCheck) {
      externalNewData = await onBeforeCheck(scrollCount)
    }

    // Check if page height changed
    const newHeight = await page.evaluate(() => document.body.scrollHeight)
    if (newHeight === lastHeight && !externalNewData) {
      noChangeCount++

      if (noChangeCount >= MAX_NO_CHANGE) break

      // Đợi lâu hơn mỗi lần không thấy content mới (FB load chậm)
      const waitTime = 3000 + noChangeCount * 2000 // 5s, 7s, 9s
      console.log(`[HUMAN] No new content (attempt ${noChangeCount}/${MAX_NO_CHANGE}), waiting ${waitTime}ms...`)
      await delay(waitTime, waitTime + 2000)

      // Scroll ngược lên 1 chút rồi xuống lại - trick để trigger lazy load
      if (noChangeCount >= 2) {
        await page.evaluate(() => window.scrollBy(0, -800))
        await delay(1000, 2000)
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await delay(2000, 3000)
      }
    } else {
      noChangeCount = 0
      lastHeight = newHeight
    }

    if (onScroll) await onScroll(scrollCount)

    // Giả lập dừng đọc mỗi vài lần scroll
    if (Math.random() < 0.15) {
      await delay(2000, 4000)
      await humanMouseMove(page)
    }
  }

  console.log(`[HUMAN] Scrolled ${scrollCount} times, final height: ${lastHeight}px`)
  return scrollCount
}

/**
 * Click vào element với mouse move tự nhiên
 */
async function humanClick(page, selectorOrElement) {
  // Accept both CSS selector string OR ElementHandle directly
  const el = typeof selectorOrElement === 'string'
    ? await page.$(selectorOrElement)
    : selectorOrElement
  if (!el) return false

  const box = await el.boundingBox()
  if (!box) return false

  // Random offset within element (không click chính giữa)
  const x = box.x + box.width * (0.2 + Math.random() * 0.6)
  const y = box.y + box.height * (0.2 + Math.random() * 0.6)

  // Move đến gần element trước
  const steps = Math.floor(Math.random() * 10) + 5
  await page.mouse.move(x, y, { steps })
  await delay(100, 300)
  await page.mouse.click(x, y)
  await delay(300, 800)
  return true
}

/**
 * Giả lập browse trang - combo mouse move + scroll + pause
 * @param {number} seconds - thời gian browse (giây)
 */
async function humanBrowse(page, seconds = 5) {
  const endTime = Date.now() + seconds * 1000
  while (Date.now() < endTime) {
    const action = Math.random()
    if (action < 0.4) {
      await humanScroll(page)
    } else if (action < 0.7) {
      await humanMouseMove(page)
    } else {
      await delay(1000, 3000) // pause "đọc"
    }
  }
}

/**
 * Type text chậm từng ký tự
 */
async function humanType(page, selector, text) {
  await humanClick(page, selector)
  await delay(300, 700)
  for (const char of text) {
    await page.keyboard.type(char)
    await delay(40, 180)
  }
}

module.exports = {
  delay,
  humanMouseMove,
  humanScroll,
  humanScrollToBottom,
  humanClick,
  humanBrowse,
  humanType,
}
