const WebSocket = require('ws');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log('Usage: node execute_hermes_cli.js <arg1> <arg2> ...');
  process.exit(1);
}

(async () => {
  const url = 'wss://103-142-24-60.sslip.io/hermes-ws';
  console.log(`Connecting to WebSocket Bridge: ${url}`);
  console.log(`Running hermes CLI with args: ${JSON.stringify(args)}`);

  const ws = new WebSocket(url, { rejectUnauthorized: false });

  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'exec',
      args: args
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

  // Automatically close after 12 seconds if not exited
  setTimeout(() => {
    console.log('\nTiming out and closing...');
    ws.close();
    process.exit(0);
  }, 12000);
})();
