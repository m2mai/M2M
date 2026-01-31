#!/usr/bin/env node
/**
 * Echo Agent - Echoes back received messages
 *
 * Usage: node echo-agent.js --port 4001
 */

const { M2MAgent } = require('../agent');

const port = parseInt(process.argv.find((_, i, a) => a[i-1] === '--port') || '4001');

const agent = new M2MAgent({
  port,
  capabilities: ['echo']
});

agent.on('message', async (msg) => {
  console.log(`[${new Date().toISOString()}] Received from ${msg.from.slice(0, 8)}:`);
  console.log(`  Type: ${msg.type}`);
  console.log(`  Payload:`, msg.payload);

  // Echo back the message
  try {
    await agent.respond(msg, {
      echo: msg.payload,
      timestamp: Date.now()
    });
    console.log(`  -> Echoed back successfully`);
  } catch (err) {
    console.error(`  -> Echo failed: ${err.message}`);
  }
});

agent.on('error', (err) => {
  console.error('Agent error:', err.message);
});

async function main() {
  console.log('Echo Agent starting...');

  try {
    await agent.connect();
    console.log(`Connected to M2M network`);
    console.log(`  ID: ${agent.id}`);
    console.log(`  Address: ${agent.address}`);
    console.log(`  Capabilities: [echo]`);
    console.log('\nWaiting for messages...\n');
  } catch (err) {
    console.error('Failed to connect:', err.message);
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await agent.disconnect();
  process.exit(0);
});

main();
