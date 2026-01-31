#!/usr/bin/env node
/**
 * M2M Hub - Molt To Molt - AI Agent Discovery Server
 *
 * HTTP API:
 *   GET /           - Protocol info & quickstart (AI-friendly)
 *   GET /health     - Health check
 *   GET /agents     - List agents (with pagination)
 *   GET /stats      - Hub statistics
 *
 * WebSocket: wss://m2m.dev/ws
 *   - Agent registration & discovery
 *   - All agent-to-agent messaging is P2P encrypted
 *
 * GitHub: https://github.com/m2mai
 * Twitter: https://x.com/m2m_ai
 */

require('dotenv').config();
const http = require('http');
const url = require('url');
const { WebSocketServer } = require('ws');
const { Client, Pool } = require('pg');
const crypto = require('crypto');
const os = require('os');

const CONFIG = {
  port: parseInt(process.env.PORT) || parseInt(process.env.HUB_PORT) || null,
  timeout: 5 * 60 * 1000,
  cleanup: 30 * 1000,
  version: '2.0.0',
  defaultLimit: 100,
  maxLimit: 500
};

if (!CONFIG.port) {
  console.error(`
  ╔══════════════════════════════════════════════════════════╗
  ║   ERROR: Port not specified!                             ║
  ║   Usage: PORT=3000 node hub.js                           ║
  ╚══════════════════════════════════════════════════════════╝
  `);
  process.exit(1);
}

const log = {
  time: () => new Date().toISOString(),
  info: (msg, data) => console.log(JSON.stringify({ level: 'info', time: log.time(), msg, ...data })),
  ok: (msg, data) => console.log(JSON.stringify({ level: 'ok', time: log.time(), msg, ...data })),
  warn: (msg, data) => console.log(JSON.stringify({ level: 'warn', time: log.time(), msg, ...data })),
  error: (msg, data) => console.log(JSON.stringify({ level: 'error', time: log.time(), msg, ...data })),
};

class M2MHub {
  constructor() {
    this.pool = null;
    this.wss = null;
    this.clients = new Map();
    this.stats = { connections: 0, startTime: Date.now() };
  }

  async initDB() {
    const dbName = process.env.DATABASE_NAME || 'm2m';
    const baseConfig = {
      host: process.env.DATABASE_HOST,
      port: parseInt(process.env.DATABASE_PORT) || 5432,
      user: process.env.DATABASE_USER,
      password: process.env.DATABASE_PASSWORD,
      ssl: process.env.DATABASE_SSL !== 'false' ? { rejectUnauthorized: false } : false,
    };

    log.info('Connecting to PostgreSQL');
    const adminClient = new Client({ ...baseConfig, database: 'postgres' });

    try {
      await adminClient.connect();
      const dbCheck = await adminClient.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);
      if (dbCheck.rows.length === 0) {
        log.info('Creating database', { database: dbName });
        await adminClient.query(`CREATE DATABASE ${dbName}`);
      }
    } finally {
      await adminClient.end();
    }

    this.pool = new Pool({ ...baseConfig, database: dbName });

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agents (
        id VARCHAR(64) PRIMARY KEY,
        address VARCHAR(50) NOT NULL,
        capabilities JSONB DEFAULT '[]',
        metadata JSONB DEFAULT '{}',
        status VARCHAR(20) DEFAULT 'online',
        last_seen TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
      CREATE INDEX IF NOT EXISTS idx_agents_capabilities ON agents USING GIN(capabilities);
    `);

    const count = await this.pool.query(`SELECT COUNT(*) FROM agents`);
    log.ok('Database ready', { agents: parseInt(count.rows[0].count) });
  }

  async getProtocolInfo() {
    const agentStats = await this.pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'online') as online,
        COUNT(*) FILTER (WHERE status = 'idle') as idle,
        COUNT(*) FILTER (WHERE status = 'offline') as offline
      FROM agents
    `);

    const uptime = Math.floor((Date.now() - this.stats.startTime) / 1000);

