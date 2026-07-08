const { makeWASocket, Browsers, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');

const TAG = chalk.cyan('[WhatsAppService]');
const AUTH_DIR = path.resolve(__dirname, '..', 'data');

fs.mkdirSync(AUTH_DIR, { recursive: true });

const connections = new Map();
const eventListeners = new Map();
const statuses = new Map();
const pairingTimeouts = new Map();

const ConnectionStatus = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CODE_GENERATED: 'code_generated',
  WAITING_PAIRING: 'waiting_pairing',
  CONNECTED: 'connected',
  ERROR: 'error',
};

const PAIRING_TIMEOUT_MS = 60000;
const CONNECTION_TIMEOUT_MS = 30000;

function log(level, msg, ...args) {
  const prefix = chalk.dim(`[${new Date().toLocaleTimeString()}]`);
  const icon = { info: 'ℹ️', ok: '✅', warn: '⚠️ ', error: '❌', debug: '🔍' }[level] || '';
  const colorMap = { info: chalk.blue, ok: chalk.green, warn: chalk.yellow, error: chalk.red, debug: chalk.gray };
  const color = colorMap[level] || chalk.white;
  console.log(`${prefix} ${TAG} ${icon} ${color(msg)}`, ...args);
}

function getAuthDir(deviceId) {
  return path.join(AUTH_DIR, `wa_${deviceId}`);
}

function validatePhoneNumber(phone) {
  if (!phone || typeof phone !== 'string') return 'Número de teléfono requerido';
  const cleaned = phone.replace(/[^0-9]/g, '');
  if (cleaned.length < 8) return 'El número debe tener al menos 8 dígitos (incluyendo código de país, ej: 5491123456789)';
  if (cleaned.length > 15) return 'El número no puede tener más de 15 dígitos';
  return null;
}

function cleanPhoneNumber(phone) {
  return phone.replace(/[^0-9]/g, '');
}

function emitEvent(deviceId, event, data) {
  const listeners = eventListeners.get(deviceId);
  if (!listeners) return;
  (listeners.get(event) || []).forEach(cb => {
    try { cb(data); } catch (e) {
      log('error', `Error en listener '${event}': ${e.message}`);
    }
  });
}

function on(deviceId, event, callback) {
  if (!eventListeners.has(deviceId)) eventListeners.set(deviceId, new Map());
  const deviceListeners = eventListeners.get(deviceId);
  if (!deviceListeners.has(event)) deviceListeners.set(event, []);
  deviceListeners.get(event).push(callback);
  return () => {
    const list = deviceListeners.get(event);
    if (list) {
      const idx = list.indexOf(callback);
      if (idx !== -1) list.splice(idx, 1);
    }
  };
}

function removeAllListeners(deviceId) {
  eventListeners.delete(deviceId);
}

