const fs = require('fs');

const filepath = 'f:\\Work\\tools auto social\\socialflow\\api\\src\\routes\\campaigns.js';
const content = fs.readFileSync(filepath, 'utf8');
const lines = content.split('\n');

console.log('--- Lines containing "/:id" ---');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('/:id')) {
    console.log(`${i+1}: ${lines[i].trim()}`);
  }
}
