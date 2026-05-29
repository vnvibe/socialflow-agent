const fs = require('fs');

const filepath = 'f:\\Work\\tools auto social\\socialflow\\api\\src\\routes\\ai-hermes.js';
const content = fs.readFileSync(filepath, 'utf8');
const lines = content.split('\n');

console.log('--- Lines in ai-hermes.js related to auth or comment ---');
let found = 0;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('comment') || lines[i].includes('key') || lines[i].includes('Key') || lines[i].includes('auth')) {
    console.log(`${i+1}: ${lines[i].trim().slice(0, 120)}`);
    found++;
    if (found > 30) break;
  }
}