async function connect(phoneNumber, deviceId = 'default', options = {}) {
  const validationError = validatePhoneNumber(phoneNumber);
  if (validationError) {
    log('error', `Validación fallida para ${deviceId}: ${validationError}`);
    statuses.set(deviceId, ConnectionStatus.ERROR);
    emitEvent(deviceId, 'status', ConnectionStatus.ERROR);
    emitEvent(deviceId, 'error', new Error(validationError));
    return;
  }

  phoneNumber = cleanPhoneNumber(phoneNumber);

  const { skipAuthCleanup = false } = options;

  const logMode = skipAuthCleanup ? '🔄 reconexión' : '🔌 primera conexión';
  log('info', `Iniciando conexión (${logMode}) — teléfono: ${chalk.bold(phoneNumber)}, dispositivo: ${chalk.bold(deviceId)}`);

  if (connections.has(deviceId)) {
    log('warn', `Cerrando conexión existente para ${deviceId}...`);
    await disconnect(deviceId);
  }

  if (pairingTimeouts.has(deviceId)) {
    clearTimeout(pairingTimeouts.get(deviceId));
    pairingTimeouts.delete(deviceId);
  }

  statuses.set(deviceId, ConnectionStatus.CONNECTING);
  emitEvent(deviceId, 'status', ConnectionStatus.CONNECTING);

  try {
    const authDir = getAuthDir(deviceId);

    if (!skipAuthCleanup) {
      log('debug', `Limpiando auth state en ${authDir}...`);
      try {
        fs.rmSync(authDir, { recursive: true, force: true });
      } catch { /* si no existe, ok */ }
      fs.mkdirSync(authDir, { recursive: true });
    } else {
      log('debug', 'Skip auth cleanup — usando credenciales existentes (reconexión post-pairing)');
    }

    log('debug', `Cargando credenciales desde ${authDir}...`);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      syncFullHistory: false,
      browser: Browsers.windows('Chrome'),
      markOnlineOnConnect: false,
      keepAliveIntervalMs: 30000,
      generateHighQualityLinkPreview: false,
    });

    connections.set(deviceId, { sock, saveCreds, phoneNumber });

    /**
     * Registrar TODOS los handlers ANTES de cualquier await
     * para no perder eventos de cierre/error durante la conexión inicial.
     */
    let connectionOpenHandled = false;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      // isNewLogin = pairing fue aceptado por el usuario en el teléfono
      if (update.isNewLogin) {
        const sep = chalk.dim('─'.repeat(50));
        console.log(`\n${sep}`);
        log('ok', `${chalk.bold('📱 Pairing aceptado en el teléfono')}`);
        log('ok', 'Credenciales actualizadas, esperando reconexión...');
        console.log(`${sep}\n`);
        // El connection.update handler con connection:'close' + 515 se encarga
      }

      if (connection === 'open') {
        if (connectionOpenHandled) return;
        connectionOpenHandled = true;

        const isRegistered = sock?.authState?.creds?.registered;
        if (!isRegistered) {
          // Conexión inicial antes del pairing — no emitir CONNECTED todavía.
          // Baileys abre el socket para el noise handshake, pero el dispositivo
          // aún no está vinculado. requestPairingCode se encarga del flujo.
          log('debug', 'Socket abierto, pero dispositivo no registrado — esperando pairing...');
          return;
        }

        if (pairingTimeouts.has(deviceId)) {
          clearTimeout(pairingTimeouts.get(deviceId));
          pairingTimeouts.delete(deviceId);
        }
        const conn = connections.get(deviceId);
        const phone = conn?.phoneNumber || 'desconocido';
        const sep = chalk.dim('─'.repeat(50));
        console.log(`\n${sep}`);
        log('ok', `${chalk.bold('¡WhatsApp vinculado exitosamente!')}`);
        console.log(`${chalk.dim('  Teléfono:')}      ${chalk.white(phone)}`);
        console.log(`${chalk.dim('  Dispositivo:')}   ${chalk.white(deviceId)}`);
        console.log(`${chalk.dim('  Estado:')}        ${chalk.green('CONECTADO')}`);
        log('ok', 'Sesión de WhatsApp activa — mensajes y contactos disponibles');
        console.log(`${sep}\n`);
        statuses.set(deviceId, ConnectionStatus.CONNECTED);
        emitEvent(deviceId, 'status', ConnectionStatus.CONNECTED);
      }

      if (connection === 'close') {
        const prevStatus = statuses.get(deviceId);
        const error = lastDisconnect?.error;
        const statusCode = error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isRestartRequired = statusCode === DisconnectReason.restartRequired;
        const isConnectionClosed = statusCode === DisconnectReason.connectionClosed;

        log('warn', `Conexión cerrada (código: ${statusCode}, estado previo: ${prevStatus})`);

        // ── 515 (restartRequired): pairing exitoso o reconexión normal ──
        if (isRestartRequired) {
          if (prevStatus === ConnectionStatus.WAITING_PAIRING) {
            const sep = chalk.dim('─'.repeat(50));
            console.log(`\n${sep}`);
            log('ok', `${chalk.bold('¡Vinculación exitosa!')} — WhatsApp pide reconectar`);
            log('ok', 'El código fue aceptado. Reconectando con sesión autorizada...');
            log('ok', 'Las credenciales se conservarán (skipAuthCleanup=true)');
            console.log(`${sep}\n`);
            if (pairingTimeouts.has(deviceId)) {
              clearTimeout(pairingTimeouts.get(deviceId));
              pairingTimeouts.delete(deviceId);
            }
            // Marcar como CONECTADO antes de reconectar para que el frontend lo sepa
            statuses.set(deviceId, ConnectionStatus.CONNECTED);
            emitEvent(deviceId, 'status', ConnectionStatus.CONNECTED);
          } else {
            log('info', 'Reinicio requerido por WhatsApp, reconectando en 1.5s...');
          }
          setTimeout(() => {
            connect(phoneNumber, deviceId, { skipAuthCleanup: prevStatus === ConnectionStatus.WAITING_PAIRING }).catch(err => {
              log('error', `Error en reconexión: ${err.message}`);
              statuses.set(deviceId, ConnectionStatus.ERROR);
              emitEvent(deviceId, 'status', ConnectionStatus.ERROR);
              emitEvent(deviceId, 'error', err);
            });
          }, 1500);
          return;
        }

        // ── WAITING_PAIRING sin restartRequired → fallo real ──
        if (prevStatus === ConnectionStatus.WAITING_PAIRING) {
          const sep = chalk.dim('─'.repeat(50));
          console.log(`\n${sep}`);
          log('warn', `${chalk.bold('Vinculación fallida')} — conexión cerrada durante el pareo`);

          if (isConnectionClosed) {
            log('error', `La conexión con WhatsApp fue terminada abruptamente (código ${statusCode})`);
            log('error', 'Posibles causas: el servidor/IP puede estar temporalmente bloqueado,');
            log('error', 'o el identificador del dispositivo no es reconocido por WhatsApp.');
            log('info', 'Se limpiará el estado de autenticación. Reintentá la vinculación.');
            const authDir = getAuthDir(deviceId);
            try {
              fs.rmSync(authDir, { recursive: true, force: true });
              fs.mkdirSync(authDir, { recursive: true });
              log('ok', `Estado de autenticación limpiado en ${authDir}`);
            } catch (cleanErr) {
              log('warn', `No se pudo limpiar auth state: ${cleanErr.message}`);
            }
          } else {
            log('warn', 'El código pudo haber expirado o el número ser incorrecto');
          }
          console.log(`${sep}\n`);
          if (pairingTimeouts.has(deviceId)) {
            clearTimeout(pairingTimeouts.get(deviceId));
            pairingTimeouts.delete(deviceId);
          }
          statuses.set(deviceId, ConnectionStatus.ERROR);
          emitEvent(deviceId, 'status', ConnectionStatus.ERROR);
          emitEvent(deviceId, 'error', new Error(
            isConnectionClosed
              ? 'Conexión terminada por WhatsApp. Posible bloqueo temporal del servidor. Reintentá en unos minutos.'
              : 'La vinculación no se completó. El código pudo expirar o fue rechazado.'
          ));
          emitEvent(deviceId, 'pairingExpired', true);
          connections.delete(deviceId);
          return;
        }

        if (isLoggedOut) {
          log('error', 'Sesión cerrada — el usuario se deslogueó de WhatsApp');
          statuses.set(deviceId, ConnectionStatus.DISCONNECTED);
          emitEvent(deviceId, 'status', ConnectionStatus.DISCONNECTED);
          connections.delete(deviceId);
          return;
        }

        log('info', 'Reconectando en 3s...');
        statuses.set(deviceId, ConnectionStatus.CONNECTING);
        emitEvent(deviceId, 'status', ConnectionStatus.CONNECTING);
        setTimeout(() => {
          connect(phoneNumber, deviceId).catch(err => {
            log('error', `Error en reconexión: ${err.message}`);
            statuses.set(deviceId, ConnectionStatus.ERROR);
            emitEvent(deviceId, 'status', ConnectionStatus.ERROR);
            emitEvent(deviceId, 'error', err);
          });
        }, 3000);
      }
    });

    sock.ev.on('creds.update', async () => {
      const wasRegistered = sock.authState.creds.registered;
      if (wasRegistered) {
        log('ok', '¡Credenciales guardadas — dispositivo registrado en WhatsApp!');
        log('ok', `  ID: ${sock.authState.creds.me?.id || 'desconocido'}`);
      }
      await saveCreds();
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      emitEvent(deviceId, 'messages.upsert', { messages, type });
      // Extraer contactos de nuevos mensajes
      extractContactsFromMessages(messages, deviceId);
    });

    sock.ev.on('messaging-history.set', async ({ messages, contacts, isLatest }) => {
      emitEvent(deviceId, 'messaging-history.set', { messages, contacts, isLatest });
      const contactCount = contacts ? (Array.isArray(contacts) ? contacts.length : Object.keys(contacts).length) : 0;
      log('info', `Historial de WhatsApp recibido: ${messages.length} mensajes, ${contactCount} contactos, último=${isLatest ? 'sí' : 'no'}`);
      // Extraer contactos del historial completo
      extractContactsFromMessages(messages, deviceId);
      if (contacts) {
        extractContactsFromContactsMap(contacts, deviceId);
      }
    });

    // 1) Esperar a que el WebSocket subyacente esté abierto
    log('info', 'Estableciendo conexión con WhatsApp...');
    try {
      await Promise.race([
        sock.waitForSocketOpen(),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error(`Tiempo de espera de conexión agotado (${CONNECTION_TIMEOUT_MS / 1000}s)`)),
          CONNECTION_TIMEOUT_MS
        )),
      ]);
      log('ok', `Socket abierto para ${deviceId}`);
    } catch (connErr) {
      const msg = connErr?.message || 'Error de conexión con WhatsApp';
      log('error', `No se pudo conectar con WhatsApp: ${msg}`);
      statuses.set(deviceId, ConnectionStatus.ERROR);
      emitEvent(deviceId, 'status', ConnectionStatus.ERROR);
      emitEvent(deviceId, 'error', { message: msg });
      connections.delete(deviceId);
      return;
    }

    // 2) Esperar a que el noise handshake termine antes de modificar creds
    log('info', 'Esperando handshake de WhatsApp...');
    try {
      const handshakeResult = await Promise.race([
        sock.waitForConnectionUpdate((u) => u.connection === 'open' || u.connection === 'close'),
        new Promise((r) => setTimeout(() => r('timeout'), 5000)),
      ]);
      if (handshakeResult === 'timeout') {
        log('warn', 'Handshake no se completó en 5s, continuando de todas formas...');
      } else if (handshakeResult?.connection === 'open') {
        log('ok', 'Handshake completado');
      } else if (handshakeResult?.connection === 'close') {
        throw new Error('Conexión cerrada durante el handshake');
      }
    } catch (connErr) {
      const msg = connErr?.message || 'Error de handshake con WhatsApp';
      log('error', `Handshake fallido: ${msg}`);
      statuses.set(deviceId, ConnectionStatus.ERROR);
      emitEvent(deviceId, 'status', ConnectionStatus.ERROR);
      emitEvent(deviceId, 'error', { message: msg });
      connections.delete(deviceId);
      return;
    }
    log('ok', `Estado del socket tras handshake: registered=${!!sock?.authState?.creds?.registered}`);

    // 3) Proceder con registro / pairing code si no está registrado
    if (!sock.authState.creds.registered) {
      if (skipAuthCleanup) {
        // Reconexión post-pairing: las credenciales aún no tienen registered=true,
        // pero el pairing ya fue aceptado. Esperar a que Baileys se conecte.
        log('info', 'Reconexión post-pairing — NO solicitar nuevo código');
        log('info', 'Esperando que WhatsApp valide la sesión existente...');
        // No llamar a requestPairingCode; Baileys usará creds.me para login
        statuses.set(deviceId, ConnectionStatus.WAITING_PAIRING);
        emitEvent(deviceId, 'status', ConnectionStatus.WAITING_PAIRING);
        return; // El socket se encarga; los handlers de close/open decidirán
      }

      log('info', 'Solicitando código de vinculación a WhatsApp...');

      // Normalizar número de Argentina: si empieza con 54 pero sin 9, agregarlo
      let waNumber = phoneNumber;
      if (waNumber.startsWith('54') && waNumber.length >= 12 && !waNumber.startsWith('549')) {
        // Formato sin 9: 541168888486 → 5491168888486
        const alternative = `549${waNumber.slice(2)}`;
        log('warn', `Número sin 9: ${waNumber}, sugiriendo: ${alternative}`);
        log('warn', 'Si WhatsApp dice "número incorrecto", probá con el formato alternativo.');
        // Dejar el original (con 9 si ya viene, sin 9 si no tiene)
      }
      // Si el usuario ingresó 549..., usar tal cual

      const code = await sock.requestPairingCode(waNumber);
      const formattedCode = `${code.slice(0, 4)}-${code.slice(4)}`;

      const separator = chalk.dim('─'.repeat(50));
      console.log(`\n${separator}`);
      log('ok', `${chalk.bold('¡Código de vinculación generado!')}`);
      console.log(`${chalk.dim('  Teléfono:')}      ${chalk.bold.white(waNumber)}`);
      console.log(`${chalk.dim('  Dispositivo:')}   ${chalk.white(deviceId)}`);
      console.log(`${chalk.dim('  Código:')}        ${chalk.bold.bgGreen.black(` ${formattedCode} `)}`);
      console.log(`${chalk.dim('  Válido por:')}    ${chalk.white('60 segundos')}`);
      console.log(`${separator}\n`);
      log('info', `Instrucciones: WhatsApp → ⋮ → Dispositivos vinculados → Vincular con número → ingresar: ${chalk.bold(formattedCode)}`);
      log('warn', `⚠️  El código es para el número ${chalk.bold(waNumber)}. Si usás otro número en WhatsApp, no funcionará.`);

      statuses.set(deviceId, ConnectionStatus.CODE_GENERATED);
      emitEvent(deviceId, 'status', ConnectionStatus.CODE_GENERATED);
      emitEvent(deviceId, 'pairingCode', formattedCode);
      emitEvent(deviceId, 'pairingPhoneNumber', waNumber);

      statuses.set(deviceId, ConnectionStatus.WAITING_PAIRING);
      emitEvent(deviceId, 'status', ConnectionStatus.WAITING_PAIRING);

      const timeout = setTimeout(() => {
        if (statuses.get(deviceId) === ConnectionStatus.WAITING_PAIRING) {
          log('warn', `Código de vinculación expirado para ${deviceId}`);
          console.log(`${chalk.dim('─'.repeat(50))}`);
          log('warn', `${chalk.bold('Código expirado:')} ${chalk.red(formattedCode)} — no se completó la vinculación a tiempo`);
          log('warn', 'Solictá un nuevo código con otro intento de vinculación');
          console.log(`${chalk.dim('─'.repeat(50))}\n`);
          statuses.set(deviceId, ConnectionStatus.ERROR);
          emitEvent(deviceId, 'status', ConnectionStatus.ERROR);
          emitEvent(deviceId, 'error', new Error('El código de vinculación expiró. Solicitá uno nuevo.'));
          emitEvent(deviceId, 'pairingExpired', true);
          if (connections.has(deviceId)) {
            const conn = connections.get(deviceId);
            conn.sock?.end(undefined);
            connections.delete(deviceId);
          }
        }
        pairingTimeouts.delete(deviceId);
      }, PAIRING_TIMEOUT_MS);
      pairingTimeouts.set(deviceId, timeout);

    } else {
      log('ok', `Dispositivo ${deviceId} ya registrado y conectado`);
      statuses.set(deviceId, ConnectionStatus.CONNECTED);
      emitEvent(deviceId, 'status', ConnectionStatus.CONNECTED);
    }

    emitEvent(deviceId, 'socket', sock);

  } catch (err) {
    log('error', `Error en connect(): ${err.message}`);
    log('debug', `Stack: ${err.stack}`);
    statuses.set(deviceId, ConnectionStatus.ERROR);
    emitEvent(deviceId, 'status', ConnectionStatus.ERROR);
    emitEvent(deviceId, 'error', err);
  }
}

