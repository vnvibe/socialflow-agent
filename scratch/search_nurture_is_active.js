const fs = require('fs');
const path = require('path');

const nurturePath = 'f:\\Work\\tools auto social\\socialflow-agent\\jobs\\handlers\\campaign-nurture.js';

if (fs.existsSync(nurturePath)) {
  const content = fs.readFileSync(nurturePath, 'utf8');
  const lines = content.split('\n');
  
  console.log('--- Search Results for "is_active" or "active" ---');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('is_active') || lines[i].includes('active')) {
      console.log(`${i+1}: ${lines[i].trim()}`);
    }
  }
} else {
  console.log('Nurture handler file does not exist');
}
