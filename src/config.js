const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
}
loadEnv();

module.exports = {
  ROOT,
  PORT: process.env.PORT || 3000,
  LLM_KEY: process.env.LLM_API_KEY || '',
  LLM_BASE: (process.env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, ''),
  LLM_MODEL: process.env.LLM_MODEL || 'deepseek-chat'
};