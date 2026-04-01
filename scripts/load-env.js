const fs = require('fs');
const path = require('path');

function parseEnv(content) {
  const out = {};
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) out[key] = value;
  }
  return out;
}

function loadEnv(cwd = process.cwd()) {
  const envPath = path.join(cwd, '.env');
  if (!fs.existsSync(envPath)) return null;
  const parsed = parseEnv(fs.readFileSync(envPath, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) process.env[key] = value;
  return envPath;
}

module.exports = { loadEnv };
