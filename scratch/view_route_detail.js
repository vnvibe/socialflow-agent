const fs = require('fs');

const filepath = 'f:\\Work\\tools auto social\\socialflow\\api\\src\\routes\\campaigns.js';
const content = fs.readFileSync(filepath, 'utf8');
const lines = content.split('\n');

console.log('--- GET /campaigns/:id code ---');
for (let i = 445; i < 500; i++) {
  console.log(`${i+1}: ${lines[i]}`);
}
