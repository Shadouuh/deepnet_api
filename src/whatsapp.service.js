/**
 * Punto de entrada legacy. La implementación real vive en ./whatsapp/
 * (arquitectura modular: WhatsAppConnection, AuthState, ContactExtractor).
 * Este archivo se mantiene solo para no romper los require() existentes.
 */
module.exports = require('./whatsapp');