async function disconnect(deviceId = 'default') {
  log('info', `Desconectando dispositivo ${deviceId}...`);
  const connection = connections.get(deviceId);
  if (connection) {
    try {
      await connection.sock.logout();
      log('ok', `Sesión cerrada para ${deviceId}`);
    } catch (e) {
      log('warn', `Error al cerrar sesión: ${e.message}`);
    }
    try {
      connection.sock?.end(undefined);
    } catch (e) {
      // ignore
    }
    connections.delete(deviceId);
  }

  if (pairingTimeouts.has(deviceId)) {
    clearTimeout(pairingTimeouts.get(deviceId));
    pairingTimeouts.delete(deviceId);
  }

  const sep = chalk.dim('─'.repeat(50));
  console.log(`\n${sep}`);
  log('ok', `Dispositivo ${chalk.bold(deviceId)} desconectado`);
  console.log(`${sep}\n`);

  statuses.set(deviceId, ConnectionStatus.DISCONNECTED);
  emitEvent(deviceId, 'status', ConnectionStatus.DISCONNECTED);
}

function getStatus(deviceId = 'default') {
  return statuses.get(deviceId) || ConnectionStatus.DISCONNECTED;
}

async function sendMessage(deviceId, jid, text) {
  const connection = connections.get(deviceId);
  if (!connection) throw new Error('No hay conexión activa de WhatsApp');
  log('debug', `Enviando mensaje a ${jid}...`);
  return connection.sock.sendMessage(jid, { text });
}

