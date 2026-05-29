const { execSync } = require('child_process');

try {
  console.log('--- Scanning and Killing Playwright Chrome Processes ---');
  if (process.platform !== 'win32') {
    console.log('This script is tailored for Windows platforms.');
    process.exit(0);
  }

  // Get all processes named chrome
  const result = execSync(
    `powershell -Command "Get-CimInstance Win32_Process -Filter \\"Name = 'chrome.exe'\\" | Select-Object ProcessId, CommandLine | ConvertTo-Json"`,
    { encoding: 'utf8', timeout: 8000 }
  ).trim();

  if (!result || result === 'null') {
    console.log('No chrome.exe processes found.');
    process.exit(0);
  }

  let processes = [];
  try {
    processes = JSON.parse(result);
    if (!Array.isArray(processes)) {
      processes = [processes];
    }
  } catch (parseErr) {
    console.error('Error parsing process list JSON:', parseErr.message);
    process.exit(1);
  }

  console.log(`Total chrome processes found: ${processes.length}`);
  let killed = 0;

  for (const proc of processes) {
    const pid = proc.ProcessId;
    const cmdLine = proc.CommandLine || '';

    // Check if the command line points to ms-playwright
    if (cmdLine.toLowerCase().includes('ms-playwright')) {
      console.log(`Killing Playwright Chrome (PID: ${pid})`);
      console.log(`  CmdLine: ${cmdLine.slice(0, 150)}...`);
      try {
        execSync(`taskkill /F /PID ${pid}`, { timeout: 3000, stdio: 'ignore' });
        killed++;
      } catch (killErr) {
        console.warn(`  Failed to kill PID ${pid}: ${killErr.message}`);
      }
    }
  }

  console.log(`\nSuccessfully killed ${killed} Playwright Chrome process(es).`);

} catch (err) {
  console.error('Error running process scanner:', err);
}
