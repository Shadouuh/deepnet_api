/**
 * Extrae contactos únicos de un array de mensajes de WhatsApp.
 */
function extractContactsFromMessages(messages) {
  if (!messages || messages.length === 0) return [];

  const map = new Map();
  for (const msg of messages) {
    const jid = msg.key?.remoteJid;
    if (!jid) continue;
    if (!jid.includes('@s.whatsapp.net') && !jid.includes('@c.us')) continue;
    if (map.has(jid)) continue;

    const phone = jid.replace(/[^0-9]/g, '').slice(0, 15);
    const timestamp = msg.messageTimestamp
      ? new Date(msg.messageTimestamp * 1000).toISOString()
      : null;

    map.set(jid, {
      jid,
      pushName: msg.pushName || '',
      phone,
      lastMessageAt: timestamp,
    });
  }

  return Array.from(map.values());
}

/**
 * Extrae contactos desde el mapa de contactos de messaging-history.set
 * (Baileys envía { [jid]: { name, notify } }).
 */
function extractContactsFromContactsMap(contactsData) {
  if (!contactsData) return [];

  let entries = [];
  if (Array.isArray(contactsData)) {
    entries = contactsData;
  } else if (typeof contactsData === 'object') {
    entries = Object.entries(contactsData).map(([jid, info]) => ({ jid, ...info }));
  }

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

  return contacts;
}

module.exports = { extractContactsFromMessages, extractContactsFromContactsMap };
