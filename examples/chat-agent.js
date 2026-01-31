#!/usr/bin/env node
/**
 * Chat Agent - Simple chat between agents
 *
 * Usage: node chat-agent.js --port 4002 --to <agent-id>
 */

const { M2MAgent } = require('../agent');
const readline = require('readline');

const args = process.argv.slice(2);
let port = 4002;
let targetId = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = parseInt(args[++i]);
  if (args[i] === '--to') targetId = args[++i];
}

const agent = new M2MAgent({
  port,
  capabilities: ['chat']
});

// Handle incoming messages
agent.on('message', (msg) => {
  if (msg.type === 'chat') {
    console.log(`\n[${msg.from.slice(0, 8)}]: ${msg.payload.text}`);
    process.stdout.write('You: ');
  }
});

agent.on('error', (err) => {
  console.error('Error:', err.message);
});

async function main() {
  console.log('Chat Agent starting...');

  try {
    await agent.connect();
    console.log(`Connected as ${agent.id.slice(0, 16)}`);

    // If no target specified, list available chat agents
    if (!targetId) {
      const chatAgents = await agent.find('chat');
      const others = chatAgents.filter(a => a.id !== agent.id);

      if (others.length === 0) {
        console.log('\nNo other chat agents online. Waiting for messages...');
      } else {
        console.log('\nAvailable chat agents:');
        others.forEach((a, i) => {
          console.log(`  ${i + 1}. ${a.id.slice(0, 16)} (${a.address})`);
        });
        console.log('\nRun with --to <agent-id> to chat with someone');
      }
    } else {
      console.log(`\nChatting with ${targetId.slice(0, 16)}`);
      console.log('Type your message and press Enter to send\n');
    }

    // Setup readline for input
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.on('line', async (line) => {
      if (!line.trim()) return;

      if (!targetId) {
        console.log('No target specified. Use --to <agent-id>');
        return;
      }

      try {
        await agent.send(targetId, 'chat', { text: line });
      } catch (err) {
        console.error(`Failed to send: ${err.message}`);
      }

      process.stdout.write('You: ');
    });

    if (targetId) {
      process.stdout.write('You: ');
    }

  } catch (err) {
    console.error('Failed to connect:', err.message);
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  console.log('\nDisconnecting...');
  await agent.disconnect();
  process.exit(0);
});

main();
