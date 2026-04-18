import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const PORT = 3000;
const AUDIT_LOG_FILE = 'audit.log';

// In-memory state
const queues: Record<string, any[]> = {}; // queue_id -> [blobs]
const subscribers: Record<string, Set<WebSocket>> = {}; // queue_id -> Set of sockets
const stats = {
  activeQueues: 0,
  messageCount: 0,
  realMessages: 0,
  decoyMessages: 0,
};

// Helper: Logging
function logToAudit(queueId: string, blob: any) {
  const hQueue = crypto.createHash('sha256').update(queueId).digest('hex');
  const blobContent = typeof blob === 'string' ? blob : JSON.stringify(blob);
  const hBlob = crypto.createHash('sha256').update(blobContent).digest('hex');
  const timestamp = Math.floor(Date.now() / 1000);
  const logLine = `${hQueue}|${hBlob}|${timestamp}\n`;
  fs.appendFileSync(AUDIT_LOG_FILE, logLine);
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  // API: Stats for dashboard
  app.get('/api/stats', (req, res) => {
    stats.activeQueues = Object.keys(queues).length;
    res.json(stats);
  });

  // Step 1: POST /send/<queue_id>
  app.post('/send/:queueId', (req, res) => {
    const { queueId } = req.params;
    const { data } = req.body;

    if (!data) {
      return res.status(400).json({ error: 'No data provided' });
    }

    if (!queues[queueId]) {
      queues[queueId] = [];
    }
    
    queues[queueId].push(data);
    stats.messageCount++;
    stats.realMessages++;
    
    logToAudit(queueId, data);

    // Broadcast to subscribers
    if (subscribers[queueId]) {
      subscribers[queueId].forEach(sub => {
        if (sub.readyState === WebSocket.OPEN) {
          sub.send(JSON.stringify({ type: 'message', data }));
        }
      });
    }

    res.json({ status: 'sent' });
  });

  // API: New v1 endpoint for messages (matches client expectations)
  app.post('/api/v1/messages/:queueId', (req, res) => {
    const { queueId } = req.params;
    const data = req.body;  // Client sends the entire encrypted object { nonce, box }

    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'No data provided' });
    }

    if (!queues[queueId]) {
      queues[queueId] = [];
    }
    
    queues[queueId].push(data);
    stats.messageCount++;
    stats.realMessages++;
    
    logToAudit(queueId, data);

    // Broadcast to subscribers
    if (subscribers[queueId]) {
      subscribers[queueId].forEach(sub => {
        if (sub.readyState === WebSocket.OPEN) {
          sub.send(JSON.stringify({ type: 'message', ciphertext: data }));
        }
      });
    }

    res.json({ status: 'sent' });
  });

  // API: Audit Log
  app.get('/api/audit', (req, res) => {
    if (fs.existsSync(AUDIT_LOG_FILE)) {
      const content = fs.readFileSync(AUDIT_LOG_FILE, 'utf-8');
      res.send(content);
    } else {
      res.send('No audit log yet.');
    }
  });

  // WebSocket handling
  server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url || '', `http://${request.headers.host}`);
    
    if (pathname.startsWith('/subscribe/')) {
      const queueId = pathname.split('/subscribe/')[1];
      if (queueId) {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request, queueId);
        });
      } else {
        socket.destroy();
      }
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket, req: any, queueId: string) => {
    // Add to subscribers
    if (!subscribers[queueId]) {
      subscribers[queueId] = new Set();
    }
    subscribers[queueId].add(ws);

    // If queue doesn't exist, create it (in-memory)
    if (!queues[queueId]) {
      queues[queueId] = [];
    }

    // Send buffered messages (demo requirement: "send any buffered messages first")
    queues[queueId].forEach((msg) => {
      ws.send(JSON.stringify({ type: 'message', data: msg }));
    });

    ws.on('message', (message) => {
      try {
        const payload = JSON.parse(message.toString());
        // Relay blob
        const blob = payload.data;
        if (blob) {
          queues[queueId].push(blob);
          stats.messageCount++;
          stats.realMessages++;
          
          logToAudit(queueId, blob);

          // Broadcast to other subscribers
          subscribers[queueId].forEach(sub => {
            if (sub !== ws && sub.readyState === WebSocket.OPEN) {
              sub.send(JSON.stringify({ type: 'message', data: blob }));
            }
          });
        }
      } catch (e) {
        console.error('Failed to process message', e);
      }
    });

    ws.on('close', () => {
      subscribers[queueId]?.delete(ws);
      if (subscribers[queueId]?.size === 0) {
        // Optional: Keep queue for some time? 
        // For hackathon, we keep for 30m as per instructions later.
      }
    });
  });

  // Step 6: Decoy Traffic
  setInterval(() => {
    const activeQueueIds = Object.keys(subscribers);
    if (activeQueueIds.length === 0) return;

    activeQueueIds.forEach(queueId => {
      // Chance to send decoy
      if (Math.random() > 0.3) { // Send decoy 70% of intervals
        const fakeBlob = crypto.randomBytes(64 + Math.floor(Math.random() * 192)).toString('base64');
        stats.decoyMessages++;
        subscribers[queueId].forEach(sub => {
          if (sub.readyState === WebSocket.OPEN) {
            sub.send(JSON.stringify({ type: 'decoy', data: fakeBlob }));
          }
        });
      }
    });
  }, 5000); // 5 sec interval

  // Step 9ish: Queue Expiry (In-memory Cleanup)
  const QUEUE_TTL = 1800 * 1000; // 30 minutes
  const queueLastActive: Record<string, number> = {};
  
  setInterval(() => {
    const now = Date.now();
    Object.keys(queues).forEach(qid => {
      if (subscribers[qid] && subscribers[qid].size > 0) {
        queueLastActive[qid] = now;
      }
      if (now - (queueLastActive[qid] || 0) > QUEUE_TTL) {
        delete queues[qid];
        delete subscribers[qid];
        delete queueLastActive[qid];
      }
    });
  }, 60000);

  // Vite setup
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve('dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

startServer();
