const { makeWASocket, Browsers, DisconnectReason } = require('@whiskeysockets/baileys');
const fs = require('fs');
const { createAuthState } = require('./AuthState');
const { getAuthDir } = require('./paths');
const { log } = require('./logger');
const { extractContactsFromMessages, extractContactsFromContactsMap } = require('./ContactExtractor');

const ConnectionStatus = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CODE_GENERATED: 'code_generated',
  CONNECTED: 'connected',
  ERROR: 'error',
};

const PAIRING_SOCKET_TIMEOUT_MS = 15000;
const PAIRING_SOCKET_GRACE_MS = 250;
const TRANSIENT_RETRY_COOLDOWN_MS = 15000;

// Nombres legibles para los códigos de DisconnectReason de Baileys, usados
// solo para mostrar logs más claros — no cambian ninguna decisión de flujo.
const DISCONNECT_REASON_NAMES = Object.entries(DisconnectReason).reduce((acc, [name, code]) => {
  acc[code] = name;
  return acc;
}, {});

function serializeError(error) {
  if (!error) return null;
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    statusCode: error.output?.statusCode,
    payload: error.output?.payload,
    data: error.data,
  };
}

function reportDebug(hypothesisId, location, msg, data = {}) {
  // #region debug-point A:socket-reporting
  const envPath = require('path').resolve(__dirname, '..', '..', '.dbg', 'baileys-connect-close.env');
  let url = 'http://127.0.0.1:7777/event';
  let sessionId = 'baileys-connect-close';
  try {
    const env = fs.readFileSync(envPath, 'utf8');
    url = env.match(/DEBUG_SERVER_URL=(.+)/)?.[1] || url;
    sessionId = env.match(/DEBUG_SESSION_ID=(.+)/)?.[1] || sessionId;
  } catch (_) {}
  if (typeof fetch === 'function') {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, runId: 'post-fix', hypothesisId, location, msg, data, ts: Date.now() }),
    }).catch(() => {});
  }
  // #endregion
}

function describeDisconnect(lastDisconnect) {
  const statusCode = lastDisconnect?.error?.output?.statusCode;
  const reasonName = DISCONNECT_REASON_NAMES[statusCode] || 'desconocido';
  const rawMessage = lastDisconnect?.error?.output?.payload?.message
    || lastDisconnect?.error?.message
    || 'sin mensaje';
  return { statusCode, reasonName, rawMessage };
}

/**
 * Representa el ciclo de vida completo de UN dispositivo de WhatsApp.
 *
 * Reglas de diseño (no negociables):
 *  - Un único socket vivo a la vez (`this.starting` evita creación paralela).
 *  - `start()` es el único lugar donde se llama a makeWASocket().
 *  - Nunca se destruye un socket manualmente mientras se está autenticando;
 *    solo reaccionamos a lo que Baileys reporta vía `connection.update`.
 *  - El auth state solo se limpia ante DisconnectReason.loggedOut o una
 *    desvinculación explícita del usuario (disconnect()). Nunca por timeout,
 *    nunca por una reconexión automática.
 *  - Si las credenciales ya están registradas (`state.creds.registered`),
 *    nunca se vuelve a pedir un pairing code.
 */
class WhatsAppConnection {
  constructor(deviceId, phoneNumber, emit) {
    this.deviceId = deviceId;
    this.phoneNumber = phoneNumber;
    this.emit = emit; // (event, data) => void
    this.sock = null;
    this.status = ConnectionStatus.DISCONNECTED;
    this.starting = false;
    this.waitForPendingWrites = null;
    this.manualDisconnect = false;
    this.lastKnownRegistered = false;
    this.socketGeneration = 0;
    this.lastConnectionUpdate = null;
    this.lastConnectionUpdateGeneration = 0;
    this.cooldownUntil = 0;
  }

  setStatus(status) {
    this.status = status;
    this.emit('status', status);
  }

  setPhoneNumber(phoneNumber) {
    this.phoneNumber = phoneNumber;
  }

  canStartNewAttempt() {
    return Date.now() >= this.cooldownUntil;
  }

