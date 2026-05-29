const fs = require('fs');

const filepath = 'f:\\Work\\tools auto social\\socialflow\\frontend\\src\\pages\\agents\\AgentsRoster.jsx';
const content = fs.readFileSync(filepath, 'utf8');
const lines = content.split('\n');

console.log('--- Lines in AgentsRoster.jsx containing "cookie" or "health" ---');
let found = 0;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('cookie') || lines[i].includes('Cookie') || lines[i].includes('health') || lines[i].includes('Health')) {
    console.log(`${i+1}: ${lines[i].trim().slice(0, 120)}`);
    found++;
    if (found > 40) {
      console.log('Truncated...');
      break;
    }
  }
}
