const WebSocket = require('ws');

(async () => {
  const url = 'wss://103-142-24-60.sslip.io/hermes-ws';
  console.log(`Connecting to WebSocket Bridge: ${url}`);

  const ws = new WebSocket(url, {
    rejectUnauthorized: false // sslip.io cert might be self-signed or have host mismatches
  });

  ws.on('open', () => {
    console.log('Connected to bridge! Sending command...');
    // We will send a command to run on the terminal.
    // The bridge spawns the hermes CLI. In the hermes CLI we can run commands or see status.
    // Wait, let's see what happens if we write text.
    ws.send('show oauth-config\n');
  });

  ws.on('message', (data) => {
    console.log('--- VPS Output ---');
    console.log(data.toString());
  });

  ws.on('error', (err) => {
    console.error('WebSocket Error:', err.message);
  });

  ws.on('close', () => {
    console.log('Connection closed.');
  });

  // Automatically close after 8 seconds
  setTimeout(() => {
    console.log('Timing out and closing...');
    ws.close();
  }, 8000);
})();
