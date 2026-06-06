/**
 * Centralized randomization for human-like timing
 * ALL timing decisions go through here — no hardcoded values in handlers
 */

const rand = () => Math.random()

// Gaussian-ish random (sum of 3 uniforms / 3)
function gaussRandom(min, max) {
  const u = (rand() + rand() + rand()) / 3
  return min + u * (max - min)
}

function randInt(min, max) {
  return Math.floor(rand() * (max - min + 1)) + min
}

// base ± percentage jitter
function jitter(baseMs, pct = 0.3) {
  const variance = baseMs * pct
  return Math.round(baseMs + (rand() * 2 - 1) * variance)
}

// ─── Timing delays (returns ms) ──────────────────────────

// Between consecutive actions (scroll, click, etc)
function actionDelay() {
  return gaussRandom(1000, 3000)
}

// Between posts for same nick
function postCooldown(minMin = 20, maxMin = 30) {
  return Math.round(gaussRandom(minMin * 60000, maxMin * 60000))
}

// Nick start offset within a role (nick idx → ms delay)
function nickStagger(idx, baseSeconds = 60) {
  const base = idx * baseSeconds * 1000
  const j = rand() * 15 * 60000 // ±15 min jitter
  return base + j
}

// Delay between role A finishing → role B starting
function roleStagger(baseMinutes = 30) {
  return jitter(baseMinutes * 60000, 0.3)
}

// Page load wait
function pageLoadWait() {
  return gaussRandom(1500, 4000)
}

// ─── Action gaps (returns ms) ────────────────────────────

// Between friend requests: 45-90 seconds
function friendRequestGap() {
  return (45 + rand() * 45) * 60000 / 60
}

// Between group joins: 90-180 seconds
function joinGroupGap() {
  return (90 + rand() * 90) * 1000
}

// General action gap: 45-120 seconds
function actionGap() {
  return (45 + rand() * 75) * 1000
}

// ─── Counts (returns int) ────────────────────────────────

function batchSize(min = 3, max = 8) {
  return randInt(min, max)
}

function likeCount() { return randInt(10, 50) }
function commentCount() { return randInt(3, 15) }
function friendCount() { return randInt(4, 12) }

// ─── Human typing ────────────────────────────────────────

// Per-character delay: 50-180ms
function keyDelay() {
  return 50 + rand() * 130
}

// 5% chance to pause and "think": 500-1500ms
function thinkPause() {
  return rand() < 0.05 ? 500 + rand() * 1000 : 0
}

// Click position offset within element bounds
function clickOffset(box) {
  return {
    x: box.width * (0.3 + rand() * 0.4),
    y: box.height * (0.3 + rand() * 0.4)
  }
}

// ─── Sleep helpers ───────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function sleepJitter(baseMs, pct = 0.3) {
  return sleep(jitter(baseMs, pct))
}

function sleepRange(minMs, maxMs) {
  return sleep(gaussRandom(minMs, maxMs))
}

module.exports = {
  rand, gaussRandom, randInt, between: randInt, jitter,
  actionDelay, postCooldown, nickStagger, roleStagger, pageLoadWait,
  friendRequestGap, joinGroupGap, actionGap,
  batchSize, likeCount, commentCount, friendCount,
  keyDelay, thinkPause, clickOffset,
  sleep, sleepJitter, sleepRange,
}
