const { useMultiFileAuthState } = require('@whiskeysockets/baileys');

/**
 * Envuelve useMultiFileAuthState y serializa saveCreds.
 *
 * Baileys puede emitir varios `creds.update` en rápida sucesión durante el
 * registro (creds base, luego `account`, `signalIdentities`, etc.). Sin
 * encolar las escrituras, dos llamadas concurrentes a fs.writeFile sobre el
 * mismo creds.json pueden completarse fuera de orden y dejar en disco una
 * versión incompleta — justo la que se usa en la reconexión obligatoria que
 * WhatsApp exige para terminar el login. Encolar garantiza que la escritura
 * que persiste en disco sea siempre la última en completarse.
 */
async function createAuthState(authDir) {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  let queue = Promise.resolve();
  const persistCreds = () => {
    queue = queue.then(saveCreds);
    return queue;
  };

  // Expuesto para que quien reconecte (nuevo socket) pueda esperar a que
  // toda escritura de creds en curso de ESTE socket termine de flushear a
  // disco antes de volver a leer el auth state. Sin esto, un `close` que
  // llega justo después de un `creds.update` (p. ej. tras validar el
  // pairing code) puede disparar un `start()` que lea creds.json todavía
  // desactualizado — con `registered` en false — y vuelva a pedir otro
  // pairing code sobre un intento que en realidad ya había sido aceptado.
  const waitForPendingWrites = () => queue;

  return { state, saveCreds: persistCreds, waitForPendingWrites };
}

module.exports = { createAuthState };
