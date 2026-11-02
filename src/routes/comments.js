const db = require('../db');
const { json, readBody } = require('../lib/http');

module.exports = async function commentRoutes(req, res, ctx) {
  const { pathname, method, me } = ctx;

  if (method === 'POST' && pathname === '/api/comments') {
    const b = await readBody(req);
    if (!b.item_id || !b.text) return json(res, 400, { error: '缺少内容' }), true;
    const target = db.prepare('SELECT id FROM items WHERE id=?').get(Number(b.item_id));
    if (!target) return json(res, 404, { error: 'not found' }), true;
    const u = db.prepare('SELECT username FROM users WHERE id=?').get(me);
    const id = db.prepare('INSERT INTO comments(item_id,user_id,user_name,text) VALUES(?,?,?,?)')
      .run(Number(b.item_id), me, String(b.user_name || (u ? u.username : '同学')).slice(0, 20), String(b.text).slice(0, 2000)).lastInsertRowid;
    json(res, 200, { id });
    return true;
  }

  const cm = pathname.match(/^\/api\/comments\/(\d+)\/(like|fav)$/);
  if (method === 'POST' && cm) {
    const cid = Number(cm[1]);
    const table = cm[2] === 'like' ? 'comment_likes' : 'comment_favs';
    const exists = db.prepare('SELECT 1 FROM ' + table + ' WHERE comment_id=? AND user_id=?').get(cid, me);
    if (exists) db.prepare('DELETE FROM ' + table + ' WHERE comment_id=? AND user_id=?').run(cid, me);
    else db.prepare('INSERT INTO ' + table + ' (comment_id,user_id) VALUES(?,?)').run(cid, me);
    const count = db.prepare('SELECT COUNT(*) AS n FROM ' + table + ' WHERE comment_id=?').get(cid).n;
    json(res, 200, { active: !exists, count });
    return true;
  }

  return false;
};