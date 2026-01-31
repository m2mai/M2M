#!/usr/bin/env node
/**
 * Broadcast Agent - Broadcast messages to multiple agents
 *
 * Usage:
 *   Listener: node broadcast-agent.js --port 4005 --listen
 *   Sender:   node broadcast-agent.js --port 4006 --broadcast "Hello everyone!"
 */

const { M2MAgent } = require('../agent');

const args = process.argv.slice(2);
let port = 4005;
let listenMode = false;
let broadcastMessage = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = parseInt(args[++i]);
  if (args[i] === '--listen') listenMode = true;
  if (args[i] === '--broadcast') broadcastMessage = args[++i];
}

const agent = new M2MAgent({
  port,
  capabilities: ['broadcast', 'monitor']
});

// Listener mode
if (listenMode) {
  agent.on('message', (msg) => {
    if (msg.type === 'broadcast' || msg.type === 'alert') {
      console.log(`\n[BROADCAST] From ${msg.from.slice(0, 8)}:`);
      console.log(`  Type: ${msg.type}`);
      console.log(`  Message: ${msg.payload.message || JSON.stringify(msg.payload)}`);
      console.log(`  Time: ${new Date().toISOString()}`);
    }
  });
}

async function main() {
  console.log('Broadcast Agent starting...');

  try {
    await agent.connect();
    console.log(`Connected as ${agent.id.slice(0, 16)}`);

    if (listenMode) {
      console.log('\nListening for broadcasts...\n');

    } else if (broadcastMessage) {
      // Find all agents with monitor capability
      const monitors = await agent.find('monitor');
      const others = monitors.filter(m => m.id !== agent.id);

      if (others.length === 0) {
        console.log('\nNo listeners online. Start some listeners first:');
        console.log('  node broadcast-agent.js --port 4005 --listen');
        console.log('  node broadcast-agent.js --port 4007 --listen');
        return;
      }

      console.log(`\nBroadcasting to ${others.length} agent(s)...`);

      await agent.broadcast('broadcast', {
        message: broadcastMessage,
        sender: agent.id,
        timestamp: Date.now()
      }, {
        capabilities: ['monitor']
      });

      console.log('Broadcast sent successfully!');
      console.log('\nRecipients:');
      others.forEach(a => {
        console.log(`  - ${a.id.slice(0, 16)} (${a.address})`);
      });

    } else {
      console.log('\nUsage:');
      console.log('  Listen mode:    node broadcast-agent.js --port 4005 --listen');
      console.log('  Broadcast mode: node broadcast-agent.js --port 4006 --broadcast "Your message"');

      // Show available agents
      const peers = await agent.discover();
      const others = peers.filter(p => p.id !== agent.id);

      if (others.length > 0) {
        console.log(`\nOnline agents: ${others.length}`);
        others.slice(0, 5).forEach(a => {
          console.log(`  - ${a.id.slice(0, 16)} [${a.capabilities.join(', ')}]`);
        });
        if (others.length > 5) {
          console.log(`  ... and ${others.length - 5} more`);
        }
      }
    }

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
