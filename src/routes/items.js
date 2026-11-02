const db = require('../db');
const { json, readBody } = require('../lib/http');
const { LLM_KEY } = require('../config');
const { llm, analyzePrompt, fallbackAnalyze } = require('../llm');
const { extractFromUrl, chunkText, commentsFor } = require('../content');

function itemRow(r) {
  return { ...r, tags: JSON.parse(r.tags || '[]') };
}

module.exports = async function itemRoutes(req, res, ctx) {
  const { pathname, method, me } = ctx;
  const im = pathname.match(/^\/api\/items\/(\d+)$/);

  // 新收藏：优先服务器抓取，失败回退客户端带来的正文；LLM 生成导读，失败降级
  if (method === 'POST' && pathname === '/api/items') {
    const b = await readBody(req);
    let title = b.title || '', text = '', url = '';
    try {
      if (b.url && /^https?:\/\//.test(b.url)) {
        url = b.url;
        try {
          const ext = await extractFromUrl(url);
          if (ext.text && ext.text.length >= 200) { title = ext.title || title; text = ext.text; }
        } catch (e) { /* 服务器抓取失败时回退到客户端带来的正文 */ }
        if (!text && b.text && b.text.trim().length > 30) text = b.text.trim().slice(0, 16000);
        if (!text) return json(res, 422, { error: '该网页抓取失败（可能有登录墙），请去主页手动粘贴正文' }), true;
      } else if (b.text && b.text.trim().length > 30) {
        text = b.text.trim().slice(0, 16000);
      } else {
        return json(res, 400, { error: '请提供链接或至少30字的正文' }), true;
      }
      let a = null;
      try { a = JSON.parse(await llm(analyzePrompt(title, text), true)); } catch (e) { /* fallback below */ }
      if (!a || !a.summary) a = fallbackAnalyze(title, text);
      title = (a.title || title || text.slice(0, 30)).slice(0, 80);
      const id = db.prepare(`INSERT INTO items(user_id,title,url,content,summary,one_sentence,minutes,tags,folder_id,book_id)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        me, title, url, text, a.summary || '', a.one_sentence || '',
        Math.max(1, Math.min(60, a.minutes || 3)),
        JSON.stringify((a.tags || ['待整理']).slice(0, 3)),
        b.folder_id || null, b.book_id || null
      ).lastInsertRowid;
      for (const c of chunkText(text)) db.prepare('INSERT INTO chunks(item_id,idx,text) VALUES(?,?,?)').run(id, c.idx, c.text);
      json(res, 200, {
        item: itemRow(db.prepare('SELECT * FROM items WHERE id=?').get(id)),
        ai: !!LLM_KEY && a.summary !== fallbackAnalyze(title, text).summary || !!(a && a.tags && a.tags.length && a.tags[0] !== '待整理')
      });
      return true;
    } catch (e) {
      return json(res, 422, { error: String(e.message || e) }), true;
    }
  }

  // 详情：本人可见；他人仅限公开内容（公开收藏夹或带推荐语）
  if (method === 'GET' && im) {
    const item = db.prepare('SELECT * FROM items WHERE id=?').get(Number(im[1]));
    if (!item) return json(res, 404, { error: 'not found' }), true;
    let allowed = item.user_id === me;
    if (!allowed) {
      const f = item.folder_id ? db.prepare('SELECT is_public FROM folders WHERE id=?').get(item.folder_id) : null;
      allowed = (f && f.is_public === 1) || (item.recommend_note && item.recommend_note !== '');
    }
    if (!allowed) return json(res, 403, { error: '该内容未公开，无法查看' }), true;
    const owner = db.prepare('SELECT username, nickname, avatar FROM users WHERE id=?').get(item.user_id);
    const out = itemRow(item);
    out.owner_name = owner ? (owner.nickname || owner.username) : '同学';
    json(res, 200, { item: out, comments: commentsFor(item.id, me) });
    return true;
  }

  if (method === 'PATCH' && im) {
    const b = await readBody(req);
    const item = db.prepare('SELECT * FROM items WHERE id=? AND user_id=?').get(Number(im[1]), me);
    if (!item) return json(res, 404, { error: 'not found' }), true;
    if ('folder_id' in b) db.prepare('UPDATE items SET folder_id=? WHERE id=?').run(b.folder_id || null, item.id);
    if ('book_id' in b) db.prepare('UPDATE items SET book_id=? WHERE id=?').run(b.book_id || null, item.id);
    if ('recommend_note' in b) db.prepare('UPDATE items SET recommend_note=? WHERE id=?').run(String(b.recommend_note).slice(0, 2000), item.id);
    if ('author_name' in b) db.prepare('UPDATE items SET author_name=? WHERE id=?').run(String(b.author_name).slice(0, 30), item.id);
    json(res, 200, { ok: true });
    return true;
  }

  if (method === 'DELETE' && im) {
    const item = db.prepare('SELECT id FROM items WHERE id=? AND user_id=?').get(Number(im[1]), me);
    if (item) {
      db.prepare('DELETE FROM chunks WHERE item_id=?').run(item.id);
      db.prepare('DELETE FROM comments WHERE item_id=?').run(item.id);
      db.prepare('DELETE FROM items WHERE id=?').run(item.id);
    }
    json(res, 200, { ok: true });
    return true;
  }

  return false;
};