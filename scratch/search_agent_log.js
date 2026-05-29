const fs = require('fs');
const path = require('path');

const logPath = 'C:\\Users\\1phut\\.gemini\\antigravity\\brain\\d6ef9256-cd1f-43f7-bed0-ec546c579f7d\\.system_generated\\tasks\\task-4519.log';

if (fs.existsSync(logPath)) {
  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.split('\n');
  
  console.log('--- Search Results for "Pre-log" or "Failed" or "Comment" ---');
  for (const line of lines) {
    if (line.includes('Pre-log') || line.includes('Commented') || line.includes('Flush failed') || line.includes('Database')) {
      console.log(line);
    }
  }
} else {
  console.log('Log file does not exist');
}
