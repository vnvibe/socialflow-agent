const fs = require('fs');

const filepath = 'f:\\Work\\tools auto social\\socialflow-agent\\jobs\\handlers\\campaign-nurture.js';
const content = fs.readFileSync(filepath, 'utf8');
const lines = content.split('\n');

console.log('--- Searching logic in campaign-nurture.js ---');
let found = 0;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i].toLowerCase();
  if (line.includes('opportunity') || line.includes('eval') || line.includes('potential') || line.includes('hermes') || line.includes('predict')) {
    console.log(`${i+1}: ${lines[i].trim().slice(0, 120)}`);
    found++;
    if (found > 50) {
      console.log('Truncated...');
      break;
    }
  }
}