  getRetryAfterMs() {
    return Math.max(0, this.cooldownUntil - Date.now());
  }

  clearTransientCooldown() {
    this.cooldownUntil = 0;
  }

  applyTransientCooldown(reason, extra = {}) {
    const retryAfterMs = Math.max(this.getRetryAfterMs(), TRANSIENT_RETRY_COOLDOWN_MS);
    this.cooldownUntil = Date.now() + retryAfterMs;
    reportDebug('E', 'src/whatsapp/WhatsAppConnection.js:applyTransientCooldown', '[DEBUG] transient cooldown applied', {
      deviceId: this.deviceId,
      reason,
      retryAfterMs,
      ...extra,
    });
    return retryAfterMs;
  }

  async ensureFreshSocketBeforeStart() {
    if (!this.sock) return;
    try {
      this.sock.end(undefined);
    } catch (_) {}
    this.sock = null;
  }

  async waitForPairingSocketReady(sock, socketGeneration) {
    if (this.lastConnectionUpdateGeneration !== socketGeneration) {
      await new Promise((resolve, reject) => {
        let settled = false;
        let timeoutId;
        const finish = (callback) => (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          sock.ev.off('connection.update', onUpdate);
          callback(value);
        };
        const resolveReady = finish(resolve);
        const rejectReady = finish(reject);
        const onUpdate = (update) => {
          if (this.socketGeneration !== socketGeneration || this.sock !== sock) {
            rejectReady(new Error('Socket reemplazado antes de estar listo para pairing'));
            return;
          }
          if (update.connection === 'close') {
            rejectReady(update.lastDisconnect?.error || new Error('Socket cerrado antes del pairing'));
            return;
          }
          resolveReady(undefined);
        };
        timeoutId = setTimeout(() => rejectReady(new Error('Timeout esperando connection.update para pairing')), PAIRING_SOCKET_TIMEOUT_MS);
        sock.ev.on('connection.update', onUpdate);
      });
    }

    await Promise.race([
      sock.waitForSocketOpen(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout esperando WebSocket abierto para pairing')), PAIRING_SOCKET_TIMEOUT_MS)),
    ]);

    if (PAIRING_SOCKET_GRACE_MS > 0) {
      await new Promise(resolve => setTimeout(resolve, PAIRING_SOCKET_GRACE_MS));
    }

    if (this.socketGeneration !== socketGeneration || this.sock !== sock) {
      throw new Error('Socket reemplazado antes de solicitar el pairing code');
    }
  }

  /**
   * Único punto de entrada para crear un socket. Si ya hay uno en proceso
   * de creación, no hace nada — jamás deben coexistir dos sockets para el
   * mismo deviceId.
   */
  async start() {
    if (this.starting) {
      log('warn', `[${this.deviceId}] start() ignorado — ya hay una conexión en curso`);
      // #region debug-point C:start-rejected
      reportDebug('C', 'src/whatsapp/WhatsAppConnection.js:start', '[DEBUG] start ignored because connection is already starting', {
        deviceId: this.deviceId,
        status: this.status,
      });
      // #endregion
      return;
    }
    this.starting = true;
    this.manualDisconnect = false;

    try {
      // Si el socket anterior todavía tiene una escritura de creds en
      // curso (p. ej. el `creds.update` que llega justo antes de un
      // `close` tras validar el pairing code), hay que esperar a que
      // termine de persistirse en disco ANTES de volver a leer el auth
      // state. De lo contrario `useMultiFileAuthState` puede leer un
      // creds.json todavía viejo (con `registered: false`) y este start()
      // pediría un pairing code nuevo sobre un intento que WhatsApp ya
      // había aceptado, rompiendo el flujo de vinculación.
      if (this.waitForPendingWrites) {
        await this.waitForPendingWrites().catch(() => {});
      }

      const authDir = getAuthDir(this.deviceId);
      fs.mkdirSync(authDir, { recursive: true });
      await this.ensureFreshSocketBeforeStart();

      const { state, saveCreds, waitForPendingWrites } = await createAuthState(authDir);
      this.waitForPendingWrites = waitForPendingWrites;
      this.lastKnownRegistered = Boolean(state?.creds?.registered);
      // #region debug-point C:start-state
      reportDebug('C', 'src/whatsapp/WhatsAppConnection.js:start', '[DEBUG] starting socket with auth state snapshot', {
        deviceId: this.deviceId,
        status: this.status,
        authDir,
        registered: state?.creds?.registered,
        hasMe: Boolean(state?.creds?.me?.id),
      });
      // #endregion

      const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        syncFullHistory: false,
        browser: Browsers.windows('Chrome'),
        markOnlineOnConnect: false,
        keepAliveIntervalMs: 30000,
        generateHighQualityLinkPreview: false,
      });

      this.sock = sock;
      const socketGeneration = ++this.socketGeneration;
      this.lastConnectionUpdate = null;
      this.lastConnectionUpdateGeneration = 0;
      this.setStatus(ConnectionStatus.CONNECTING);

      // Todos los listeners se registran de inmediato, antes de cualquier
      // await adicional, para no perder eventos tempranos.
      sock.ev.on('creds.update', () => {
        this.lastKnownRegistered = Boolean(sock?.authState?.creds?.registered || this.lastKnownRegistered);
        return saveCreds();
      });
      sock.ev.on('connection.update', (update) => {
        this.lastConnectionUpdate = update;
        this.lastConnectionUpdateGeneration = socketGeneration;
        this.handleConnectionUpdate(update, sock, socketGeneration);
      });

      sock.ev.on('messages.upsert', ({ messages }) => {
        this.emit('messages.upsert', { messages });
        const contacts = extractContactsFromMessages(messages);
        if (contacts.length) this.emit('whatsapp.contacts', { contacts, deviceId: this.deviceId });
      });

      sock.ev.on('messaging-history.set', ({ messages, contacts, isLatest }) => {
        this.emit('messaging-history.set', { messages, contacts, isLatest });
        const all = [
          ...extractContactsFromMessages(messages),
          ...extractContactsFromContactsMap(contacts),
        ];
        if (all.length) this.emit('whatsapp.contacts', { contacts: all, deviceId: this.deviceId });
      });

      // Fuente de verdad: el estado real persistido, no una bandera interna.
      // Si ya está registrado, jamás se vuelve a pedir un código.
      if (!state.creds.registered) {
        log('info', `[${this.deviceId}] Solicitando código de vinculación para ${this.phoneNumber}...`);
        await this.waitForPairingSocketReady(sock, socketGeneration);
        // #region debug-point C:request-pairing
        reportDebug('C', 'src/whatsapp/WhatsAppConnection.js:start', '[DEBUG] requesting pairing code', {
          deviceId: this.deviceId,
          phoneNumber: this.phoneNumber,
          socketGeneration,
        });
        // #endregion
        const code = await sock.requestPairingCode(this.phoneNumber);
        const formatted = `${code.slice(0, 4)}-${code.slice(4)}`;
        log('ok', `[${this.deviceId}] Código de vinculación: ${formatted}`);
        this.setStatus(ConnectionStatus.CODE_GENERATED);
        this.emit('pairingCode', formatted);
        this.emit('pairingPhoneNumber', this.phoneNumber);
      }
    } catch (err) {
      const statusCode = err?.output?.statusCode;
      const reasonName = statusCode != null ? (DISCONNECT_REASON_NAMES[statusCode] || 'desconocido') : null;
      const detail = reasonName ? ` [${reasonName} / ${statusCode}]` : '';
      const errorDetails = serializeError(err);
      const shouldApplyTransientCooldown = statusCode === DisconnectReason.connectionClosed
        || statusCode === DisconnectReason.connectionLost
        || statusCode === DisconnectReason.timedOut;
      const retryAfterMs = shouldApplyTransientCooldown
        ? this.applyTransientCooldown('start-failed-before-pairing', { statusCode, reasonName })
        : 0;
      // #region debug-point E:start-error
      reportDebug('E', 'src/whatsapp/WhatsAppConnection.js:start', '[DEBUG] start() failed', {
        deviceId: this.deviceId,
        status: this.status,
        reasonName,
        error: errorDetails,
        retryAfterMs,
      });
      // #endregion
      log('error', `[${this.deviceId}] Error iniciando conexión${detail}: ${err.message}`);
      if (errorDetails) {
        log('debug', `[${this.deviceId}] Detalle técnico del error: ${JSON.stringify(errorDetails)}`);
      }
      if (retryAfterMs > 0) {
        log('warn', `[${this.deviceId}] WhatsApp cerró el intento antes de aceptar el pairing. Voy a enfriar reintentos durante ${Math.ceil(retryAfterMs / 1000)}s para no seguir golpeando el handshake.`);
      }
      this.setStatus(ConnectionStatus.ERROR);
      this.emit('error', Object.assign(err, retryAfterMs > 0 ? { retryAfterMs } : null));
    } finally {
      this.starting = false;
    }
  }

  /**
   * Único manejador de connection.update. Sigue exactamente el patrón
   * recomendado por Baileys: en 'open' se marca conectado; en 'close' se
   * analiza únicamente el DisconnectReason — loggedOut limpia la sesión,
   * cualquier otro motivo (incluido el reinicio 515 obligatorio tras
   * aceptar el pairing code) simplemente reinicia el socket con el mismo
   * auth state ya persistido en disco.
   */
  handleConnectionUpdate(update, sourceSock = this.sock, socketGeneration = this.socketGeneration) {
    const { connection, lastDisconnect } = update;
    const isCurrentSocket = sourceSock === this.sock && socketGeneration === this.socketGeneration;
    // #region debug-point D:connection-update
    reportDebug('D', 'src/whatsapp/WhatsAppConnection.js:handleConnectionUpdate', '[DEBUG] connection.update received', {
      deviceId: this.deviceId,
      connection,
      status: this.status,
      socketGeneration,
      isCurrentSocket,
      manualDisconnect: this.manualDisconnect,
      lastDisconnect: lastDisconnect ? {
        error: serializeError(lastDisconnect.error),
        date: lastDisconnect.date,
      } : null,
    });
    // #endregion

    if (!isCurrentSocket) {
      log('debug', `[${this.deviceId}] Ignorando evento de un socket viejo (generation=${socketGeneration})`);
      return;
    }

    if (connection === 'open') {
      const id = sourceSock?.authState?.creds?.me?.id || 'sin id';
      this.lastKnownRegistered = true;
      this.clearTransientCooldown();
      log('ok', `[${this.deviceId}] Conexión abierta — dispositivo vinculado (${id})`);
      this.setStatus(ConnectionStatus.CONNECTED);
      return;
    }

    if (connection === 'close') {
      const { statusCode, reasonName, rawMessage } = describeDisconnect(lastDisconnect);
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const hadRegisteredSession = Boolean(
        sourceSock?.authState?.creds?.registered
        || this.status === ConnectionStatus.CONNECTED
        || this.lastKnownRegistered
      );
      const isEarlyHandshakeFailure = isLoggedOut && !hadRegisteredSession && this.status !== ConnectionStatus.CONNECTED;

      log('warn', `[${this.deviceId}] Conexión cerrada — motivo: ${reasonName} (código ${statusCode ?? 'desconocido'}) — "${rawMessage}"`);
      this.sock = null;

      if (this.manualDisconnect) {
        log('info', `[${this.deviceId}] Cierre recibido durante una desconexión manual; no se limpia auth ni se reconecta`);
        this.setStatus(ConnectionStatus.DISCONNECTED);
        return;
      }

      if (isEarlyHandshakeFailure) {
        const retryAfterMs = this.applyTransientCooldown('early-handshake-failure', { statusCode, reasonName });
        const diagnosticMessage = `[${this.deviceId}] Falló el handshake inicial de Baileys antes de que existiera una sesión registrada. Se conserva el auth state actual para no romper el flujo. Esto suele apuntar a bloqueo/rate-limit/IP reputacional de WhatsApp o a un fallo transitorio de Noise.`;
        log('error', diagnosticMessage);
        log('warn', `[${this.deviceId}] Se activó un enfriamiento de ${Math.ceil(retryAfterMs / 1000)}s para evitar múltiples requests de pairing contra WhatsApp.`);
        if (lastDisconnect?.error) {
          log('debug', `[${this.deviceId}] Detalle técnico del cierre: ${JSON.stringify(serializeError(lastDisconnect.error))}`);
        }
        this.setStatus(ConnectionStatus.ERROR);
        this.emit('error', Object.assign(new Error(diagnosticMessage), {
          cause: lastDisconnect?.error,
          statusCode,
          reasonName,
          rawMessage,
          retryAfterMs,
        }));
        return;
      }

      if (isLoggedOut) {
        // #region debug-point D:logged-out-close
        reportDebug('D', 'src/whatsapp/WhatsAppConnection.js:handleConnectionUpdate', '[DEBUG] close treated as loggedOut and auth state will be cleared', {
          deviceId: this.deviceId,
          statusCode,
          reasonName,
          rawMessage,
          statusBeforeClear: this.status,
        });
        // #endregion
        log('error', `[${this.deviceId}] WhatsApp cerró la sesión (401/loggedOut) — limpiando auth state y reiniciando desde cero. Si esto ocurre en el PRIMER intento (antes de ingresar el código en el teléfono), no es un logout real: normalmente indica que la conexión Noise falló (revisar el mensaje de error arriba) — causas típicas: la IP del servidor está bloqueada/limitada por WhatsApp (común en datacenters como Render/AWS/GCP), o hay un auth state corrupto de un intento anterior.`);
        this.clearAuthState();
        this.setStatus(ConnectionStatus.DISCONNECTED);
        return;
      }

      // #region debug-point D:retry-close
      reportDebug('D', 'src/whatsapp/WhatsAppConnection.js:handleConnectionUpdate', '[DEBUG] close treated as retryable and start() will be called again', {
        deviceId: this.deviceId,
        statusCode,
        reasonName,
        rawMessage,
      });
      // #endregion
      log('info', `[${this.deviceId}] Motivo no es loggedOut — reconectando con el mismo auth state (comportamiento esperado si aún no se ingresó el código, o si es el reinicio obligatorio tras validarlo)`);
      this.start().catch(err => {
        log('error', `[${this.deviceId}] Error reconectando: ${err.message}`);
        this.setStatus(ConnectionStatus.ERROR);
        this.emit('error', err);
      });
    }
  }

  clearAuthState() {
    const authDir = getAuthDir(this.deviceId);
    try {
      // #region debug-point D:clear-auth
      reportDebug('D', 'src/whatsapp/WhatsAppConnection.js:clearAuthState', '[DEBUG] clearing auth state directory', {
        deviceId: this.deviceId,
        authDir,
      });
      // #endregion
      fs.rmSync(authDir, { recursive: true, force: true });
      fs.mkdirSync(authDir, { recursive: true });
    } catch (e) {
      log('warn', `[${this.deviceId}] No se pudo limpiar auth state: ${e.message}`);
    }
    this.waitForPendingWrites = null;
  }

  /** Desvinculación explícita solicitada por el usuario (no automática). */
  async disconnect() {
    // #region debug-point B:service-disconnect
    reportDebug('B', 'src/whatsapp/WhatsAppConnection.js:disconnect', '[DEBUG] explicit disconnect() invoked', {
      deviceId: this.deviceId,
      status: this.status,
      hasSocket: Boolean(this.sock),
      callerStack: new Error('disconnect() origin').stack,
    });
    // #endregion
    this.manualDisconnect = true;
    if (this.sock) {
      try { await this.sock.logout(); } catch (e) { /* la sesión ya puede estar cerrada */ }
      try { this.sock.end(undefined); } catch (e) { /* ignore */ }
      this.sock = null;
    }
    this.clearAuthState();
    this.setStatus(ConnectionStatus.DISCONNECTED);
  }

  async sendMessage(jid, text) {
    if (!this.sock) throw new Error('No hay conexión activa de WhatsApp');
    return this.sock.sendMessage(jid, { text });
  }
}

module.exports = { WhatsAppConnection, ConnectionStatus };
