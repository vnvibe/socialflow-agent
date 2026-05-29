const WebSocket = require('ws');

(async () => {
  const url = 'wss://103-142-24-60.sslip.io/hermes-ws';
  console.log(`Connecting to WebSocket Bridge: ${url}`);

  const ws = new WebSocket(url, { rejectUnauthorized: false });

  ws.on('open', () => {
    console.log('Connected! Sending exec command "status"...');
    ws.send(JSON.stringify({
      type: 'exec',
      args: ['status']
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

  // Automatically close after 15 seconds
  setTimeout(() => {
    console.log('\nTiming out and closing...');
    ws.close();
  }, 15000);
})();
