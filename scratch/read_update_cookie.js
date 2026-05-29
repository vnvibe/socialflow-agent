const fs = require('fs');

const filepath = 'f:\\Work\\tools auto social\\socialflow\\api\\src\\routes\\accounts.js';
const content = fs.readFileSync(filepath, 'utf8');
const lines = content.split('\n');

console.log('--- POST /accounts/:id/update-cookie code ---');
for (let i = 1009; i < 1090; i++) {
  console.log(`${i+1}: ${lines[i]}`);
}
