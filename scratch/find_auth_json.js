const fs = require('fs');
const path = require('path');
const os = require('os');

const possiblePaths = [
  path.join(os.homedir(), 'AppData', 'Roaming', 'socialflow-agent', 'auth.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'SocialFlow Agent', 'auth.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'SocialFlow', 'auth.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'socialflow', 'auth.json'),
  path.join(os.homedir(), '.socialflow', 'auth.json'),
];

console.log('Searching for auth.json in AppData...');
for (const p of possiblePaths) {
  if (fs.existsSync(p)) {
    console.log(`Found auth.json at: ${p}`);
    const content = fs.readFileSync(p, 'utf8');
    try {
      const parsed = JSON.parse(content);
      console.log('Email:', parsed.email);
      console.log('User ID:', parsed.id || parsed.user?.id);
      console.log('Token snippet:', (parsed.access_token || parsed.token)?.slice(0, 30) + '...');
      // Export to a temporary file or just print
    } catch (e) {
      console.log('Error parsing file:', e.message);
    }
  } else {
    console.log(`Not found: ${p}`);
  }
}
