const crypto = require('crypto');
const db = require('./db');

const sessions = new Map(); // token -> user_id（内存加速层，凭证本体在 tokens 表）

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function hash(salt, pw) {
  return crypto.createHash('sha256').update(salt + '::' + pw).digest('hex');
}

function currentUser(req) {
  const token = parseCookies(req).shiy_token;
  if (!token) return null;
  if (sessions.has(token)) return sessions.get(token);
  const row = db.prepare('SELECT user_id, expires_at FROM tokens WHERE token=?').get(token);
  if (!row || row.expires_at < Date.now()) {
    if (row) db.prepare('DELETE FROM tokens WHERE token=?').run(token);
    return null;
  }
  sessions.set(token, row.user_id);
  return row.user_id;
}

const THIRTY_DAYS = 30 * 24 * 3600 * 1000;

function setAuth(res, userId) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, userId);
  db.prepare('INSERT INTO tokens(token,user_id,expires_at) VALUES(?,?,?)').run(token, userId, Date.now() + THIRTY_DAYS);
  return { 'Set-Cookie': 'shiy_token=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000' };
}

function clearToken(token) {
  if (!token) return;
  sessions.delete(token);
  db.prepare('DELETE FROM tokens WHERE token=?').run(token);
}

module.exports = { parseCookies, hash, currentUser, setAuth, clearToken };