function getDevices() {
  try {
    const dirs = fs.readdirSync(AUTH_DIR).filter(d => d.startsWith('wa_'));
    return dirs.map(d => ({
      deviceId: d.replace('wa_', ''),
      status: statuses.get(d.replace('wa_', '')) || ConnectionStatus.DISCONNECTED,
    }));
  } catch (e) {
    log('error', `Error listando dispositivos: ${e.message}`);
    return [];
  }
}

function clearAuthState(deviceId = 'default') {
  const authDir = getAuthDir(deviceId);
  log('info', `Limpiando estado de autenticación para ${deviceId}...`);
  try {
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
    }
    fs.mkdirSync(authDir, { recursive: true });
    log('ok', `Estado de autenticación eliminado para ${deviceId}`);
    return { ok: true, deviceId };
  } catch (e) {
    log('error', `Error limpiando auth state: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/**
 * Extrae contactos únicos de un array de mensajes de WhatsApp
 * y emite evento 'whatsapp.contacts' para que el frontend los procese.
 */
function extractContactsFromMessages(messages, deviceId) {
  if (!messages || messages.length === 0) return;

  const contactsMap = new Map();

  for (const msg of messages) {
    const jid = msg.key?.remoteJid;
    if (!jid) continue;
    // Solo contactos individuales (no grupos)
    if (!jid.includes('@s.whatsapp.net') && !jid.includes('@c.us')) continue;

    if (contactsMap.has(jid)) continue;

    const pushName = msg.pushName || '';
    const phone = jid.replace(/[^0-9]/g, '').slice(0, 15);
    const timestamp = msg.messageTimestamp
      ? new Date(msg.messageTimestamp * 1000).toISOString()
      : null;

    contactsMap.set(jid, {
      jid,
      pushName,
      phone,
      lastMessageAt: timestamp,
    });
  }

  if (contactsMap.size > 0) {
    const contacts = Array.from(contactsMap.values());
    log('ok', `Contactos extraídos de mensajes: ${contacts.length} únicos para ${deviceId}`);
    emitEvent(deviceId, 'whatsapp.contacts', { contacts, deviceId });
  }
}

/**
 * Extrae contactos desde el mapa de contactos de messaging-history.set
 * (Baileys envía { [jid]: { name, notify } })
 */
function extractContactsFromContactsMap(contactsData, deviceId) {
  if (!contactsData) return;

  let entries = [];
  if (Array.isArray(contactsData)) {
    entries = contactsData;
  } else if (typeof contactsData === 'object') {
    entries = Object.entries(contactsData).map(([jid, info]) => ({ jid, ...info }));
  }

  if (entries.length === 0) return;

  const contacts = [];
  for (const entry of entries) {
    const jid = entry.jid || '';
    if (!jid.includes('@s.whatsapp.net') && !jid.includes('@c.us')) continue;

    const phone = jid.replace(/[^0-9]/g, '').slice(0, 15);
    const pushName = entry.notify || entry.name || entry.verifiedName || '';

    contacts.push({
      jid,
      pushName,
      phone,
      lastMessageAt: new Date().toISOString(),
    });
  }

  if (contacts.length > 0) {
    log('ok', `Contactos extraídos del mapa de contactos: ${contacts.length} únicos para ${deviceId}`);
    emitEvent(deviceId, 'whatsapp.contacts', { contacts, deviceId });
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
