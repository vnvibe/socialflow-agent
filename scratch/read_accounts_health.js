const fs = require('fs');

const filepath = 'f:\\Work\\tools auto social\\socialflow\\api\\src\\routes\\accounts.js';
const content = fs.readFileSync(filepath, 'utf8');
const lines = content.split('\n');

console.log('--- Lines in accounts.js containing health or check ---');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].toLowerCase().includes('health') || lines[i].toLowerCase().includes('check_health') || lines[i].toLowerCase().includes('verify')) {
    console.log(`${i+1}: ${lines[i].trim().slice(0, 120)}`);
  }
}
