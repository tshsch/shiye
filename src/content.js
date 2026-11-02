const db = require('./db');

// ---------- 网页抓取 ----------
async function extractFromUrl(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' },
    signal: AbortSignal.timeout(15000), redirect: 'follow'
  });
  if (!r.ok) throw new Error('抓取失败 HTTP ' + r.status);
  let html = new TextDecoder('utf-8', { fatal: false }).decode(await r.arrayBuffer());
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = t ? t[1].replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ').replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const text = html
    .replace(/<\/(p|div|li|h[1-6]|br|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split('\n').map(s => s.trim()).filter(s => s.length > 1).join('\n').replace(/\n{3,}/g, '\n\n');
  return { title, text: text.slice(0, 16000) };
}

// ---------- 分块 ----------
function chunkText(text, size = 500, overlap = 80) {
  const paras = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const chunks = []; let cur = '';
  for (const p of paras) {
    if ((cur + p).length > size && cur) { chunks.push(cur); cur = cur.slice(-overlap); }
    cur += (cur ? ' ' : '') + p;
  }
  if (cur) chunks.push(cur);
  return chunks.map((c, i) => ({ idx: i, text: c })).filter(c => c.text.length > 30);
}

// ---------- 关键词检索（RAG） ----------
function terms(q) {
  const set = new Set();
  for (const w of q.split(/[\s，。？！、；："（）\[\]{}?!,:;()]+/)) if (w.length >= 2) set.add(w);
  const cjk = q.match(/[\u4e00-\u9fff]/g);
  if (cjk && cjk.length >= 2) {
    const s = cjk.join('');
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  }
  return [...set];
}

function retrieve(question, userId, k = 6) {
  const ts = terms(question);
  const rows = db.prepare('SELECT c.item_id, c.idx, c.text, i.title FROM chunks c JOIN items i ON i.id = c.item_id WHERE i.user_id = ?').all(userId);
  const scored = rows.map(r => {
    let score = 0;
    for (const t of ts) {
      let i = -1, n = 0;
      while ((i = r.text.indexOf(t, i + 1)) !== -1 && n < 20) n++;
      score += n * t.length;
    }
    return { ...r, score };
  }).filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
  const seen = new Set();
  return scored.filter(r => { const key = r.item_id + ':' + r.idx; if (seen.has(key)) return false; seen.add(key); return true; });
}

// ---------- 评论查询（带点赞/收藏状态与展示昵称） ----------
function commentsFor(itemId, me) {
  return db.prepare(`SELECT c.*,
    COALESCE(NULLIF(u.nickname,''), u.username, c.user_name) AS user_name,
    u.avatar AS user_avatar,
    (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id=c.id) AS like_count,
    EXISTS(SELECT 1 FROM comment_likes cl WHERE cl.comment_id=c.id AND cl.user_id=?) AS liked_by_me,
    EXISTS(SELECT 1 FROM comment_favs cf WHERE cf.comment_id=c.id AND cf.user_id=?) AS faved_by_me
    FROM comments c LEFT JOIN users u ON u.id=c.user_id WHERE c.item_id=? ORDER BY c.id`).all(me, me, itemId);
}

module.exports = { extractFromUrl, chunkText, terms, retrieve, commentsFor };