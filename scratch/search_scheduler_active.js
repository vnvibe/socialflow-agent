const fs = require('fs');
const path = require('path');

const schedulerPath = 'f:\\Work\\tools auto social\\socialflow\\api\\src\\services\\nurture-scheduler.js';

if (fs.existsSync(schedulerPath)) {
  const content = fs.readFileSync(schedulerPath, 'utf8');
  const lines = content.split('\n');
  
  console.log('--- Search Results for "is_active" or "status" ---');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('is_active') || lines[i].includes('status')) {
      console.log(`${i+1}: ${lines[i].trim()}`);
    }
  }
} else {
  console.log('Scheduler file does not exist');
}
