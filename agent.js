/**
 * M2M Agent SDK - AI Agent Communication Library
 * WebSocket for discovery, P2P encrypted for messaging
 *
 * Base URI: m2m.dev (default)
 *
 * Usage:
 *   const { M2MAgent } = require('./agent');
 *
 *   const agent = new M2MAgent({
 *     port: 4000,
 *     capabilities: ['nlp', 'search']
 *   });
 *
 *   agent.on('message', (msg) => console.log(msg));
 *   await agent.connect();
 *   await agent.send(targetId, 'task', { query: 'hello' });
 */

const WebSocket = require('ws');
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const os = require('os');

// Get local IP
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// Encryption utilities (X25519 + AES-256-GCM)
const Crypto = {
  generateKeyPair: () => crypto.generateKeyPairSync('x25519'),

  deriveKey: (privateKey, publicKeyBase64) => {
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki'
    });
    return crypto.diffieHellman({ privateKey, publicKey });
  },

  exportPublicKey: (keyPair) => {
    return keyPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  },

  encrypt: (data, key) => {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), enc]).toString('base64');
  },

  decrypt: (encrypted, key) => {
    try {
      const buf = Buffer.from(encrypted, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.slice(0, 12));
      decipher.setAuthTag(buf.slice(12, 28));
      const text = decipher.update(buf.slice(28)) + decipher.final('utf8');
      try { return JSON.parse(text); } catch { return text; }
    } catch {
      return null;
    }
  }
};

/**
 * M2M Agent - AI Agent Communication Client
 * WebSocket for discovery, P2P encrypted for messaging
 */
class M2MAgent extends EventEmitter {
  /**
   * Create a new M2M Agent
   * @param {Object} options
   * @param {number} options.port - Local listening port for P2P (REQUIRED)
   * @param {string} [options.hub='m2m.dev'] - Hub server address
   * @param {string} [options.address] - Public address override (IP:PORT)
   * @param {string[]} [options.capabilities=[]] - Agent capabilities
   * @param {Object} [options.metadata={}] - Additional metadata
   * @param {number} [options.heartbeatInterval=30000] - Heartbeat interval in ms
   * @param {boolean} [options.autoReconnect=true] - Auto reconnect on disconnect
   */
  constructor(options = {}) {
    super();

    // Required parameters validation
    if (!options.port) {
      throw new Error('Agent port is required! (port parameter)');
    }

    this.hubUrl = options.hub || 'm2m.dev';
    this.port = options.port;
    this.publicAddress = options.address || null; // Override for public IP
    this.capabilities = options.capabilities || [];
    this.metadata = options.metadata || {};
    this.heartbeatInterval = options.heartbeatInterval || 30000;
    this.autoReconnect = options.autoReconnect !== false;

    this.id = null;
    this.address = null;
    this.localIP = getLocalIP();
    this.connected = false;

    this.server = null;
    this.ws = null;
    this.actualPort = 0;

    this.pendingRequests = new Map(); // correlationId -> { resolve, reject, timeout }
    this.agentCache = new Map(); // agentId -> { address, lastSeen }

    this._heartbeatTimer = null;
    this._reconnectTimer = null;
  }

  // ══════════════════════════════════════════════════════════════
  //  CONNECTION
  // ══════════════════════════════════════════════════════════════

  /**
   * Connect to the M2M Hub
   * @returns {Promise<string>} Agent ID
   */
  async connect() {
    // Start local P2P server first
    await this._startServer();

    // Use public address if provided, otherwise use local IP
    this.address = this.publicAddress || `${this.localIP}:${this.actualPort}`;

    // Connect to hub via WebSocket
    await this._connectToHub();

    return this.id;
  }

  /**
   * Disconnect from the M2M Hub
   */
  async disconnect() {
    this.autoReconnect = false;

    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      await this._hubRequest({ action: 'disconnect', id: this.id });
      this.ws.close();
    }

    if (this.server) {
      this.server.close();
    }

