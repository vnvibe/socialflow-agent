const { execSync } = require('child_process');
const path = require('path');
const os = require('os');

try {
  console.log('--- Cleaning up Zombie Chrome/Chromium Processes ---');
  const profileDir = path.join(os.homedir(), '.socialflow', 'profiles');
  console.log(`Looking for profiles in: ${profileDir}`);

  if (process.platform === 'win32') {
    const escaped = profileDir.replace(/\\/g, '\\\\');
    console.log(`Running PowerShell filter for: ${escaped}`);
    
    const result = execSync(
      `powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${escaped}*' } | Select-Object -ExpandProperty ProcessId"`,
      { encoding: 'utf8', timeout: 8000 }
    ).trim();

    const pids = result.split(/\r?\n/).map(s => s.trim()).filter(s => /^\d+$/.test(s));
    
    if (pids.length > 0) {
      console.log(`Found ${pids.length} zombie Chromium process(es): ${pids.join(', ')}`);
      for (const pid of pids) {
        try {
          execSync(`taskkill /F /PID ${pid}`, { timeout: 3000, stdio: 'ignore' });
          console.log(`  - Killed PID ${pid}`);
        } catch (e) {
          console.log(`  - Failed to kill PID ${pid}: ${e.message}`);
        }
      }
    } else {
      console.log('No zombie Chromium processes found running.');
    }
  } else {
    try {
      execSync(`pkill -f "${profileDir}"`, { timeout: 5000 });
      console.log('Sent pkill command to Linux/macOS processes.');
    } catch {}
  }

  // Also clear general lock files in all profile subdirectories
  const fs = require('fs');
  if (fs.existsSync(profileDir)) {
    const dirs = fs.readdirSync(profileDir);
    for (const dirName of dirs) {
      const userDataDir = path.join(profileDir, dirName, 'browser-data');
      if (fs.existsSync(userDataDir)) {
        const lockFiles = [
          path.join(userDataDir, 'SingletonLock'),
          path.join(userDataDir, 'SingletonCookie'),
          path.join(userDataDir, 'SingletonSocket'),
          path.join(userDataDir, 'lockfile'),
          path.join(userDataDir, 'Default', 'LOCK'),
        ];
        for (const file of lockFiles) {
          if (fs.existsSync(file)) {
            try {
              fs.unlinkSync(file);
              console.log(`Deleted lock file: ${file}`);
            } catch (err) {
              console.warn(`Could not delete lock file ${file}: ${err.message}`);
            }
          }
        }
      }
    }
  }

  console.log('Cleanup completed successfully!');

} catch (err) {
  console.error('Error during zombie cleanup:', err);
}
