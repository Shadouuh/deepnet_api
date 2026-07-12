const path = require('path');
const fs = require('fs');

const AUTH_ROOT = path.resolve(__dirname, '..', '..', 'data');
fs.mkdirSync(AUTH_ROOT, { recursive: true });

function getAuthDir(deviceId) {
  return path.join(AUTH_ROOT, `wa_${deviceId}`);
}

module.exports = { AUTH_ROOT, getAuthDir };
