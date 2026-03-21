// Generate a simple PNG icon for the Electron app
// Run: node electron/create-icon.js

const fs = require('fs')
const path = require('path')

// Minimal 64x64 PNG with "SF" text (pre-generated base64)
// This is a simple blue gradient square with rounded corners
const iconBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABhGlDQ1BJQ0MgcHJvZmlsZQAAKJF9kT1Iw0AcxV9TpSoVBzuIOGSoThZERRy1CkWoEGqFVh1MLv2CJg1Jiouj4Fpw8GOx6uDirKuDqyAIfoA4OTopukiJ/0sKLWI8OO7Hu3ePu4DQqMBUsy8OqDptM1MJsRsblUMvCKEIAYQR5ZlpfMkKQ3P8XUPH1/vojzL+9yfI5C3GKAj0hPMsO0iTeIZzZtg/M+scisKMvE48TjBl2Q+JHrisZvnEsOCzwzauY5c8RisUtrxSszaqkZT5JHcpqqOK59Q8UzFuc1XKN1A6u5RbyhUpa8hcaWEnIkYCiGCEkUFFBGTZiNGqkWIjR+dMePuJxKcklk5MGBo4FVKSOHf+B/92axcnxLykUBwIvtv0xCgR2gVbNtr+Pbbt1AvifgSu97a/0gJlP0uttLXoE9G0DF9dtTdkDLneAwSddMiRH8tMFCnn/eFFs/6k7BwNvbsV63x+gNkqK32VPgECewHiomi3OHdPd2//nmn39wOwxnK4SFdnEAAAAGYktHRAD/AP8A/6C9p5MAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAHdElNRQfpBA8CEi1fOjbpAAAAGXRFWHRDb21tZW50AENyZWF0ZWQgd2l0aCBHSU1QV4EOFwAAAkhJREFUeNrt2s1qFEEQB/D/7M7ufqxJjCEhCYh48uBBRPDkQfAZfAAF38Cn8ODJq+BFvHjRi6Bgov'

// Actually let's just create a very simple valid PNG programmatically
// 32x32 blue square
function createSimplePNG() {
  // Use a pre-made tiny valid PNG (16x16 blue square)
  const pngHex = '89504e470d0a1a0a0000000d49484452000000100000001008060000001ff3ff610000002549444154789c62601805a320006cfc3ffd9f816162606060606060e0ff0c0c0c0c0c0ccc000058010a01f4e4f1d80000000049454e44ae426082'
  return Buffer.from(pngHex, 'hex')
}

const iconPath = path.join(__dirname, 'icon.png')
fs.writeFileSync(iconPath, createSimplePNG())
console.log(`Icon created at ${iconPath}`)
