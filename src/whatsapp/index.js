const fs = require('fs');
const { WhatsAppConnection, ConnectionStatus } = require('./WhatsAppConnection');
const { AUTH_ROOT, getAuthDir } = require('./paths');
const { log } = require('./logger');

// Un único WhatsAppConnection vivo por deviceId. Nunca se crea uno nuevo
// mientras el anterior siga activo — connect() lo garantiza abajo.
const instances = new Map();
const eventListeners = new Map();

const ACTIVE_STATUSES = new Set([
  ConnectionStatus.CONNECTING,
  ConnectionStatus.CODE_GENERATED,
  ConnectionStatus.CONNECTED,
]);

function emitEvent(deviceId, event, data) {
  const listeners = eventListeners.get(deviceId);
  if (!listeners) return;
  (listeners.get(event) || []).forEach(cb => {
    try { cb(data); } catch (e) {
      log('error', `Listener '${event}' falló para ${deviceId}: ${e.message}`);
    }
  });
}

function on(deviceId, event, callback) {
  if (!eventListeners.has(deviceId)) eventListeners.set(deviceId, new Map());
  const map = eventListeners.get(deviceId);
  if (!map.has(event)) map.set(event, []);
  map.get(event).push(callback);
  return () => {
    const list = map.get(event);
    if (list) {
      const idx = list.indexOf(callback);
      if (idx !== -1) list.splice(idx, 1);
    }
  };
}

function removeAllListeners(deviceId) {
  eventListeners.delete(deviceId);
}

function validatePhoneNumber(phone) {
  if (!phone || typeof phone !== 'string') return 'Número de teléfono requerido';
  const cleaned = phone.replace(/[^0-9]/g, '');
  if (cleaned.length < 8) return 'El número debe tener al menos 8 dígitos (incluyendo código de país, ej: 5491123456789)';
  if (cleaned.length > 15) return 'El número no puede tener más de 15 dígitos';
  return null;
}

/**
 * Inicia (o reutiliza) la conexión de un dispositivo. Si ya hay una
 * instancia activa (conectando, esperando pairing, o ya conectada), no se
 * crea una segunda — se ignora el pedido para evitar sockets duplicados,
 * sin importar cuántas veces se llame desde afuera (reintentos del
 * frontend, dobles clicks, etc.).
 */
async function connect(phoneNumber, deviceId = 'default') {
  const validationError = validatePhoneNumber(phoneNumber);
  if (validationError) {
    log('error', `Validación fallida para ${deviceId}: ${validationError}`);
    emitEvent(deviceId, 'status', ConnectionStatus.ERROR);
    emitEvent(deviceId, 'error', new Error(validationError));
    return;
  }

  const cleaned = phoneNumber.replace(/[^0-9]/g, '');

  const existing = instances.get(deviceId);
  if (existing && ACTIVE_STATUSES.has(existing.status)) {
    log('warn', `[${deviceId}] Ya hay una conexión activa (${existing.status}) — se ignora el nuevo pedido`);
    return;
  }

  const connection = new WhatsAppConnection(deviceId, cleaned, (event, data) => emitEvent(deviceId, event, data));
  instances.set(deviceId, connection);
  await connection.start();
}

/** Desvinculación explícita solicitada por el usuario. */
async function disconnect(deviceId = 'default') {
  const connection = instances.get(deviceId);
  if (!connection) {
    log('warn', `[${deviceId}] No hay conexión activa para desconectar`);
    return;
  }
  await connection.disconnect();
  instances.delete(deviceId);
}

function getStatus(deviceId = 'default') {
  return instances.get(deviceId)?.status || ConnectionStatus.DISCONNECTED;
}

async function sendMessage(deviceId, jid, text) {
  const connection = instances.get(deviceId);
  if (!connection) throw new Error('No hay conexión activa de WhatsApp');
  return connection.sendMessage(jid, text);
}

function getDevices() {
  try {
    const dirs = fs.readdirSync(AUTH_ROOT).filter(d => d.startsWith('wa_'));
    return dirs.map(d => {
      const deviceId = d.replace('wa_', '');
      return { deviceId, status: instances.get(deviceId)?.status || ConnectionStatus.DISCONNECTED };
    });
  } catch (e) {
    log('error', `Error listando dispositivos: ${e.message}`);
    return [];
  }
}

/** Desvinculación explícita a demanda (endpoint de administración). */
async function clearAuthState(deviceId = 'default') {
  const connection = instances.get(deviceId);
  if (connection) {
    await connection.disconnect();
    instances.delete(deviceId);
    return { ok: true, deviceId };
  }

  const authDir = getAuthDir(deviceId);
  try {
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.mkdirSync(authDir, { recursive: true });
    return { ok: true, deviceId };
  } catch (e) {
    log('error', `Error limpiando auth state: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

module.exports = {
  ConnectionStatus,
  connect,
  disconnect,
  getStatus,
  sendMessage,
  getDevices,
  clearAuthState,
  on,
  removeAllListeners,
};
