const fs = require('fs');
const path = require('path');

const routePath = 'f:\\Work\\tools auto social\\socialflow\\api\\src\\routes\\campaigns.js';

if (fs.existsSync(routePath)) {
  const content = fs.readFileSync(routePath, 'utf8');
  const lines = content.split('\n');
  
  console.log('--- Search Results for update campaigns ---');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('status') && (lines[i].includes('active') || lines[i].includes('running') || lines[i].includes('paused'))) {
      console.log(`${i+1}: ${lines[i].trim()}`);
    }
  }
} else {
  console.log('Route file does not exist');
}
