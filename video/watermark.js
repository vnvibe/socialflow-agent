const POSITIONS = {
  topLeft: { x: '20', y: '20' },
  topRight: { x: 'W-tw-20', y: '20' },
  bottomLeft: { x: '20', y: 'H-th-20' },
  bottomRight: { x: 'W-tw-20', y: 'H-th-20' },
  center: { x: '(W-tw)/2', y: '(H-th)/2' }
}

function buildWatermarkFilter(config) {
  const pos = POSITIONS[config.position] || POSITIONS.bottomRight
  const opacity = config.opacity || 0.8
  const fontSize = config.fontSize || 22
  const fontColor = config.fontColor || 'white'

  if (config.type === 'image' && config.imagePath) {
    return { filter: 'overlay', options: `${pos.x}:${pos.y}`, input: config.imagePath }
  }

  return {
    filter: 'drawtext',
    options: `text='${config.text}':x=${pos.x}:y=${pos.y}:fontsize=${fontSize}:fontcolor=${fontColor}@${opacity}`
  }
}

module.exports = { buildWatermarkFilter, POSITIONS }
