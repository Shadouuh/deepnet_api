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
  }

  setStatus(status) {
    this.status = status;
    this.emit('status', status);
  }

  /**
   * Único punto de entrada para crear un socket. Si ya hay uno en proceso
   * de creación, no hace nada — jamás deben coexistir dos sockets para el
   * mismo deviceId.
   */
  async start() {
    if (this.starting) {
      log('warn', `[${this.deviceId}] start() ignorado — ya hay una conexión en curso`);
      return;
    }
    this.starting = true;

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

      const { state, saveCreds, waitForPendingWrites } = await createAuthState(authDir);
      this.waitForPendingWrites = waitForPendingWrites;

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
      this.setStatus(ConnectionStatus.CONNECTING);

      // Todos los listeners se registran de inmediato, antes de cualquier
      // await adicional, para no perder eventos tempranos.
      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', (update) => this.handleConnectionUpdate(update));

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
        const code = await sock.requestPairingCode(this.phoneNumber);
        const formatted = `${code.slice(0, 4)}-${code.slice(4)}`;
        log('ok', `[${this.deviceId}] Código de vinculación: ${formatted}`);
        this.setStatus(ConnectionStatus.CODE_GENERATED);
        this.emit('pairingCode', formatted);
        this.emit('pairingPhoneNumber', this.phoneNumber);
      }
    } catch (err) {
      log('error', `[${this.deviceId}] Error iniciando conexión: ${err.message}`);
      this.setStatus(ConnectionStatus.ERROR);
      this.emit('error', err);
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
  handleConnectionUpdate(update) {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      const id = this.sock?.authState?.creds?.me?.id || 'sin id';
      log('ok', `[${this.deviceId}] Conexión abierta — dispositivo vinculado (${id})`);
      this.setStatus(ConnectionStatus.CONNECTED);
      return;
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      log('warn', `[${this.deviceId}] Conexión cerrada (código ${statusCode ?? 'desconocido'})`);
      this.sock = null;

      if (isLoggedOut) {
        log('error', `[${this.deviceId}] Sesión cerrada por WhatsApp — limpiando auth state`);
        this.clearAuthState();
        this.setStatus(ConnectionStatus.DISCONNECTED);
        return;
      }

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
      fs.rmSync(authDir, { recursive: true, force: true });
      fs.mkdirSync(authDir, { recursive: true });
    } catch (e) {
      log('warn', `[${this.deviceId}] No se pudo limpiar auth state: ${e.message}`);
    }
    this.waitForPendingWrites = null;
  }

  /** Desvinculación explícita solicitada por el usuario (no automática). */
  async disconnect() {
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
