const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('Usage: node find_in_files.js <search_dir> <query>');
  process.exit(1);
}

const searchDir = args[0];
const query = args[1].toLowerCase();

function walk(dir, callback) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filepath = path.join(dir, file);
    const stat = fs.statSync(filepath);
    if (stat.isDirectory()) {
      if (file !== 'node_modules' && file !== '.git' && file !== '.next' && file !== 'dist') {
        walk(filepath, callback);
      }
    } else {
      callback(filepath);
    }
  }
}

console.log(`Searching for "${query}" in ${searchDir}...`);
let matchCount = 0;

try {
  walk(searchDir, (filepath) => {
    if (filepath.endsWith('.js') || filepath.endsWith('.ts') || filepath.endsWith('.jsx') || filepath.endsWith('.tsx') || filepath.endsWith('.py') || filepath.endsWith('.json')) {
      const content = fs.readFileSync(filepath, 'utf8');
      if (content.toLowerCase().includes(query)) {
        console.log(`Found in: ${filepath}`);
        // Print matching lines
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(query)) {
            console.log(`  Line ${i+1}: ${lines[i].trim().slice(0, 120)}`);
          }
        }
        matchCount++;
        if (matchCount > 30) {
          console.log('Truncated after 30 files.');
          process.exit(0);
        }
      }
    }
  });
  console.log(`Search finished. Total files found: ${matchCount}`);
} catch (err) {
  console.error('Error during search:', err.message);
}
