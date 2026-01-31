#!/usr/bin/env node
/**
 * M2M Interactive Agent - User Friendly CLI
 */

const { M2MAgent } = require('./agent');
const readline = require('readline');

// Parse arguments
const args = process.argv.slice(2);
const config = { port: 4000, capabilities: [], hub: null, address: null };

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' || args[i] === '-p') config.port = parseInt(args[++i]);
  if (args[i] === '--capabilities' || args[i] === '-c') config.capabilities = args[++i].split(',');
  if (args[i] === '--hub') config.hub = args[++i];
  if (args[i] === '--address' || args[i] === '-a') config.address = args[++i];
  if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
M2M Interactive Agent

Usage: node connect-agent.js [options]

Options:
  -p, --port <port>        Local P2P port (default: 4000)
  -a, --address <ip:port>  Public address override
  -c, --capabilities       Comma-separated capabilities
  --hub <url>              Hub URL (default: m2m.dev)
  -h, --help               Show help

Example:
  node connect-agent.js --port 4000 --address 34.56.78.90:4000
`);
    process.exit(0);
  }
}

// State
let agent = null;
let peers = [];
let messages = [];
let selectedPeer = 0;
let inputMode = 'command'; // command, type, message
let inputBuffer = '';
let messageType = 'message';

// Colors
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgBlue: '\x1b[44m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgRed: '\x1b[41m',
};

const clear = () => process.stdout.write('\x1b[2J\x1b[H');

// Format time
const timeStr = () => new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

// Add message to log
function addMessage(type, from, content, incoming = true) {
  messages.push({
    time: timeStr(),
    type,
    from,
    content,
    incoming
  });
  // Keep last 50 messages
  if (messages.length > 50) messages.shift();
}

// Render
function render() {
  clear();
  const width = process.stdout.columns || 80;
  const height = process.stdout.rows || 24;

  // Header
  console.log(`${C.bgBlue}${C.bold}${C.white} M2M Agent ${C.reset}${C.bgBlue} ${agent?.connected ? `${C.green}● ONLINE` : `${C.red}● OFFLINE`}${C.reset}${C.bgBlue} ${C.reset}`);

  if (agent?.connected) {
    console.log(`${C.dim}ID: ${C.cyan}${agent.id.slice(0, 16)}${C.dim} | Addr: ${C.cyan}${agent.address}${C.reset}`);
  }

  console.log(`${C.dim}${'─'.repeat(width - 1)}${C.reset}`);

  // Two columns: Peers (left) | Messages (right)
  const peerWidth = 35;
  const msgWidth = width - peerWidth - 3;

  // Peers header
  process.stdout.write(`${C.bold} PEERS (${peers.length})${C.reset}`);
  process.stdout.write(' '.repeat(peerWidth - 12));
  console.log(`${C.bold}│ MESSAGES${C.reset}`);

  console.log(`${C.dim}${'─'.repeat(peerWidth)}┼${'─'.repeat(msgWidth)}${C.reset}`);

  // Content rows
  const contentRows = Math.min(height - 10, 15);

  for (let i = 0; i < contentRows; i++) {
    // Peer column
    let peerLine = '';
    if (i < peers.length) {
      const p = peers[i];
      const selected = i === selectedPeer;
      const status = p.status === 'online' ? `${C.green}●${C.reset}` : `${C.yellow}○${C.reset}`;
      const prefix = selected ? `${C.bgGreen}${C.bold}>` : ' ';
      const id = p.id.slice(0, 8);
      const addr = p.address.length > 18 ? p.address.slice(0, 18) + '..' : p.address;
      peerLine = `${prefix}${status} ${id} ${C.dim}${addr}${C.reset}`;
      if (selected) peerLine += C.reset;
    }

    // Pad peer line
    const peerVisualLen = peerLine.replace(/\x1b\[[0-9;]*m/g, '').length;
    peerLine += ' '.repeat(Math.max(0, peerWidth - peerVisualLen));

    // Message column
    let msgLine = '';
    const msgIdx = messages.length - contentRows + i;
    if (msgIdx >= 0 && msgIdx < messages.length) {
      const m = messages[msgIdx];
      const arrow = m.incoming ? `${C.green}←${C.reset}` : `${C.blue}→${C.reset}`;
      const from = m.from.slice(0, 6);
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      const truncContent = content.length > msgWidth - 25 ? content.slice(0, msgWidth - 28) + '...' : content;
      msgLine = `${C.dim}${m.time}${C.reset} ${arrow} ${C.cyan}${from}${C.reset} ${C.dim}[${m.type}]${C.reset} ${truncContent}`;
    }

    console.log(`${peerLine}${C.dim}│${C.reset} ${msgLine}`);
  }

  console.log(`${C.dim}${'─'.repeat(peerWidth)}┴${'─'.repeat(msgWidth)}${C.reset}`);

  // Help bar
  if (inputMode === 'command') {
    console.log(`${C.dim}[↑↓] Select peer  [Enter] Send message  [R] Refresh  [S] Stats  [Q] Quit${C.reset}`);
  } else if (inputMode === 'type') {
    console.log(`${C.yellow}Message type: ${C.white}${inputBuffer}${C.dim}_ (Enter to confirm, Esc to cancel)${C.reset}`);
  } else if (inputMode === 'message') {
    console.log(`${C.yellow}Message to ${peers[selectedPeer]?.id.slice(0, 8) || '?'} [${messageType}]: ${C.white}${inputBuffer}${C.dim}_ (Enter to send)${C.reset}`);
  }

  // Status bar
  const statusText = peers.length > 0
    ? `Selected: ${peers[selectedPeer]?.id.slice(0, 8) || 'none'} | ${peers[selectedPeer]?.address || ''}`
    : 'No peers available - press R to refresh';
  console.log(`${C.bgBlue}${C.white} ${statusText} ${C.reset}`);
}

// Refresh peers
async function refreshPeers() {
  try {
    addMessage('system', 'hub', 'Refreshing peer list...', true);
    peers = await agent.discover();
    peers = peers.filter(p => p.id !== agent.id);
    if (selectedPeer >= peers.length) selectedPeer = Math.max(0, peers.length - 1);
    addMessage('system', 'hub', `Found ${peers.length} peer(s)`, true);
    render();
  } catch (err) {
    addMessage('error', 'system', err.message, true);
    render();
  }
}

// Send message
async function sendMessage(type, content) {
  if (peers.length === 0) {
    addMessage('error', 'system', 'No peers to send to', true);
    return;
  }

  const peer = peers[selectedPeer];
  let payload;

  try {
    payload = content.startsWith('{') ? JSON.parse(content) : { text: content };
  } catch {
    payload = { text: content };
  }

  addMessage(type, peer.id, payload, false);
  render();

  try {
    await agent.send(peer.id, type, payload);
    addMessage('system', 'local', `✓ Delivered to ${peer.id.slice(0, 8)}`, true);
  } catch (err) {
    addMessage('error', 'system', `✗ Failed: ${err.message}`, true);
  }

  render();
}

// Show stats
async function showStats() {
  try {
    const stats = await agent.getStats();
    addMessage('stats', 'hub', `Online: ${stats.agents.online} | Idle: ${stats.agents.idle} | Connections: ${stats.hub.activeConnections}`, true);
    render();
  } catch (err) {
    addMessage('error', 'system', err.message, true);
    render();
  }
}

// Handle incoming message
function handleMessage(msg) {
  const content = typeof msg.payload === 'object' ? msg.payload.text || JSON.stringify(msg.payload) : msg.payload;
  addMessage(msg.type, msg.from, content, true);

  // Beep notification
  process.stdout.write('\x07');

  render();
}

// Input handler
function handleInput(key) {
  if (inputMode === 'command') {
    // Ctrl+C or Q
    if (key === '\u0003' || key === 'q' || key === 'Q') {
      console.log(`\n${C.yellow}Disconnecting...${C.reset}`);
      agent.disconnect().then(() => process.exit(0));
      return;
    }

    // Arrow up
    if (key === '\u001b[A') {
      selectedPeer = Math.max(0, selectedPeer - 1);
      render();
    }

    // Arrow down
    if (key === '\u001b[B') {
      selectedPeer = Math.min(peers.length - 1, selectedPeer + 1);
      render();
    }

    // Enter - start message
    if (key === '\r') {
      if (peers.length > 0) {
        inputMode = 'type';
        inputBuffer = 'message';
        render();
      }
    }

    // R - refresh
    if (key === 'r' || key === 'R') {
      refreshPeers();
    }

    // S - stats
    if (key === 's' || key === 'S') {
      showStats();
    }

    // M - quick message
    if (key === 'm' || key === 'M') {
      if (peers.length > 0) {
        inputMode = 'message';
        messageType = 'message';
        inputBuffer = '';
        render();
      }
    }

  } else if (inputMode === 'type') {
    // Escape - cancel
    if (key === '\u001b' || key === '\u001b[') {
      inputMode = 'command';
      inputBuffer = '';
      render();
      return;
    }

    // Enter - confirm type
    if (key === '\r') {
      messageType = inputBuffer || 'message';
      inputMode = 'message';
      inputBuffer = '';
      render();
      return;
    }

    // Backspace
    if (key === '\u007f' || key === '\b') {
      inputBuffer = inputBuffer.slice(0, -1);
      render();
      return;
    }

    // Regular character
    if (key.length === 1 && key.charCodeAt(0) >= 32) {
      inputBuffer += key;
      render();
    }

  } else if (inputMode === 'message') {
    // Escape - cancel
    if (key === '\u001b' || key === '\u001b[') {
      inputMode = 'command';
      inputBuffer = '';
      render();
      return;
    }

    // Enter - send
    if (key === '\r') {
      if (inputBuffer.trim()) {
        sendMessage(messageType, inputBuffer);
      }
      inputMode = 'command';
      inputBuffer = '';
      render();
      return;
    }

    // Backspace
    if (key === '\u007f' || key === '\b') {
      inputBuffer = inputBuffer.slice(0, -1);
      render();
      return;
    }

    // Regular character
    if (key.length === 1 && key.charCodeAt(0) >= 32) {
      inputBuffer += key;
      render();
    }
  }
}

// Main
async function main() {
  clear();
  console.log(`${C.bold}M2M Agent${C.reset}`);
  console.log(`${C.dim}Connecting to ${config.hub || 'm2m.dev'}...${C.reset}\n`);

  const opts = { port: config.port, capabilities: config.capabilities };
  if (config.hub) opts.hub = config.hub;
  if (config.address) opts.address = config.address;

  agent = new M2MAgent(opts);

  agent.on('message', handleMessage);
  agent.on('error', (err) => {
    addMessage('error', 'system', err.message, true);
    render();
  });
  agent.on('disconnected', () => {
    addMessage('system', 'hub', 'Disconnected from hub', true);
    render();
  });

  try {
    await agent.connect();
    addMessage('system', 'hub', `Connected as ${agent.id.slice(0, 16)}`, true);
    await refreshPeers();

    // Setup input
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', handleInput);

    render();
  } catch (err) {
    console.log(`${C.red}Connection failed: ${err.message}${C.reset}`);
    process.exit(1);
  }
}

main();
