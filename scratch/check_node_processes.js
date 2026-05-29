const { execSync } = require('child_process');

try {
  console.log('--- Scanning Node.js Processes ---');
  if (process.platform !== 'win32') {
    console.log('This script is tailored for Windows platforms.');
    process.exit(0);
  }

  const result = execSync(
    `powershell -Command "Get-CimInstance Win32_Process -Filter \\"Name = 'node.exe'\\" | Select-Object ProcessId, CommandLine | ConvertTo-Json"`,
    { encoding: 'utf8', timeout: 8000 }
  ).trim();

  if (!result || result === 'null') {
    console.log('No node.exe processes found.');
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

  console.log(`Total node processes found: ${processes.length}`);
  for (const proc of processes) {
    console.log(`PID: ${proc.ProcessId}`);
    console.log(`  CmdLine: ${proc.CommandLine}`);
    console.log('------------------------------------------');
  }

} catch (err) {
  console.error('Error running process scanner:', err);
}
