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

  return { state, saveCreds: persistCreds };
}

module.exports = { createAuthState };
