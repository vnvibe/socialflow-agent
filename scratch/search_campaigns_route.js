const fs = require('fs');
const path = require('path');

const routePath = 'f:\\Work\\tools auto social\\socialflow\\api\\src\\routes\\campaigns.js';

if (fs.existsSync(routePath)) {
  const content = fs.readFileSync(routePath, 'utf8');
  const lines = content.split('\n');
  
  console.log('--- Search Results for "is_active" ---');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('is_active')) {
      console.log(`${i+1}: ${lines[i].trim()}`);
    }
  }
} else {
  console.log('Route file does not exist');
}