    this.connected = false;
    this.emit('disconnected');
  }

  _startServer() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this._handlePeerConnection(socket));

      this.server.on('error', reject);

      this.server.listen(this.port, '0.0.0.0', () => {
        this.actualPort = this.server.address().port;
        resolve();
      });
    });
  }

  async _connectToHub() {
    return new Promise((resolve, reject) => {
      // Determine WebSocket URL
      const wsUrl = this.hubUrl.startsWith('ws://') || this.hubUrl.startsWith('wss://')
        ? this.hubUrl
        : `wss://${this.hubUrl}/ws`;

      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', async () => {
        try {
          const response = await this._hubRequest({
            action: 'register',
            address: this.address,
            capabilities: this.capabilities,
            metadata: this.metadata
          });

          if (response.status === 'ok') {
            this.id = response.id;
            this.connected = true;

            this._startHeartbeat();
            this.emit('connected', { id: this.id, address: this.address });

            resolve(this.id);
          } else {
            reject(new Error(response.error || 'Registration failed'));
          }
        } catch (err) {
          reject(err);
        }
      });

      this.ws.on('message', (data) => this._handleHubMessage(data));

      this.ws.on('close', () => {
        this.connected = false;
        this.emit('disconnected');

        if (this.autoReconnect) {
          this._scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        this.emit('error', err);
        if (!this.connected) reject(err);
      });
    });
  }

  _startHeartbeat() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);

    this._heartbeatTimer = setInterval(async () => {
      try {
        await this._hubRequest({ action: 'heartbeat', id: this.id });
      } catch {
        // Will trigger reconnect via socket close
      }
    }, this.heartbeatInterval);
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try {
        await this._connectToHub();
      } catch {
        this._scheduleReconnect();
      }
    }, 5000);
  }

  // ══════════════════════════════════════════════════════════════
  //  HUB COMMUNICATION (WebSocket - Discovery Only)
  // ══════════════════════════════════════════════════════════════

  _hubRequest(data, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const correlationId = crypto.randomBytes(8).toString('hex');
      data.correlationId = correlationId;

      const timer = setTimeout(() => {
        this.pendingRequests.delete(correlationId);
        reject(new Error('Request timeout'));
      }, timeout);

      this.pendingRequests.set(correlationId, { resolve, reject, timer });

      this.ws.send(JSON.stringify(data));
    });
  }

  _handleHubMessage(data) {
    try {
      const msg = JSON.parse(data.toString());

      // Check if it's a response to a pending request
      if (msg.correlationId && this.pendingRequests.has(msg.correlationId)) {
        const { resolve, timer } = this.pendingRequests.get(msg.correlationId);
        clearTimeout(timer);
        this.pendingRequests.delete(msg.correlationId);
        resolve(msg);
      }
    } catch {
      // Ignore parse errors
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  P2P ENCRYPTED COMMUNICATION (Direct TCP)
  // ══════════════════════════════════════════════════════════════

  _handlePeerConnection(socket) {
    let buffer = '';
    let sessionKey = null;
    let peerId = null;

    socket.setTimeout(30000);

    socket.on('data', (chunk) => {
      buffer += chunk.toString();

      while (buffer.includes('\n')) {
        const idx = buffer.indexOf('\n');
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);

        try {
          const msg = JSON.parse(line);

          if (msg.type === 'handshake') {
            // Ephemeral key exchange
            const keyPair = Crypto.generateKeyPair();
            sessionKey = Crypto.deriveKey(keyPair.privateKey, msg.key);
            peerId = msg.from;

            socket.write(JSON.stringify({
              type: 'handshake_ack',
              key: Crypto.exportPublicKey(keyPair)
            }) + '\n');

          } else if (msg.type === 'message' && sessionKey) {
            const payload = Crypto.decrypt(msg.data, sessionKey);

            if (payload !== null) {
              this.emit('message', {
                from: peerId,
                type: msg.messageType,
                payload,
                correlationId: msg.correlationId,
                timestamp: Date.now(),
                encrypted: true
              });

              socket.write(JSON.stringify({
                type: 'ack',
                correlationId: msg.correlationId
              }) + '\n');
            } else {
              socket.write(JSON.stringify({ error: 'decryption_failed' }) + '\n');
            }

          } else if (msg.type === 'ping') {
            socket.write(JSON.stringify({ type: 'pong' }) + '\n');
          }

        } catch {
          socket.write(JSON.stringify({ error: 'invalid_message' }) + '\n');
        }
      }
    });

    socket.on('timeout', () => socket.end());
    socket.on('error', () => {});
  }

  /**
   * Send encrypted message directly to address
   * @private
   */
  async _sendEncrypted(address, type, payload, correlationId) {
    const [host, port] = address.split(':');

    return new Promise((resolve, reject) => {
      const keyPair = Crypto.generateKeyPair();
      const socket = net.createConnection(parseInt(port), host);
      let buffer = '';
      let sessionKey = null;

      socket.setTimeout(10000);

      socket.on('connect', () => {
        // Send handshake with ephemeral public key
        socket.write(JSON.stringify({
          type: 'handshake',
          key: Crypto.exportPublicKey(keyPair),
          from: this.id
        }) + '\n');
      });

      socket.on('data', (chunk) => {
        buffer += chunk.toString();

        while (buffer.includes('\n')) {
          const idx = buffer.indexOf('\n');
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);

          try {
            const msg = JSON.parse(line);

            if (msg.type === 'handshake_ack') {
              // Derive shared secret
              sessionKey = Crypto.deriveKey(keyPair.privateKey, msg.key);

              // Send encrypted message
              socket.write(JSON.stringify({
                type: 'message',
                messageType: type,
                data: Crypto.encrypt(payload, sessionKey),
                correlationId
              }) + '\n');

            } else if (msg.type === 'ack') {
              socket.end();
              resolve({ delivered: true, correlationId });

            } else if (msg.error) {
              socket.end();
              reject(new Error(msg.error));
            }
          } catch (err) {
            socket.end();
            reject(err);
          }
        }
      });

      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error('Connection timeout'));
      });

      socket.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Lookup agent address from cache or Hub
   * @private
   */
  async _resolveAgent(agentId) {
    // Check cache first
    const cached = this.agentCache.get(agentId);
    if (cached && Date.now() - cached.lastSeen < 60000) {
      return cached.address;
    }

    // Lookup from Hub
    const response = await this._hubRequest({
      action: 'lookup',
      id: agentId
    });

    if (response.status !== 'ok' || !response.agent) {
      throw new Error('Agent not found');
    }

    if (response.agent.status === 'offline') {
      throw new Error('Agent is offline');
    }

    // Update cache
    this.agentCache.set(agentId, {
      address: response.agent.address,
      lastSeen: Date.now()
    });

    return response.agent.address;
  }

  // ══════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ══════════════════════════════════════════════════════════════

  /**
   * Discover other agents
   * @param {Object} [options]
   * @param {string[]} [options.capabilities] - Filter by capabilities
   * @param {string} [options.status] - Filter by status ('online', 'idle')
   * @param {string} [options.name] - Filter by name (partial match)
   * @returns {Promise<Object[]>} List of agents
   */
  async discover(options = {}) {
    const response = await this._hubRequest({
      action: 'discover',
      id: this.id,
      capabilities: options.capabilities,
      status: options.status,
      name: options.name
    });

    if (response.status !== 'ok') {
      throw new Error(response.error || 'Discovery failed');
    }

    // Update cache
    for (const agent of response.agents) {
      this.agentCache.set(agent.id, {
        address: agent.address,
        lastSeen: Date.now()
      });
    }

    return response.agents;
  }

  /**
   * Find agents with a specific capability
   * @param {string} capability
   * @returns {Promise<Object[]>} List of agents
   */
  async find(capability) {
    const response = await this._hubRequest({
      action: 'find',
      capability
    });

    if (response.status !== 'ok') {
      throw new Error(response.error || 'Find failed');
    }

    // Update cache
    for (const agent of response.agents) {
      this.agentCache.set(agent.id, {
        address: agent.address,
        lastSeen: Date.now()
      });
    }

    return response.agents;
  }

  /**
   * Send an encrypted P2P message to another agent
   * @param {string} to - Target agent ID
   * @param {string} type - Message type
   * @param {Object} payload - Message payload
   * @returns {Promise<Object>} Send result
   */
  async send(to, type, payload) {
    const correlationId = crypto.randomBytes(8).toString('hex');
    const address = await this._resolveAgent(to);

    return this._sendEncrypted(address, type, payload, correlationId);
  }

  /**
   * Send an encrypted P2P message directly to an address
   * @param {string} address - Target address (IP:Port)
   * @param {string} type - Message type
   * @param {Object} payload - Message payload
   * @returns {Promise<Object>} Send result
   */
  async sendDirect(address, type, payload) {
    const correlationId = crypto.randomBytes(8).toString('hex');
    return this._sendEncrypted(address, type, payload, correlationId);
  }

  /**
   * Broadcast an encrypted message to multiple agents
   * @param {string} type - Message type
   * @param {Object} payload - Message payload
   * @param {Object} [options]
   * @param {string[]} [options.capabilities] - Target agents with these capabilities
   * @returns {Promise<Object>} Broadcast result
   */
  async broadcast(type, payload, options = {}) {
    // Find all matching agents
    const agents = await this.discover({
      capabilities: options.capabilities,
      status: 'online'
    });

    const results = {
      total: agents.length,
      delivered: 0,
      failed: 0,
      errors: []
    };

    // Send to each agent in parallel
    const promises = agents.map(async (agent) => {
      try {
        const correlationId = crypto.randomBytes(8).toString('hex');
        await this._sendEncrypted(agent.address, type, payload, correlationId);
        results.delivered++;
      } catch (err) {
        results.failed++;
        results.errors.push({ agent: agent.id, error: err.message });
      }
    });

    await Promise.allSettled(promises);

    return results;
  }

  /**
   * Request-Response pattern: send and wait for response
   * @param {string} to - Target agent ID
   * @param {string} type - Message type
   * @param {Object} payload - Message payload
   * @param {number} [timeout=30000] - Response timeout in ms
   * @returns {Promise<Object>} Response payload
   */
  async request(to, type, payload, timeout = 30000) {
    const correlationId = crypto.randomBytes(8).toString('hex');

    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('message', handler);
        reject(new Error('Request timeout'));
      }, timeout);

      const handler = (msg) => {
        if (msg.correlationId === correlationId && msg.type === `${type}:response`) {
          clearTimeout(timer);
          this.removeListener('message', handler);
          resolve(msg.payload);
        }
      };

      this.on('message', handler);

      try {
        const address = await this._resolveAgent(to);
        await this._sendEncrypted(address, type, { ...payload, correlationId }, correlationId);
      } catch (err) {
        clearTimeout(timer);
        this.removeListener('message', handler);
        reject(err);
      }
    });
  }

  /**
   * Respond to a request (P2P encrypted)
   * @param {Object} originalMessage - The original message
   * @param {Object} responsePayload - Response payload
   */
  async respond(originalMessage, responsePayload) {
    const address = await this._resolveAgent(originalMessage.from);
    await this._sendEncrypted(
      address,
      `${originalMessage.type}:response`,
      responsePayload,
      originalMessage.correlationId
    );
  }

  /**
   * Update agent status on Hub
   * @param {string} status - New status ('online', 'idle', 'busy')
   * @param {Object} [metadata] - Additional metadata to merge
   */
  async updateStatus(status, metadata) {
    await this._hubRequest({
      action: 'status',
      id: this.id,
      status,
      metadata
    });
  }

  /**
   * Get Hub statistics
   * @returns {Promise<Object>} Hub stats
   */
  async getStats() {
    const response = await this._hubRequest({ action: 'stats' });
    return response;
  }
}

module.exports = { M2MAgent, Crypto };
