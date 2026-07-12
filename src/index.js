require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
// Also try loading from root (monorepo) — does not override if already set
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const chalk = require('chalk');
const {
  connect,
  disconnect,
  getStatus,
  getDevices,
  sendMessage,
  clearAuthState,
  on,
  ConnectionStatus,
} = require('./whatsapp.service');

const PORT = process.env.BACKEND_PORT || process.env.PORT || 3001;
const CORS_ORIGIN = process.env.BACKEND_CORS_ORIGIN || process.env.CORS_ORIGIN || '*';
const app = express();
const server = http.createServer(app);

app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  const start = Date.now();
  res.on('finish', () => {
    const method = chalk.cyan(req.method.padEnd(6));
    const url = chalk.white(req.originalUrl);
    const status = res.statusCode >= 400 ? chalk.red(res.statusCode) : chalk.green(res.statusCode);
    const ms = chalk.dim(`${Date.now() - start}ms`);
    console.log(`  ${method} ${url} ${status} ${ms}`);
  });
  next();
});

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

app.get('/api/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// La protección contra sockets duplicados vive en WhatsAppConnection/index
// del servicio (fuente única de verdad): si ya hay una conexión activa para
// el deviceId, connect() la ignora en vez de crear una segunda. Acá no se
// duplica esa lógica.
app.post('/api/whatsapp/connect', asyncHandler(async (req, res) => {
  const { phoneNumber, deviceId = 'default' } = req.body;
  if (!phoneNumber) {
    return res.status(400).json({ error: 'El número de teléfono es requerido' });
  }

  connect(phoneNumber, deviceId).catch(err => {
    console.error(chalk.red(`  💥 Error en connect() para ${deviceId}:`), err);
  });
  res.json({ ok: true, message: 'Conectando...' });
}));

app.post('/api/whatsapp/disconnect', asyncHandler(async (req, res) => {
  const { deviceId = 'default' } = req.body;
  await disconnect(deviceId);
  res.json({ ok: true });
}));

app.get('/api/whatsapp/status/:deviceId?', (req, res) => {
  const deviceId = req.params.deviceId || 'default';
  const s = getStatus(deviceId);
  res.json({ deviceId, status: s, isConnected: s === ConnectionStatus.CONNECTED });
});

app.get('/api/whatsapp/devices', (req, res) => {
  res.json(getDevices());
});

app.delete('/api/whatsapp/auth/:deviceId?', asyncHandler(async (req, res) => {
  const deviceId = req.params.deviceId || 'default';
  const result = await clearAuthState(deviceId);
  if (result.ok) {
    res.json({ ok: true, message: `Auth state cleared for ${deviceId}` });
  } else {
    res.status(500).json({ error: result.error });
  }
}));

app.post('/api/whatsapp/send', asyncHandler(async (req, res) => {
  const { deviceId = 'default', jid, text } = req.body;
  if (!jid || !text) {
    return res.status(400).json({ error: 'jid y text son requeridos' });
  }
  await sendMessage(deviceId, jid, text);
  res.json({ ok: true });
}));

app.use((err, req, res, next) => {
  console.error(chalk.red(`  💥 Error en ${req.method} ${req.originalUrl}:`), err);
  res.status(500).json({ error: err.message || 'Error interno del servidor' });
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(chalk.dim(`  [WS] Cliente conectado desde ${clientIp}`));

  const subs = new Set();
  const activeHandlers = new Map();

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (msg.type === 'subscribe' && msg.deviceId) {
        subs.add(msg.deviceId);

        if (!activeHandlers.has(msg.deviceId)) {
          const events = ['status', 'pairingCode', 'pairingPhoneNumber', 'error', 'pairingExpired', 'messages.upsert', 'messaging-history.set', 'whatsapp.contacts'];
          const handlers = {};

          for (const eventType of events) {
            const deviceId = msg.deviceId;
            const handler = (data) => {
              if (ws.readyState === 1 && (subs.has(deviceId) || subs.size === 0)) {
                const payload = data instanceof Error
                  ? { message: data.message, name: data.name, stack: data.stack }
                  : data;
                ws.send(JSON.stringify({ type: 'event', deviceId, eventType, data: payload }));
              }
            };
            const unsub = on(deviceId, eventType, handler);
            handlers[eventType] = unsub;
          }

          activeHandlers.set(msg.deviceId, handlers);
        }
      }

      if (msg.type === 'unsubscribe' && msg.deviceId) {
        subs.delete(msg.deviceId);
      }
    } catch (e) {
      console.error(chalk.red(`  [WS] Mensaje inválido:`), e.message);
    }
  });

  ws.on('close', () => {
    console.log(chalk.dim(`  [WS] Cliente desconectado`));
    for (const [, handlers] of activeHandlers) {
      for (const unsub of Object.values(handlers)) {
        unsub();
      }
    }
    subs.clear();
    activeHandlers.clear();
  });
});

process.on('uncaughtException', (err) => {
  console.error(chalk.red(`\n  💥 Excepción no capturada: ${err.message}`));
  console.error(chalk.dim(err.stack));
});

process.on('unhandledRejection', (reason) => {
  console.error(chalk.red(`\n  💥 Promesa rechazada no capturada: ${reason?.message || reason}`));
});

server.listen(PORT, () => {
  console.log(`\n  ${chalk.bold('🚀 DeepNet WhatsApp Backend')}`);
  console.log(`  ${chalk.dim('━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}`);
  console.log(`  ${chalk.cyan('📡 HTTP:')}     ${chalk.underline(`http://localhost:${PORT}`)}`);
  console.log(`  ${chalk.cyan('🔌 WebSocket:')} ${chalk.underline(`ws://localhost:${PORT}`)}`);
  console.log(`  ${chalk.cyan('📁 Auth data:')} ./data/`);
  console.log(`  ${chalk.cyan('🩺 Health:')}    ${chalk.underline(`http://localhost:${PORT}/api/health`)}`);
  console.log(`  ${chalk.dim('━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}\n`);
});
