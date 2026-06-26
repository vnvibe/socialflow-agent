const WebSocket = require('ws');

const prompt = process.argv.slice(2).join(' ');
if (!prompt) {
  console.log('Usage: node run_vps_oneshot.js <prompt>');
  process.exit(1);
}

(async () => {
  const url = 'wss://103.142.24.60/hermes-ws';
  console.log(`Connecting to WebSocket Bridge: ${url}`);
  console.log(`Sending oneshot prompt: "${prompt}"`);

  const ws = new WebSocket(url, {
    rejectUnauthorized: false,
    servername: '103-142-24-60.sslip.io',
    headers: {
      Host: '103-142-24-60.sslip.io'
    }
  });

  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'exec',
      args: ['-z', prompt, '--yolo']
    }));
  });

  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed.type === 'stdout' || parsed.type === 'stderr') {
        process.stdout.write(parsed.data);
      } else if (parsed.type === 'exit') {
        console.log(`\n[Process Exited with code ${parsed.code}]`);
        ws.close();
        process.exit(parsed.code);
      } else {
        console.log('\n[BRIDGE MESSAGE]:', parsed);
      }
    } catch (e) {
      console.log('\n[RAW]:', data.toString());
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket Error:', err.message);
    process.exit(1);
  });

  ws.on('close', () => {
    process.exit(0);
  });

  // Automatically close after 30 seconds
  setTimeout(() => {
    console.log('\nTiming out and closing...');
    ws.close();
    process.exit(0);
  }, 30000);
})();
