#!/usr/bin/env node
/**
 * Task Agent - Task delegation example
 *
 * This agent can either be a worker (handles tasks) or a coordinator (delegates tasks).
 *
 * Usage:
 *   Worker:      node task-agent.js --port 4003 --role worker
 *   Coordinator: node task-agent.js --port 4004 --role coordinator
 */

const { M2MAgent } = require('../agent');

const args = process.argv.slice(2);
let port = 4003;
let role = 'worker';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = parseInt(args[++i]);
  if (args[i] === '--role') role = args[++i];
}

const capabilities = role === 'worker' ? ['compute', 'task'] : ['coordinator'];

const agent = new M2MAgent({
  port,
  capabilities
});

// Worker: Handle incoming tasks
if (role === 'worker') {
  agent.on('message', async (msg) => {
    if (msg.type === 'task') {
      console.log(`\n[TASK] Received from ${msg.from.slice(0, 8)}:`);
      console.log(`  Operation: ${msg.payload.operation}`);
      console.log(`  Data:`, msg.payload.data);

      let result;

      // Process different task types
      switch (msg.payload.operation) {
        case 'sum':
          result = msg.payload.data.reduce((a, b) => a + b, 0);
          break;
        case 'multiply':
          result = msg.payload.data.reduce((a, b) => a * b, 1);
          break;
        case 'reverse':
          result = msg.payload.data.split('').reverse().join('');
          break;
        case 'uppercase':
          result = msg.payload.data.toUpperCase();
          break;
        default:
          result = { error: 'Unknown operation' };
      }

      console.log(`  Result: ${JSON.stringify(result)}`);

      await agent.respond(msg, { result, operation: msg.payload.operation });
    }
  });
}

async function main() {
  console.log(`Task Agent (${role}) starting...`);

  try {
    await agent.connect();
    console.log(`Connected as ${agent.id.slice(0, 16)}`);
    console.log(`Role: ${role}`);
    console.log(`Capabilities: [${capabilities.join(', ')}]`);

    if (role === 'worker') {
      console.log('\nWaiting for tasks...\n');
    } else {
      // Coordinator: Find workers and delegate tasks
      console.log('\nFinding workers...');

      const workers = await agent.find('compute');
      const otherWorkers = workers.filter(w => w.id !== agent.id);

      if (otherWorkers.length === 0) {
        console.log('No workers available. Start some workers first.');
        console.log('  node task-agent.js --port 4003 --role worker');
        return;
      }

      console.log(`Found ${otherWorkers.length} worker(s)`);

      // Send sample tasks
      const tasks = [
        { operation: 'sum', data: [1, 2, 3, 4, 5] },
        { operation: 'multiply', data: [2, 3, 4] },
        { operation: 'reverse', data: 'Hello M2M' },
        { operation: 'uppercase', data: 'ai agents' }
      ];

      for (const task of tasks) {
        const worker = otherWorkers[Math.floor(Math.random() * otherWorkers.length)];
        console.log(`\nSending task to ${worker.id.slice(0, 8)}:`);
        console.log(`  Operation: ${task.operation}`);
        console.log(`  Data:`, task.data);

        try {
          const response = await agent.request(worker.id, 'task', task, 10000);
          console.log(`  Response: ${JSON.stringify(response.result)}`);
        } catch (err) {
          console.error(`  Error: ${err.message}`);
        }
      }

      console.log('\nAll tasks completed.');
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
