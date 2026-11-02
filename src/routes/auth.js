const crypto = require('crypto');
const db = require('../db');
const { json, readBody } = require('../lib/http');
const { setAuth, hash, clearToken, parseCookies } = require('../auth');

module.exports = async function authRoutes(req, res, ctx) {
  const { pathname, method } = ctx;

  if (method === 'POST' && pathname === '/api/register') {
    const b = await readBody(req);
    const username = String(b.username || '').trim();
    const password = String(b.password || '');
    if (!/^[\u4e00-\u9fa5a-zA-Z0-9_]{2,20}$/.test(username)) return json(res, 400, { error: '用户名需为2-20位中文/字母/数字' }), true;
    if (password.length < 4) return json(res, 400, { error: '密码至少4位' }), true;
    if (db.prepare('SELECT id FROM users WHERE username=?').get(username)) return json(res, 400, { error: '用户名已被使用' }), true;
    const salt = crypto.randomBytes(8).toString('hex');
    const id = db.prepare('INSERT INTO users(username,salt,passhash) VALUES(?,?,?)')
      .run(username, salt, hash(salt, password)).lastInsertRowid;
    db.prepare('INSERT INTO folders(user_id,name,is_public) VALUES(?,?,0)').run(id, '收件箱');
    json(res, 200, { ok: true }, setAuth(res, id));
    return true;
  }

  if (method === 'POST' && pathname === '/api/login') {
    const b = await readBody(req);
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(b.username || '').trim());
    if (!u || u.passhash !== hash(u.salt, String(b.password || ''))) return json(res, 400, { error: '用户名或密码错误' }), true;
    json(res, 200, { ok: true }, setAuth(res, u.id));
    return true;
  }

  if (method === 'POST' && pathname === '/api/logout') {
    clearToken(parseCookies(req).shiy_token);
    json(res, 200, { ok: true }, { 'Set-Cookie': 'shiy_token=; Path=/; Max-Age=0' });
    return true;
  }

  const me = ctx.me;
  if (!me) return false;

  if (method === 'GET' && pathname === '/api/me') {
    const u = db.prepare('SELECT username, nickname, bio, avatar FROM users WHERE id=?').get(me);
    json(res, 200, u ? { username: u.username, nickname: u.nickname || '', bio: u.bio || '', avatar: u.avatar || '' } : { username: '同学', nickname: '', bio: '', avatar: '' });
    return true;
  }

  if (method === 'PATCH' && pathname === '/api/profile') {
    const b = await readBody(req);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(me);
    const nickname = 'nickname' in b ? String(b.nickname || '').trim().slice(0, 20) : (u.nickname || '');
    const bio = 'bio' in b ? String(b.bio || '').slice(0, 300) : (u.bio || '');
    let avatar = u.avatar || '';
    if ('avatar' in b) {
      const a = String(b.avatar || '');
      if (a && !/^data:image\/(png|jpe?g|gif|webp);base64,/.test(a)) return json(res, 400, { error: '头像仅支持图片文件' }), true;
      if (a.length > 300000) return json(res, 400, { error: '头像图片太大，请换一张小图' }), true;
      avatar = a;
    }
    db.prepare('UPDATE users SET nickname=?, bio=?, avatar=? WHERE id=?').run(nickname, bio, avatar, me);
    json(res, 200, { ok: true });
    return true;
  }

  if (method === 'GET' && pathname === '/api/fav-comments') {
    const rows = db.prepare(`SELECT c.*, i.title AS item_title,
      COALESCE(NULLIF(u.nickname,''), u.username, c.user_name) AS user_name, u.avatar AS user_avatar,
      (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id=c.id) AS like_count,
      EXISTS(SELECT 1 FROM comment_likes cl WHERE cl.comment_id=c.id AND cl.user_id=?) AS liked_by_me
      FROM comment_favs cf JOIN comments c ON c.id=cf.comment_id JOIN items i ON i.id=c.item_id
      LEFT JOIN users u ON u.id=c.user_id WHERE cf.user_id=? ORDER BY cf.rowid DESC`).all(me, me);
    json(res, 200, { comments: rows });
    return true;
  }

  return false;
};