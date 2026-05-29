const WebSocket = require('ws');

(async () => {
  const url = 'wss://103-142-24-60.sslip.io/hermes-ws';
  console.log(`Connecting to WebSocket Bridge: ${url}`);

  const ws = new WebSocket(url, { rejectUnauthorized: false });

  ws.on('open', () => {
    console.log('Connected! Sending shell diagnostic commands...');
    
    // We send a newline to start, then test commands
    ws.send('\n');

    setTimeout(() => {
      ws.send('pwd\n');
    }, 1000);

    setTimeout(() => {
      ws.send('pm2 status\n');
    }, 3000);

    setTimeout(() => {
      ws.send('pm2 log hermes-api --lines 20\n');
    }, 6000);
  });

  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed.type === 'stdout' || parsed.type === 'stderr') {
        process.stdout.write(parsed.data);
      } else {
        console.log('\n[BRIDGE MESSAGE]:', parsed);
      }
    } catch (e) {
      console.log('\n[RAW]:', data.toString());
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket Error:', err.message);
  });

  ws.on('close', () => {
    console.log('\nConnection closed.');
  });

  // Automatically close after 18 seconds
  setTimeout(() => {
    console.log('\nTiming out and closing...');
    ws.close();
  }, 18000);
})();
