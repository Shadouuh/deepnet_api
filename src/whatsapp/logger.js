const chalk = require('chalk');

const TAG = chalk.cyan('[WhatsApp]');

const ICONS = { info: 'ℹ️', ok: '✅', warn: '⚠️ ', error: '❌', debug: '🔍' };
const COLORS = { info: chalk.blue, ok: chalk.green, warn: chalk.yellow, error: chalk.red, debug: chalk.gray };

function log(level, msg) {
  const prefix = chalk.dim(`[${new Date().toLocaleTimeString()}]`);
  const icon = ICONS[level] || '';
  const color = COLORS[level] || chalk.white;
  console.log(`${prefix} ${TAG} ${icon} ${color(msg)}`);
}

module.exports = { log };
