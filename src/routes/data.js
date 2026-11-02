const db = require('../db');
const { json, readBody } = require('../lib/http');
const { commentsFor } = require('../content');

function itemRow(r) {
  return { ...r, tags: JSON.parse(r.tags || '[]') };
}

module.exports = async function dataRoutes(req, res, ctx) {
  const { pathname, method, me } = ctx;

  if (method === 'GET' && pathname === '/api/state') {
    const folders = db.prepare('SELECT * FROM folders WHERE user_id=? ORDER BY id').all(me);
    const books = db.prepare('SELECT * FROM books WHERE user_id=? ORDER BY id').all(me);
    const items = db.prepare('SELECT * FROM items WHERE user_id=? ORDER BY id DESC').all(me).map(itemRow);
    let comments = [];
    for (const iid of items.map(i => i.id)) comments = comments.concat(commentsFor(iid, me));
    // 跨用户广场：公开收藏夹的内容 + 带推荐语的内容，附带作者与热评
    const square = db.prepare(`SELECT i.id, i.title, i.one_sentence, i.minutes, i.recommend_note, i.author_name, i.user_id,
      u.username AS owner, f.name AS folder_name,
      (SELECT COUNT(*) FROM comments c WHERE c.item_id = i.id) AS comment_count,
      (SELECT COALESCE(NULLIF(u2.nickname,''), u2.username, c.user_name) || '：' || c.text FROM comments c LEFT JOIN users u2 ON u2.id = c.user_id WHERE c.item_id = i.id ORDER BY (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = c.id) DESC, c.id DESC LIMIT 1) AS hot_comment
      FROM items i LEFT JOIN folders f ON f.id = i.folder_id LEFT JOIN users u ON u.id = i.user_id
      WHERE f.is_public = 1 OR (i.recommend_note IS NOT NULL AND i.recommend_note != '')
      ORDER BY i.id DESC LIMIT 50`).all();
    const u = db.prepare('SELECT username FROM users WHERE id=?').get(me);
    json(res, 200, { folders, books, items, comments, square, llm: !!require('../config').LLM_KEY, username: u ? u.username : '同学' });
    return true;
  }

  if (method === 'POST' && pathname === '/api/folders') {
    const b = await readBody(req);
    if (!b.name) return json(res, 400, { error: '缺少名称' }), true;
    const id = db.prepare('INSERT INTO folders(user_id,name,is_public) VALUES(?,?,?)')
      .run(me, String(b.name).slice(0, 40), b.is_public ? 1 : 0).lastInsertRowid;
    json(res, 200, { id });
    return true;
  }

  const fm = pathname.match(/^\/api\/folders\/(\d+)$/);
  if (method === 'PATCH' && fm) {
    const b = await readBody(req);
    const f = db.prepare('SELECT * FROM folders WHERE id=? AND user_id=?').get(Number(fm[1]), me);
    if (!f) return json(res, 404, { error: 'not found' }), true;
    if ('name' in b) db.prepare('UPDATE folders SET name=? WHERE id=?').run(String(b.name).slice(0, 40), f.id);
    if ('is_public' in b) db.prepare('UPDATE folders SET is_public=? WHERE id=?').run(b.is_public ? 1 : 0, f.id);
    json(res, 200, { ok: true });
    return true;
  }

  if (method === 'POST' && pathname === '/api/books') {
    const b = await readBody(req);
    if (!b.title) return json(res, 400, { error: '缺少书名' }), true;
    const id = db.prepare('INSERT INTO books(user_id,title,author,note) VALUES(?,?,?,?)')
      .run(me, String(b.title).slice(0, 80), String(b.author || '').slice(0, 40), String(b.note || '').slice(0, 200)).lastInsertRowid;
    json(res, 200, { id });
    return true;
  }

  return false;
};