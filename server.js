// 「拾页」Shiye - reading collection agent (zero-dependency Node.js, multi-user)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
}
loadEnv();
const LLM_KEY = process.env.LLM_API_KEY || '';
const LLM_BASE = (process.env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-chat';

const db = new DatabaseSync(path.join(ROOT, 'data.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
  salt TEXT NOT NULL, passhash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS folders(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL,
  is_public INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS books(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT NOT NULL,
  author TEXT DEFAULT '', note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS items(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT NOT NULL,
  url TEXT DEFAULT '', content TEXT NOT NULL,
  summary TEXT DEFAULT '', one_sentence TEXT DEFAULT '',
  minutes INTEGER DEFAULT 3, tags TEXT DEFAULT '[]',
  folder_id INTEGER, book_id INTEGER,
  author_name TEXT DEFAULT '', recommend_note TEXT DEFAULT '',
  demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS chunks(
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
  idx INTEGER NOT NULL, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tokens(
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS comment_likes(
  comment_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY(comment_id,user_id));
CREATE TABLE IF NOT EXISTS comment_favs(
  comment_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY(comment_id,user_id));
CREATE TABLE IF NOT EXISTS comments(
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
  user_id INTEGER, user_name TEXT NOT NULL, text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
`);

// ---------- migration（旧单用户库自动升级为多用户） ----------
for (const t of ['items', 'folders', 'books']) {
  try { db.exec('ALTER TABLE ' + t + ' ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1'); } catch (e) {}
}
try { db.exec('ALTER TABLE comments ADD COLUMN user_id INTEGER'); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN nickname TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT ''"); } catch (e) {}
db.exec('CREATE INDEX IF NOT EXISTS idx_items_user ON items(user_id); CREATE INDEX IF NOT EXISTS idx_chunks_item ON chunks(item_id);');

// ---------- sessions ----------
const sessions = new Map(); // token -> user_id
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function currentUser(req) {
  const token = parseCookies(req).shiy_token;
  if (!token) return null;
  if (sessions.has(token)) return sessions.get(token);
  const row = db.prepare('SELECT user_id, expires_at FROM tokens WHERE token=?').get(token);
  if (!row || row.expires_at < Date.now()) { if (row) db.prepare('DELETE FROM tokens WHERE token=?').run(token); return null; }
  sessions.set(token, row.user_id);
  return row.user_id;
}
function hash(salt, pw) { return crypto.createHash('sha256').update(salt + '::' + pw).digest('hex'); }

function json(res, code, data, headers) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }, headers || {}));
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', c => { size += c.length; if (size > 8e6) { reject(new Error('too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function llm(messages, jsonMode) {
  if (!LLM_KEY) return null;
  const base = { model: LLM_MODEL, messages, temperature: 0.4 };
  const call = (body) => fetch(LLM_BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LLM_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  });
  let r = await call(jsonMode ? Object.assign({}, base, { response_format: { type: 'json_object' } }) : base);
  if (!r.ok && jsonMode && (r.status === 400 || r.status === 404)) {
    r = await call(base); // 部分平台不支持 response_format，降级重试
  }
  if (!r.ok) throw new Error('LLM ' + r.status + ': ' + (await r.text()).slice(0, 300));
  const data = await r.json();
  return data.choices[0].message.content;
}

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

function analyzePrompt(title, text) {
  return [
    { role: 'system', content: '你是阅读助手。用户给你一篇文章，只返回 JSON：{"title":"精简标题(12字内)","summary":"120字内摘要,讲清核心观点与关键论据","one_sentence":"25字内一句话总结","minutes":建议阅读分钟整数,"tags":["3个中文标签,每个2-6字"]}。不要输出 JSON 以外内容。' },
    { role: 'user', content: '标题：' + (title || '（无标题）') + '\n\n正文：\n' + text.slice(0, 8000) }
  ];
}
function fallbackAnalyze(title, text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const sents = clean.split(/(?<=[。！？!?])/).map(s => s.trim()).filter(Boolean);
  let sum = '';
  for (const s of sents) { if ((sum + s).length > 130) break; sum += s; }
  if (!sum) sum = clean.slice(0, 120);
  return {
    title: title || (sents[0] ? sents[0].slice(0, 28) : clean.slice(0, 28)),
    summary: sum,
    one_sentence: (sents[0] || clean).slice(0, 25),
    minutes: Math.max(1, Math.round(text.length / 500)),
    tags: ['待整理']
  };
}

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

function commentsFor(itemId, me) {
  return db.prepare(`SELECT c.*,
    COALESCE(NULLIF(u.nickname,''), u.username, c.user_name) AS user_name,
    u.avatar AS user_avatar,
    (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id=c.id) AS like_count,
    EXISTS(SELECT 1 FROM comment_likes cl WHERE cl.comment_id=c.id AND cl.user_id=?) AS liked_by_me,
    EXISTS(SELECT 1 FROM comment_favs cf WHERE cf.comment_id=c.id AND cf.user_id=?) AS faved_by_me
    FROM comments c LEFT JOIN users u ON u.id=c.user_id WHERE c.item_id=? ORDER BY c.id`).all(me, me, itemId);
}

// ---------- seed（演示账号） ----------
function seedDemo() {
  let demo = db.prepare('SELECT id FROM users WHERE username=?').get('demo');
  if (demo) return demo.id;
  const salt = crypto.randomBytes(8).toString('hex');
  demo = db.prepare('INSERT INTO users(username,salt,passhash) VALUES(?,?,?)').run('demo', salt, hash(salt, 'demo123')).lastInsertRowid;
  const fCourse = db.prepare('INSERT INTO folders(user_id,name,is_public) VALUES(?,?,0)').run(demo, '课程资料').lastInsertRowid;
  const fGold = db.prepare('INSERT INTO folders(user_id,name,is_public) VALUES(?,?,1)').run(demo, '宝藏文章').lastInsertRowid;
  const book = db.prepare('INSERT INTO books(user_id,title,author,note) VALUES(?,?,?,?)')
    .run(demo, '置身事内', '兰小欢', '理解中国经济与政府行为的入门读物，课程推荐。').lastInsertRowid;

  const demoItems = [
    {
      title: '土地财政：中国城市化的引擎', url: 'https://example.com/tudi-caizheng',
      folder: fCourse, book: book, author_name: '学委王同学', recommend_note: '把书里第3章讲透了，读之前先看这篇',
      tags: ['土地财政', '中国经济'], minutes: 8,
      content: '土地财政是指地方政府通过出让城市土地使用权获得收入的行为模式。1994年分税制改革后，地方政府财政收入占比下降但支出责任未减，土地出让金成为地方最重要的预算外收入来源。土地财政的核心逻辑是：政府低价征收农村土地，经过平整和基础设施建设后高价出让城市用地，差额用于城市建设。这一模式推动了中国快速的城市化，也带来了房价高企、地方债务和耕地保护等问题。近年来随着房地产市场降温，土地出让收入下滑，地方政府急需寻找新的收入来源，产业税收和消费税改革被寄予厚望。理解土地财政是理解中国城市化和地方治理的钥匙。'
    },
    {
      title: '分税制改革三十年：央地关系的再平衡', url: 'https://example.com/fenshuizhi',
      folder: fCourse, book: book, author_name: '', recommend_note: '',
      tags: ['分税制', '财政'], minutes: 12,
      content: '1994年的分税制改革将增值税等主要税种划分为中央与地方共享税，中央财政收入占比从改革前的22%跃升至55%以上。改革初衷是扭转"两个比重"过低的问题，增强中央宏观调控能力。但硬币的另一面是地方财政自给率下降，事权与财权不匹配，地方政府转而依赖土地出让金和融资平台。转移支付制度在此背景下建立，包括一般性转移支付和专项转移支付两大类。学者普遍认为，央地财政关系的再平衡需要赋予地方更多主体税种，消费税下划地方是近年讨论最多的方案之一。'
    },
    {
      title: '我为什么劝你别急着囤课', url: 'https://example.com/tun-ke',
      folder: fGold, book: null, author_name: '大四学姐', recommend_note: '收藏夹里囤了20门课的一定要看，看完你会删掉一半',
      tags: ['学习方法'], minutes: 5,
      content: '知识付费时代最大的陷阱是"收藏等于学会"。囤课带来的安全感是虚假的：你付费的瞬间大脑产生了完成感，而这个完成感恰恰消解了真正学习的动力。正确的做法是：先想清楚要解决什么问题，再去找最小够用的资料；一门课没有作业和输出，就当播客听；学完一篇，用自己的话写三句话总结，写不出来就是没学会。删掉收藏夹里三个月没打开的内容，你的学习效率会立刻提升。'
    },
    {
      title: '论文写作的第一性原理', url: 'https://example.com/lunwen',
      folder: fCourse, book: null, author_name: '导师推荐', recommend_note: '开题前必读',
      tags: ['论文写作', '科研'], minutes: 10,
      content: '论文的本质是与读者的一份论证契约：你提出一个明确的主张，用证据和推理让持有怀疑态度的读者接受它。写作的第一性原理是"为读者省力"——摘要让读者10秒决定是否继续读，引言在第一页讲清三个问题：研究什么、为什么重要、你做了什么。文献综述不是罗列，而是划出争论地图并指明你的位置。方法部分的标准是可复现。结论部分最忌讳夸大，诚实地写明局限反而增加可信度。初稿的最大敌人是完美主义，先完成再完善。'
    },
    {
      title: '番茄工作法真的适合所有人吗', url: 'https://example.com/tomato',
      folder: fGold, book: null, author_name: '舍友小李', recommend_note: '25分钟不适合深度思考，这篇给了替代方案',
      tags: ['时间管理'], minutes: 6,
      content: '番茄工作法以25分钟为单位切割时间，适合任务启动困难、容易分心的人。但深度工作的研究表明，进入心流状态平均需要15-20分钟，25分钟的番茄钟可能刚好把心流打断。替代方案是"半日区块法"：上午划出2-3小时的完整区块处理最重要的深度任务，下午再用番茄钟处理碎片事务。关键洞察是：时间管理工具的选择取决于任务类型，创造型工作需要长区块，事务型工作适合短番茄。不要让工具绑架你，先观察自己一天中什么时候头脑最清醒。'
    }
  ];
  for (const d of demoItems) {
    const id = db.prepare(`INSERT INTO items(user_id,title,url,content,summary,one_sentence,minutes,tags,folder_id,book_id,author_name,recommend_note,demo)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(
      demo, d.title, d.url, d.content,
      d.content.slice(0, 110) + '……',
      d.content.slice(0, 22),
      d.minutes, JSON.stringify(d.tags), d.folder, d.book, d.author_name, d.recommend_note
    ).lastInsertRowid;
    for (const c of chunkText(d.content)) db.prepare('INSERT INTO chunks(item_id,idx,text) VALUES(?,?,?)').run(id, c.idx, c.text);
  }
  db.prepare('INSERT INTO comments(item_id,user_id,user_name,text) VALUES(?,?,?,?)').run(1, null, '大三张同学', '原来分税制才是根源，难怪书中先讲这个');
  db.prepare('INSERT INTO comments(item_id,user_id,user_name,text) VALUES(?,?,?,?)').run(1, null, '同班小陈', '已挂到《置身事内》第3章的资料里了，配合着读');
  db.prepare('INSERT INTO comments(item_id,user_id,user_name,text) VALUES(?,?,?,?)').run(3, null, '隔壁班同学', '看完删掉了8门课，谢谢学姐');
  return demo.id;
}
seedDemo();

// ---------- api ----------
function itemRow(r) { return { ...r, tags: JSON.parse(r.tags || '[]') }; }

async function handleApi(req, res, pathname, query) {
  const method = req.method;
  const setAuth = (res, userId) => {
    const token = crypto.randomBytes(24).toString('hex');
    const expires = Date.now() + 30 * 24 * 3600 * 1000;
    sessions.set(token, userId);
    db.prepare('INSERT INTO tokens(token,user_id,expires_at) VALUES(?,?,?)').run(token, userId, expires);
    return { 'Set-Cookie': 'shiy_token=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000' };
  };

  if (method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true, llm: !!LLM_KEY, model: LLM_MODEL });

  // ---- auth ----
  if (method === 'POST' && pathname === '/api/register') {
    const b = await readBody(req);
    const username = String(b.username || '').trim();
    const password = String(b.password || '');
    if (!/^[\u4e00-\u9fa5a-zA-Z0-9_]{2,20}$/.test(username)) return json(res, 400, { error: '用户名需为2-20位中文/字母/数字' });
    if (password.length < 4) return json(res, 400, { error: '密码至少4位' });
    if (db.prepare('SELECT id FROM users WHERE username=?').get(username)) return json(res, 400, { error: '用户名已被使用' });
    const salt = crypto.randomBytes(8).toString('hex');
    const id = db.prepare('INSERT INTO users(username,salt,passhash) VALUES(?,?,?)').run(username, salt, hash(salt, password)).lastInsertRowid;
    db.prepare('INSERT INTO folders(user_id,name,is_public) VALUES(?,?,0)').run(id, '收件箱');
    return json(res, 200, { ok: true }, setAuth(res, id));
  }
  if (method === 'POST' && pathname === '/api/login') {
    const b = await readBody(req);
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(b.username || '').trim());
    if (!u || u.passhash !== hash(u.salt, String(b.password || ''))) return json(res, 400, { error: '用户名或密码错误' });
    return json(res, 200, { ok: true }, setAuth(res, u.id));
  }
  if (method === 'POST' && pathname === '/api/logout') {
    const token = parseCookies(req).shiy_token;
    if (token) { sessions.delete(token); db.prepare('DELETE FROM tokens WHERE token=?').run(token); }
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'shiy_token=; Path=/; Max-Age=0' });
  }

  const me = currentUser(req);
  if (!me) return json(res, 401, { error: '请先登录' });
  if (method === 'GET' && pathname === '/api/me') {
    const u = db.prepare('SELECT username, nickname, bio, avatar FROM users WHERE id=?').get(me);
    return json(res, 200, u ? { username: u.username, nickname: u.nickname || '', bio: u.bio || '', avatar: u.avatar || '' } : { username: '同学', nickname: '', bio: '', avatar: '' });
  }

  if (method === 'GET' && pathname === '/api/state') {
    const folders = db.prepare('SELECT * FROM folders WHERE user_id=? ORDER BY id').all(me);
    const books = db.prepare('SELECT * FROM books WHERE user_id=? ORDER BY id').all(me);
    const items = db.prepare('SELECT * FROM items WHERE user_id=? ORDER BY id DESC').all(me).map(itemRow);
    // 评论跨用户展示（条目自己的评论 + 书籍讨论聚合在前端做）
    const mine = items.map(i => i.id);
    let comments = [];
    for (const iid of mine) comments = comments.concat(commentsFor(iid, me));
    const square = db.prepare(`SELECT i.id, i.title, i.one_sentence, i.minutes, i.recommend_note, i.author_name, i.user_id,
      u.username AS owner, f.name AS folder_name,
      (SELECT COUNT(*) FROM comments c WHERE c.item_id = i.id) AS comment_count,
      (SELECT COALESCE(NULLIF(u2.nickname,''), u2.username, c.user_name) || '：' || c.text FROM comments c LEFT JOIN users u2 ON u2.id = c.user_id WHERE c.item_id = i.id ORDER BY (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = c.id) DESC, c.id DESC LIMIT 1) AS hot_comment
      FROM items i LEFT JOIN folders f ON f.id = i.folder_id LEFT JOIN users u ON u.id = i.user_id
      WHERE f.is_public = 1 OR (i.recommend_note IS NOT NULL AND i.recommend_note != '')
      ORDER BY i.id DESC LIMIT 50`).all();
    return json(res, 200, { folders, books, items, comments, square, llm: !!LLM_KEY, username: (db.prepare('SELECT username FROM users WHERE id=?').get(me) || {}).username });
  }

  if (method === 'POST' && pathname === '/api/folders') {
    const b = await readBody(req);
    if (!b.name) return json(res, 400, { error: '缺少名称' });
    const id = db.prepare('INSERT INTO folders(user_id,name,is_public) VALUES(?,?,?)').run(me, String(b.name).slice(0, 40), b.is_public ? 1 : 0).lastInsertRowid;
    return json(res, 200, { id });
  }
  const fm = pathname.match(/^\/api\/folders\/(\d+)$/);
  if (method === 'PATCH' && fm) {
    const b = await readBody(req);
    const f = db.prepare('SELECT * FROM folders WHERE id=? AND user_id=?').get(Number(fm[1]), me);
    if (!f) return json(res, 404, { error: 'not found' });
    if ('name' in b) db.prepare('UPDATE folders SET name=? WHERE id=?').run(String(b.name).slice(0, 40), f.id);
    if ('is_public' in b) db.prepare('UPDATE folders SET is_public=? WHERE id=?').run(b.is_public ? 1 : 0, f.id);
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname === '/api/books') {
    const b = await readBody(req);
    if (!b.title) return json(res, 400, { error: '缺少书名' });
    const id = db.prepare('INSERT INTO books(user_id,title,author,note) VALUES(?,?,?,?)')
      .run(me, String(b.title).slice(0, 80), String(b.author || '').slice(0, 40), String(b.note || '').slice(0, 200)).lastInsertRowid;
    return json(res, 200, { id });
  }

  if (method === 'POST' && pathname === '/api/items') {
    const b = await readBody(req);
    let title = b.title || '', text = '', url = '';
    try {
      if (b.url && /^https?:\/\//.test(b.url)) {
        url = b.url;
        try {
          const ext = await extractFromUrl(url);
          if (ext.text && ext.text.length >= 200) { title = ext.title || title; text = ext.text; }
        } catch (e) { /* 回退到客户端正文 */ }
        if (!text && b.text && b.text.trim().length > 30) text = b.text.trim().slice(0, 16000);
        if (!text) return json(res, 422, { error: '该网页抓取失败（可能有登录墙），请去主页手动粘贴正文' });
      } else if (b.text && b.text.trim().length > 30) {
        text = b.text.trim().slice(0, 16000);
      } else {
        return json(res, 400, { error: '请提供链接或至少30字的正文' });
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
      const item = itemRow(db.prepare('SELECT * FROM items WHERE id=?').get(id));
      return json(res, 200, { item, ai: !!LLM_KEY && a.summary !== fallbackAnalyze(title, text).summary || !!(a && a.tags && a.tags.length && a.tags[0] !== '待整理') });
    } catch (e) {
      return json(res, 422, { error: String(e.message || e) });
    }
  }

  const im = pathname.match(/^\/api\/items\/(\d+)$/);
  if (method === 'GET' && im) {
    const item = db.prepare('SELECT * FROM items WHERE id=?').get(Number(im[1]));
    if (!item) return json(res, 404, { error: 'not found' });
    let allowed = item.user_id === me;
    if (!allowed) {
      const f = item.folder_id ? db.prepare('SELECT is_public FROM folders WHERE id=?').get(item.folder_id) : null;
      allowed = (f && f.is_public === 1) || (item.recommend_note && item.recommend_note !== '');
    }
    if (!allowed) return json(res, 403, { error: '该内容未公开，无法查看' });
    const comments = commentsFor(item.id, me);
    const owner = db.prepare('SELECT username, nickname, avatar FROM users WHERE id=?').get(item.user_id);
    const out = itemRow(item); out.owner_name = owner ? owner.username : '同学';
    return json(res, 200, { item: out, comments });
  }
  if (method === 'PATCH' && im) {
    const b = await readBody(req);
    const item = db.prepare('SELECT * FROM items WHERE id=? AND user_id=?').get(Number(im[1]), me);
    if (!item) return json(res, 404, { error: 'not found' });
    if ('folder_id' in b) db.prepare('UPDATE items SET folder_id=? WHERE id=?').run(b.folder_id || null, item.id);
    if ('book_id' in b) db.prepare('UPDATE items SET book_id=? WHERE id=?').run(b.book_id || null, item.id);
    if ('recommend_note' in b) db.prepare('UPDATE items SET recommend_note=? WHERE id=?').run(String(b.recommend_note).slice(0, 100), item.id);
    if ('author_name' in b) db.prepare('UPDATE items SET author_name=? WHERE id=?').run(String(b.author_name).slice(0, 30), item.id);
    return json(res, 200, { ok: true });
  }
  if (method === 'DELETE' && im) {
    const item = db.prepare('SELECT id FROM items WHERE id=? AND user_id=?').get(Number(im[1]), me);
    if (item) {
      db.prepare('DELETE FROM chunks WHERE item_id=?').run(item.id);
      db.prepare('DELETE FROM comments WHERE item_id=?').run(item.id);
      db.prepare('DELETE FROM items WHERE id=?').run(item.id);
    }
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname === '/api/comments') {
    const b = await readBody(req);
    if (!b.item_id || !b.text) return json(res, 400, { error: '缺少内容' });
    const target = db.prepare('SELECT id FROM items WHERE id=?').get(Number(b.item_id));
    if (!target) return json(res, 404, { error: 'not found' });
    const u = db.prepare('SELECT username FROM users WHERE id=?').get(me);
    const id = db.prepare('INSERT INTO comments(item_id,user_id,user_name,text) VALUES(?,?,?,?)')
      .run(Number(b.item_id), me, String(b.user_name || (u ? u.username : '同学')).slice(0, 20), String(b.text).slice(0, 300)).lastInsertRowid;
    return json(res, 200, { id });
  }

  if (method === 'PATCH' && pathname === '/api/profile') {
    const b = await readBody(req);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(me);
    const nickname = 'nickname' in b ? String(b.nickname || '').trim().slice(0, 20) : (u.nickname || '');
    const bio = 'bio' in b ? String(b.bio || '').slice(0, 300) : (u.bio || '');
    let avatar = u.avatar || '';
    if ('avatar' in b) {
      const a = String(b.avatar || '');
      if (a && !/^data:image\/(png|jpe?g|gif|webp);base64,/.test(a)) return json(res, 400, { error: '头像仅支持图片文件' });
      if (a.length > 300000) return json(res, 400, { error: '头像图片太大，请换一张小图' });
      avatar = a;
    }
    db.prepare('UPDATE users SET nickname=?, bio=?, avatar=? WHERE id=?').run(nickname, bio, avatar, me);
    return json(res, 200, { ok: true });
  }
  if (method === 'GET' && pathname === '/api/fav-comments') {
    const rows = db.prepare(`SELECT c.*, i.title AS item_title, i.id AS item_id,
      COALESCE(NULLIF(u.nickname,''), u.username, c.user_name) AS user_name, u.avatar AS user_avatar,
      (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id=c.id) AS like_count,
      EXISTS(SELECT 1 FROM comment_likes cl WHERE cl.comment_id=c.id AND cl.user_id=?) AS liked_by_me
      FROM comment_favs cf JOIN comments c ON c.id=cf.comment_id JOIN items i ON i.id=c.item_id
      LEFT JOIN users u ON u.id=c.user_id WHERE cf.user_id=? ORDER BY cf.rowid DESC`).all(me, me);
    return json(res, 200, { comments: rows });
  }
  const cm = pathname.match(/^\/api\/comments\/(\d+)\/(like|fav)$/);
  if (method === 'POST' && cm) {
    const cid = Number(cm[1]), kind = cm[2] === 'like' ? 'comment_likes' : 'comment_favs';
    const exists = db.prepare('SELECT 1 FROM ' + kind + ' WHERE comment_id=? AND user_id=?').get(cid, me);
    if (exists) db.prepare('DELETE FROM ' + kind + ' WHERE comment_id=? AND user_id=?').run(cid, me);
    else db.prepare('INSERT INTO ' + kind + ' (comment_id,user_id) VALUES(?,?)').run(cid, me);
    const cnt = db.prepare('SELECT COUNT(*) AS n FROM ' + kind + ' WHERE comment_id=?').get(cid).n;
    return json(res, 200, { active: !exists, count: cnt });
  }

  if (method === 'POST' && pathname === '/api/chat') {
    const b = await readBody(req);
    const q = String(b.question || '').trim();
    if (!q) return json(res, 400, { error: '请输入问题' });
    const hits = retrieve(q, me);
    if (!hits.length) return json(res, 200, { answer: '你的收藏库里暂时没有和这个问题相关的内容。先收藏几篇文章再来问我吧。', sources: [] });
    const byItem = new Map();
    for (const h of hits) {
      if (!byItem.has(h.item_id)) byItem.set(h.item_id, []);
      byItem.get(h.item_id).push(h);
    }
    const context = []; const sourceList = [];
    let n = 1;
    for (const [itemId, hs] of byItem) {
      let cited = false;
      for (const h of hs) {
        context.push('[' + n + '] ' + h.title + '：' + h.text);
        if (!cited) sourceList.push({ n, item_id: itemId, title: h.title, snippet: h.text.slice(0, 120) });
        cited = true;
        n++;
      }
    }
    let answer = null;
    try {
      answer = await llm([
        { role: 'system', content: '你是用户个人收藏库的问答助手。只根据提供的收藏片段回答问题，回答末尾标注引用编号如[1][3]。如果片段不足以回答，就明确说不确定。用中文，简洁分点。' },
        { role: 'user', content: '我的收藏片段：\n\n' + context.join('\n\n') + '\n\n问题：' + q }
      ], false);
    } catch (e) { answer = null; }
    if (!answer) {
      answer = '【演示模式】根据你的收藏，最相关的内容是：\n\n' + hits.slice(0, 3).map(h => '· 《' + h.title + '》' + h.text.slice(0, 80) + '……').join('\n');
    }
    return json(res, 200, { answer, sources: sourceList });
  }

  return json(res, 404, { error: 'not found' });
}

// ---------- static ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(ROOT, 'static', path.normalize(p).replace(/^([.]{2}[\/\\])+/, ''));
  if (!file.startsWith(path.join(ROOT, 'static'))) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(u.pathname);
  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, u.searchParams);
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }
    return serveStatic(res, pathname);
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
});
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  拾页已启动: http://localhost:' + PORT + '（局域网/公网用户请用对应地址访问）');
  console.log('  AI 能力: ' + (LLM_KEY ? '已连接 (' + LLM_MODEL + ')' : '未配置 key，运行在演示模式'));
  console.log('  演示账号: demo / demo123');
  console.log('');
});