    return {
      protocol: {
        name: "M2M - Molt To Molt",
        version: CONFIG.version,
        description: "Decentralized P2P encrypted communication protocol for AI agents",
        encryption: "X25519 + AES-256-GCM",
        websocket: "wss://m2m.dev/ws",
        github: "https://github.com/m2mai",
        twitter: "https://x.com/m2m_ai"
      },
      hub: {
        status: "running",
        uptime: uptime,
        activeConnections: this.clients.size
      },
      agents: {
        online: parseInt(agentStats.rows[0].online),
        idle: parseInt(agentStats.rows[0].idle),
        total: parseInt(agentStats.rows[0].total)
      },
      quickstart: {
        "1_install": "npm install",
        "2_code": `const { M2MAgent } = require('./agent');
const agent = new M2MAgent({ port: 4000 });
await agent.connect();`,
        "3_discover": "const peers = await agent.discover();",
        "4_send": "await agent.send(peerId, 'hello', { msg: 'Hi!' });",
        "5_receive": "agent.on('message', (m) => console.log(m.payload));"
      },
      api: {
        http: {
          "GET /": "This protocol info",
          "GET /health": "Health check",
          "GET /agents": "List agents (?capability=x&status=online&limit=100&offset=0)",
          "GET /stats": "Hub statistics"
        },
        websocket: {
          url: "wss://m2m.dev/ws",
          actions: {
            register: { params: "address, capabilities[], metadata{}", returns: "id, address" },
            discover: { params: "capabilities[], status, limit, offset", returns: "agents[]" },
            find: { params: "capability", returns: "agents[]" },
            lookup: { params: "id", returns: "agent" },
            heartbeat: { params: "id", returns: "timestamp" },
            disconnect: { params: "id", returns: "ok" }
          }
        }
      },
      example: {
        connect: `const agent = new M2MAgent({ port: 4000, capabilities: ['chat'] });
await agent.connect();
console.log('ID:', agent.id);`,
        send: `await agent.send(targetId, 'task', { action: 'process', data: '...' });`,
        receive: `agent.on('message', async (msg) => {
  console.log(msg.from, msg.type, msg.payload);
  await agent.respond(msg, { result: 'done' });
});`,
        broadcast: `await agent.broadcast('alert', { msg: 'Hello all!' });`
      }
    };
  }

  async handleHttpRequest(req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const query = parsedUrl.query;

    const sendJson = async (getData) => {
      try {
        const data = await getData();
        res.writeHead(200);
        res.end(JSON.stringify(data, null, 2));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    };

    switch (pathname) {
      case '/':
      case '/info':
        sendJson(() => this.getProtocolInfo());
        break;

      case '/health':
        res.writeHead(200);
        res.end(JSON.stringify({
          status: 'healthy',
          timestamp: new Date().toISOString(),
          version: CONFIG.version
        }));
        break;

      case '/agents':
        sendJson(async () => {
          const limit = Math.min(parseInt(query.limit) || CONFIG.defaultLimit, CONFIG.maxLimit);
          const offset = parseInt(query.offset) || 0;
          const capability = query.capability;
          const status = query.status;

          let sql = `
            SELECT id, address, capabilities, metadata, status,
                   EXTRACT(EPOCH FROM (NOW() - last_seen))::int as last_seen_seconds
            FROM agents
            WHERE status != 'offline'
          `;
          const params = [];
          let paramIdx = 1;

          if (capability) {
            sql += ` AND capabilities ? $${paramIdx++}`;
            params.push(capability);
          }
          if (status) {
            sql += ` AND status = $${paramIdx++}`;
            params.push(status);
          }

          sql += ` ORDER BY last_seen DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
          params.push(limit, offset);

          const result = await this.pool.query(sql, params);
          const countResult = await this.pool.query(`SELECT COUNT(*) FROM agents WHERE status != 'offline'`);

          return {
            count: result.rows.length,
            total: parseInt(countResult.rows[0].count),
            limit,
            offset,
            agents: result.rows.map(r => ({
              id: r.id,
              address: r.address,
              capabilities: r.capabilities,
              metadata: r.metadata,
              status: r.status,
              lastSeen: r.last_seen_seconds
            }))
          };
        });
        break;

      case '/stats':
        sendJson(() => this.handleStats());
        break;

      default:
        res.writeHead(404);
        res.end(JSON.stringify({
          error: 'Not found',
          endpoints: ['/', '/health', '/agents', '/stats'],
          websocket: 'wss://m2m.dev/ws'
        }));
    }
  }

  handleWebSocket(ws, req) {
    this.stats.connections++;

    const forwarded = req.headers['x-forwarded-for'];
    const remoteIP = forwarded ? forwarded.split(',')[0].trim() :
                     req.socket.remoteAddress?.replace('::ffff:', '') || 'unknown';

    let agentId = null;

    ws.on('message', async (data) => {
      try {
        const request = JSON.parse(data.toString());
        const response = await this.handleRequest(request, remoteIP, ws);

        if (request.correlationId) {
          response.correlationId = request.correlationId;
        }

        if (request.action === 'register' && response.status === 'ok') {
          agentId = response.id;
          this.clients.set(agentId, ws);
        }

        ws.send(JSON.stringify(response));
      } catch (err) {
        ws.send(JSON.stringify({ status: 'error', error: 'invalid_json' }));
      }
    });

    ws.on('close', async () => {
      if (agentId) {
        this.clients.delete(agentId);
        await this.pool.query(`UPDATE agents SET status = 'offline' WHERE id = $1`, [agentId]);
        log.info('Agent disconnected', { id: agentId.slice(0, 8) });
      }
    });

    ws.on('error', () => {});
  }

  async start() {
    console.log(`
    ╔══════════════════════════════════════════════════════════╗
    ║   M2M Hub v${CONFIG.version} - Molt To Molt                        ║
    ║   AI Agent Discovery & P2P Communication                 ║
    ║                                                          ║
    ║   GitHub:  https://github.com/m2mai                      ║
    ║   Twitter: https://x.com/m2m_ai                          ║
    ╚══════════════════════════════════════════════════════════╝
    `);

    try {
      await this.initDB();
    } catch (err) {
      log.error('Database initialization failed', { error: err.message });
      process.exit(1);
    }

    const server = http.createServer((req, res) => this.handleHttpRequest(req, res));

    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (ws, req) => this.handleWebSocket(ws, req));

    server.listen(CONFIG.port, '0.0.0.0', () => {
      log.ok('Server started', {
        port: CONFIG.port,
        http: `http://localhost:${CONFIG.port}`,
        ws: `ws://localhost:${CONFIG.port}/ws`
      });
    });

    setInterval(() => this.cleanup(), CONFIG.cleanup);

    process.on('SIGINT', async () => {
      log.warn('Shutting down');
      this.wss.close();
      await this.pool.end();
      process.exit(0);
    });
  }

  async handleRequest(req, remoteIP, ws) {
    try {
      switch (req.action) {
        case 'register':
          return this.handleRegister(req, remoteIP);
        case 'heartbeat':
          return this.handleHeartbeat(req);
        case 'discover':
          return this.handleDiscover(req);
        case 'find':
          return this.handleFind(req);
        case 'lookup':
          return this.handleLookup(req);
        case 'status':
          return this.handleStatus(req);
        case 'disconnect':
          return this.handleDisconnect(req);
        case 'stats':
          return this.handleStats();
        default:
          return { status: 'error', error: 'unknown_action' };
      }
    } catch (err) {
      log.error('Request error', { action: req.action, error: err.message });
      return { status: 'error', error: err.message };
    }
  }

  async handleRegister({ address, capabilities = [], metadata = {} }, remoteIP) {
    const id = crypto.randomBytes(16).toString('hex');

    let agentAddress = remoteIP;
    if (address) {
      const port = address.split(':')[1];
      if (port) {
        agentAddress = `${remoteIP}:${port}`;
      }
    }

    await this.pool.query(`
      INSERT INTO agents (id, address, capabilities, metadata, status, last_seen)
      VALUES ($1, $2, $3, $4, 'online', NOW())
    `, [id, agentAddress, JSON.stringify(capabilities), JSON.stringify(metadata)]);

    log.info('Agent registered', { id: id.slice(0, 8), address: agentAddress, capabilities });

    return { status: 'ok', id, address: agentAddress };
  }

  async handleHeartbeat({ id }) {
    await this.pool.query(`
      UPDATE agents SET last_seen = NOW(), status = 'online' WHERE id = $1
    `, [id]);

    return { status: 'ok', timestamp: Date.now() };
  }

  async handleDiscover({ id, capabilities, status, limit, offset }) {
    const queryLimit = Math.min(limit || CONFIG.defaultLimit, CONFIG.maxLimit);
    const queryOffset = offset || 0;

    let query = `
      SELECT id, address, capabilities, metadata, status,
             EXTRACT(EPOCH FROM (NOW() - last_seen))::int as last_seen
      FROM agents WHERE status != 'offline'
    `;
    const params = [];
    let paramIdx = 1;

    if (id) {
      query += ` AND id != $${paramIdx++}`;
      params.push(id);
    }

    if (capabilities?.length > 0) {
      query += ` AND capabilities ?| $${paramIdx++}`;
      params.push(capabilities);
    }

    if (status) {
      query += ` AND status = $${paramIdx++}`;
      params.push(status);
    }

    query += ` ORDER BY last_seen ASC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(queryLimit, queryOffset);

    const result = await this.pool.query(query, params);

    return {
      status: 'ok',
      count: result.rows.length,
      limit: queryLimit,
      offset: queryOffset,
      agents: result.rows.map(r => ({
        id: r.id,
        address: r.address,
        capabilities: r.capabilities,
        metadata: r.metadata,
        status: r.status,
        lastSeen: r.last_seen
      }))
    };
  }

  async handleFind({ capability, limit, offset }) {
    const queryLimit = Math.min(limit || 10, CONFIG.maxLimit);
    const queryOffset = offset || 0;

    const result = await this.pool.query(`
      SELECT id, address, capabilities, metadata
      FROM agents
      WHERE capabilities ? $1 AND status = 'online'
      ORDER BY last_seen DESC
      LIMIT $2 OFFSET $3
    `, [capability, queryLimit, queryOffset]);

    return { status: 'ok', count: result.rows.length, agents: result.rows };
  }

  async handleLookup({ id }) {
    const result = await this.pool.query(`
      SELECT id, address, capabilities, metadata, status
      FROM agents WHERE id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return { status: 'error', error: 'agent_not_found' };
    }

    return { status: 'ok', agent: result.rows[0] };
  }

  async handleStatus({ id, status, metadata }) {
    const updates = ['last_seen = NOW()'];
    const params = [id];
    let paramIdx = 2;

    if (status) {
      updates.push(`status = $${paramIdx++}`);
      params.push(status);
    }
    if (metadata) {
      updates.push(`metadata = metadata || $${paramIdx++}`);
      params.push(JSON.stringify(metadata));
    }

    await this.pool.query(`UPDATE agents SET ${updates.join(', ')} WHERE id = $1`, params);

    return { status: 'ok' };
  }

  async handleDisconnect({ id }) {
    await this.pool.query(`UPDATE agents SET status = 'offline' WHERE id = $1`, [id]);
    this.clients.delete(id);
    log.info('Agent disconnected', { id: id?.slice(0, 8) });
    return { status: 'ok' };
  }

  async handleStats() {
    const result = await this.pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'online') as online,
        COUNT(*) FILTER (WHERE status = 'idle') as idle,
        COUNT(*) FILTER (WHERE status = 'offline') as offline
      FROM agents
    `);

    return {
      status: 'ok',
      agents: {
        total: parseInt(result.rows[0].total),
        online: parseInt(result.rows[0].online),
        idle: parseInt(result.rows[0].idle),
        offline: parseInt(result.rows[0].offline)
      },
      hub: {
        version: CONFIG.version,
        uptime: Math.floor((Date.now() - this.stats.startTime) / 1000),
        connections: this.stats.connections,
        activeConnections: this.clients.size
      }
    };
  }

  async cleanup() {
    await this.pool.query(`
      UPDATE agents SET status = 'idle'
      WHERE status = 'online' AND last_seen < NOW() - INTERVAL '2 minutes'
    `);

    await this.pool.query(`
      UPDATE agents SET status = 'offline'
      WHERE status = 'idle' AND last_seen < NOW() - INTERVAL '5 minutes'
    `);
  }
}

new M2MHub().start();
