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

function normBookTitle(s) {
  return String(s || '').replace(/[《》〔〕\s]/g, '').trim().toLowerCase();
}

// ---------- migration（旧单用户库自动升级为多用户） ----------
for (const t of ['items', 'folders', 'books']) {
  try { db.exec('ALTER TABLE ' + t + ' ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1'); } catch (e) {}
}
try { db.exec('ALTER TABLE comments ADD COLUMN user_id INTEGER'); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN nickname TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE items ADD COLUMN agent_log TEXT DEFAULT ''"); } catch (e) {}
db.exec('CREATE TABLE IF NOT EXISTS book_subs(user_id INTEGER NOT NULL, book_id INTEGER NOT NULL, PRIMARY KEY(user_id,book_id));');
db.exec('CREATE TABLE IF NOT EXISTS item_opens(user_id INTEGER NOT NULL, item_id INTEGER NOT NULL, opened_at TEXT NOT NULL DEFAULT (datetime(\'now\',\'localtime\')));');
db.exec('CREATE TABLE IF NOT EXISTS daily_pushes(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, date TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime(\'now\',\'localtime\')));');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_user_date ON daily_pushes(user_id, date);');
try { db.exec("ALTER TABLE users ADD COLUMN daily_minutes INTEGER DEFAULT 10"); } catch (e) {}
db.exec('CREATE INDEX IF NOT EXISTS idx_items_user ON items(user_id); CREATE INDEX IF NOT EXISTS idx_chunks_item ON chunks(item_id);');

// ---------- books 全局共享：规范书名去重（同名书合并为一本） ----------
try { db.exec("ALTER TABLE books ADD COLUMN norm TEXT DEFAULT ''"); } catch (e) {}
function migrateBooksNorm() {
  for (const r of db.prepare('SELECT id, title, norm FROM books').all()) {
    const n = normBookTitle(r.title);
    if (n && n !== r.norm) db.prepare('UPDATE books SET norm=? WHERE id=?').run(n, r.id);
  }
  for (const d of db.prepare("SELECT norm, MIN(id) AS keep, COUNT(*) AS n FROM books WHERE norm != '' GROUP BY norm HAVING n > 1").all()) {
    for (const x of db.prepare('SELECT id FROM books WHERE norm=? AND id != ?').all(d.norm, d.keep)) {
      db.prepare('UPDATE items SET book_id=? WHERE book_id=?').run(d.keep, x.id);
      db.prepare('DELETE FROM books WHERE id=?').run(x.id);
    }
  }
}
db.prepare("UPDATE books SET norm='bk'||id WHERE norm='' OR norm IS NULL").run();
migrateBooksNorm();
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_books_norm ON books(norm);');

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

// 正文智能提取：优先 <article>/<main> 容器，并过滤导航/推广等垃圾行
function pickMainHtml(html) {
  for (const re of [/<article[^>]*>([\s\S]*?)<\/article>/i, /<main[^>]*>([\s\S]*?)<\/main>/i]) {
    const m = html.match(re);
    if (m && m[1].replace(/<[^>]+>/g, '').replace(/\s/g, '').length > 200) return m[1];
  }
  return html;
}
const JUNK_RE = /^(首页|登录|注册|关注|订阅|分享|点赞|评论|收藏|转发|返回|更多|阅读原文|查看原文|上一篇|下一篇|相关阅读|推荐阅读|热门推荐|扫码|下载|广告|赞助|版权所有|免责声明|往期回顾|目录|展开|收起|全部|搜索|ICP备.*|粤ICP.*|京ICP.*)[\s\d。：:·|-]*$/;
function isJunkLine(s) {
  if (!s) return true;
  if (JUNK_RE.test(s)) return true;
  if (s.length <= 8 && !/[。！？！？.!?]$/.test(s) && !/^[-•*\d]/.test(s)) return true; // 短且不成句，多为导航
  if (/[腾讯|微信|微博|二维码|公众号]{2,}(扫码|关注)/.test(s)) return true;
  return false;
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
  return { title, text: htmlToText(html) };
}

// HTML -> 干净正文：去脚本样式导航、正文容器优先、垃圾行过滤（服务器抓取与插件上传共用）
function htmlToText(html) {
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ').replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  html = pickMainHtml(html); // 正文容器优先
  const text = html
    .replace(/<\/(p|div|li|h[1-6]|br|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split('\n').map(s => s.trim()).filter(s => s.length > 1 && !isJunkLine(s)).join('\n').replace(/\n{3,}/g, '\n\n');
  return text.slice(0, 16000);
}

// 纯文本（手动粘贴）也过一遍垃圾行过滤
function cleanPlainText(s) {
  return s.trim().split('\n').map(x => x.trim()).filter(x => x.length > 1 && !isJunkLine(x)).join('\n').slice(0, 16000);
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

const STOPWORDS = new Set(['的','了','吗','呢','吧','啊','是','在','和','与','对','把','我','有','就','都','不','这','那','你','他','她','它','什么','怎么','为什么','如何','关于','介绍','帮忙','帮我','看看','一下','哪些','以及','还有','因为','所以','但是','因此','可以','应该','需要','大家','所有','这个','那个','里面','时候','问题','内容','文章','收藏','整理','讲讲','说说']);
function terms(q) {
  const set = new Set();
  for (const w of q.split(/[\s，。？！、；：“”（）\[\]{}?!,:;()]+/)) if (w.length >= 2 && !STOPWORDS.has(w)) set.add(w);
  const cjk = q.match(/[\u4e00-\u9fff]/g);
  if (cjk && cjk.length >= 2) {
    const s = cjk.join('');
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  }
  return [...set].filter(t => !STOPWORDS.has(t));
}
// AI 提取检索关键词（失败则退回原问题分词）
async function extractKeywords(q) {
  try {
    const out = await llm([
      { role: 'system', content: '把用户问题改写成适合在文章库中检索的关键词。只返回 JSON：{"keywords":["3-6个关键词条，去掉虚词"]}' },
      { role: 'user', content: q }
    ], true);
    const kws = JSON.parse(out).keywords;
    if (Array.isArray(kws)) return kws.map(String).filter(s => s.length >= 2);
  } catch (e) {}
  return null;
}
function retrieve(question, userId, k = 6, kws) {
  const ts = kws && kws.length ? [...new Set(kws.flatMap(w => terms(w)).concat(terms(question)))] : terms(question);
  const rows = db.prepare('SELECT c.item_id, c.idx, c.text, i.title FROM chunks c JOIN items i ON i.id = c.item_id WHERE i.user_id = ?').all(userId);
  const scored = rows.map(r => {
    let score = 0;
    for (const t of ts) {
      if (r.title && r.title.includes(t)) score += 5 * t.length; // 标题命中加权
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
migrateBooksNorm();

// ---------- api ----------
// AI 规范化书名：判断是否真实书籍 + 与已有书库匹配（译名/副标题/书名号差异归一到同一本）
async function canonicalBook(input) {
  const existing = db.prepare('SELECT id, title, author FROM books ORDER BY id').all();
  const list = existing.map(b => b.id + '. 《' + b.title + '》' + (b.author ? ' 作者：' + b.author : '')).join('\n');
  const out = await llm([
    { role: 'system', content: '帮学生把"想挂资料的书"归一到书库里的同一本书。判断输入是不是一本真实存在的书（专著/教材/译作/工具书都算；课程名、文章标题、话题不算书）。如果是书，且与已有书库中某本是同一本书（不同译名、带副标题、书名号差异都算同一本），返回那本书的 book_id；否则给出最通用的中文规范书名。只返回 JSON：{"is_book":true或false,"book_id":已有书id或null,"title":"规范书名(不带书名号)","author":"作者名或空字符串"}' },
    { role: 'user', content: '已有书库：\n' + (list || '（空）') + '\n\n用户输入：' + input }
  ], true);
  const j = JSON.parse(out);
  if (!j || typeof j !== 'object') throw new Error('bad ai output');
  return j;
}

// 书名归一入口：精确匹配 -> AI 规范化（真书校验/译名副标题归一）-> 新建；建书 API 与整理智能体共用
async function resolveBook(userId, rawTitle, author, note) {
  const raw = String(rawTitle || '').trim().slice(0, 80);
  if (!raw) return { error: '缺少书名' };
  const norm = normBookTitle(raw);
  let book = norm ? db.prepare('SELECT * FROM books WHERE norm=?').get(norm) : null;
  let created = false, ai = false;
  if (!book && LLM_KEY) {
    try {
      const c = await canonicalBook(raw);
      if (c.book_id) {
        book = db.prepare('SELECT * FROM books WHERE id=?').get(Number(c.book_id)) || null;
        ai = true;
      } else if (c.is_book === false) {
        return { error: '「' + raw + '」看起来不像一本书名（可能是文章或课程）。书架用来聚合某本书的资料，请换一个真实的书名。' };
      } else {
        const t = String(c.title || raw).replace(/[《》]/g, '').trim().slice(0, 80);
        book = db.prepare('SELECT * FROM books WHERE norm=?').get(normBookTitle(t)) || null;
        if (!book) {
          const nid = db.prepare('INSERT INTO books(user_id,title,author,note,norm) VALUES(?,?,?,?,?)')
            .run(userId, t, String(c.author || author || '').slice(0, 40), String(note || '').slice(0, 200), normBookTitle(t)).lastInsertRowid;
          book = db.prepare('SELECT * FROM books WHERE id=?').get(nid);
          created = true;
        }
        ai = true;
      }
    } catch (e) { /* AI 失败退回精确匹配 */ }
  }
  if (!book) {
    const nid = db.prepare('INSERT INTO books(user_id,title,author,note,norm) VALUES(?,?,?,?,?)')
      .run(userId, raw, String(author || '').slice(0, 40), String(note || '').slice(0, 200), norm).lastInsertRowid;
    book = db.prepare('SELECT * FROM books WHERE id=?').get(nid);
    created = true;
  }
  return { book, created, ai };
}

// 面向智能体的 LLM 调用：返回完整消息（含 tool_calls），无 key 返回 null
async function llmMsg(messages, tools) {
  if (!LLM_KEY) return null;
  const body = { model: LLM_MODEL, messages, temperature: 0.3 };
  if (tools && tools.length) body.tools = tools;
  const r = await fetch(LLM_BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LLM_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000)
  });
  if (!r.ok) throw new Error('LLM ' + r.status + ': ' + (await r.text()).slice(0, 300));
  const data = await r.json();
  return data.choices[0].message;
}

// ---------- 自主整理智能体：多步工具调用，自主决定归类 ----------
const ORGANIZE_TOOLS = [
  { type: 'function', function: { name: 'list_library', description: '查看用户的文件夹和书架（书是全体共享的，重名自动归一）', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'attach_to_book', description: '把这篇收藏挂到某本书下。只在这篇文章确实围绕这本书（书评/读书笔记/书中主题详解）时使用', parameters: { type: 'object', properties: { book_id: { type: 'integer', description: 'list_library 返回的书 id' } }, required: ['book_id'] } } },
  { type: 'function', function: { name: 'create_book', description: '书架里没有合适的书时新建一本（同名/译名会自动归一，不会重复建书；乱编书名会被拒绝）', parameters: { type: 'object', properties: { title: { type: 'string' }, author: { type: 'string' } }, required: ['title'] } } },
  { type: 'function', function: { name: 'move_to_folder', description: '把收藏移入用户已有的文件夹', parameters: { type: 'object', properties: { folder_id: { type: 'integer' } }, required: ['folder_id'] } } },
  { type: 'function', function: { name: 'create_folder', description: '确实需要新分类时新建一个文件夹', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'set_tags', description: '重新设置这篇文章的标签（3-4个中文短标签）', parameters: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } }, required: ['tags'] } } },
  { type: 'function', function: { name: 'done', description: '整理完成，汇报你做了什么（或说明为何不整理）', parameters: { type: 'object', properties: { note: { type: 'string', description: '一句话中文汇报' } }, required: ['note'] } } }
];

async function organizeItem(itemId, userId) {
  const it = db.prepare('SELECT * FROM items WHERE id=?').get(itemId);
  if (!it) return { actions: [], note: '' };
  const actions = [];
  const execTool = async (name, args) => {
    if (name === 'list_library') {
      const folders = db.prepare('SELECT f.id, f.name, f.is_public, (SELECT COUNT(*) FROM items i WHERE i.folder_id=f.id) AS n FROM folders f WHERE f.user_id=?').all(userId);
      const books = db.prepare('SELECT b.id, b.title, b.author, (SELECT COUNT(*) FROM items i WHERE i.book_id=b.id AND i.user_id=?) AS n FROM books b WHERE b.user_id=? OR EXISTS(SELECT 1 FROM items i2 WHERE i2.book_id=b.id AND i2.user_id=?)').all(userId, userId, userId);
      return { folders, books };
    }
    if (name === 'attach_to_book') {
      const b = db.prepare('SELECT * FROM books WHERE id=?').get(Number(args.book_id));
      if (!b) return { error: '书不存在' };
      db.prepare('UPDATE items SET book_id=? WHERE id=?').run(b.id, itemId);
      actions.push({ action: '挂到《' + b.title + '》' });
      return { ok: true, book: b.title };
    }
    if (name === 'create_book') {
      const r = await resolveBook(userId, String(args.title || ''), String(args.author || ''), '');
      if (r.error) return { error: r.error };
      db.prepare('UPDATE items SET book_id=? WHERE id=?').run(r.book.id, itemId);
      actions.push({ action: (r.created ? '新建并挂到' : '挂到已有') + '《' + r.book.title + '》' });
      return { ok: true, book_id: r.book.id, book: r.book.title, reused: !r.created };
    }
    if (name === 'move_to_folder') {
      const f = db.prepare('SELECT * FROM folders WHERE id=? AND user_id=?').get(Number(args.folder_id), userId);
      if (!f) return { error: '文件夹不存在' };
      db.prepare('UPDATE items SET folder_id=? WHERE id=?').run(f.id, itemId);
      actions.push({ action: '移入文件夹「' + f.name + '」' });
      return { ok: true, folder: f.name };
    }
    if (name === 'create_folder') {
      const name = String(args.name || '').trim().slice(0, 40);
      if (!name) return { error: '名称为空' };
      let f = db.prepare('SELECT * FROM folders WHERE user_id=? AND name=?').get(userId, name);
      if (!f) f = { id: db.prepare('INSERT INTO folders(user_id,name,is_public) VALUES(?,?,0)').run(userId, name).lastInsertRowid };
      db.prepare('UPDATE items SET folder_id=? WHERE id=?').run(f.id, itemId);
      actions.push({ action: '移入文件夹「' + name + '」' });
      return { ok: true, folder_id: f.id, folder: name };
    }
    if (name === 'set_tags') {
      const tags = (Array.isArray(args.tags) ? args.tags : []).map(t => String(t).slice(0, 8)).filter(Boolean).slice(0, 4);
      if (!tags.length) return { error: '标签为空' };
      db.prepare('UPDATE items SET tags=? WHERE id=?').run(JSON.stringify(tags), itemId);
      actions.push({ action: '标签更新为 ' + tags.join('/') });
      return { ok: true, tags };
    }
    if (name === 'done') return { ok: true, note: String(args.note || '').slice(0, 120) };
    return { error: '未知工具' };
  };
  const sys = '你是"拾页"的自主整理智能体。用户刚收藏了一篇文章，你通过工具查看他的文件夹与书架，自主决定这篇收藏的归类。规则：1) 只有内容确实围绕某本书（书评、读书笔记、对书中主题的深入解读）时才挂书，且优先复用已有书；2) 不确定就不要挂书，绝不乱挂；3) 优先使用已有文件夹归类，除非明显需要新分类；4) 需要时可以更新标签使其更准确；5) 完成后调用 done，用一句话中文说明你做了什么（没做什么也说明）。';
  const msgs = [
    { role: 'system', content: sys },
    { role: 'user', content: '新收藏如下，请自主整理。\n标题：' + it.title + '\nAI 摘要：' + (it.summary || '') + '\n当前标签：' + (it.tags || '[]') + '\n正文片段：' + String(it.content || '').slice(0, 1500) }
  ];
  let note = '';
  if (!LLM_KEY) {
    // 演示模式兜底：正文提到书架已有书名就自动挂书
    const text = String(it.content || '');
    for (const b of db.prepare('SELECT * FROM books').all()) {
      if (b.title && b.title.length >= 2 && text.includes(b.title) && it.book_id !== b.id) {
        db.prepare('UPDATE items SET book_id=? WHERE id=?').run(b.id, itemId);
        actions.push({ action: '挂到《' + b.title + '》' });
        break;
      }
    }
    note = actions.map(a => a.action).join('；');
    if (note) db.prepare('UPDATE items SET agent_log=? WHERE id=?').run(JSON.stringify({ note, actions }), itemId);
    return { actions, note };
  }
  for (let step = 0; step < 8; step++) {
    let msg;
    try { msg = await llmMsg(msgs, ORGANIZE_TOOLS); } catch (e) { break; }
    if (!msg) break;
    msgs.push(msg);
    const calls = msg.tool_calls || [];
    if (!calls.length) break;
    let finished = false;
    for (const tc of calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
      let result;
      try { result = await execTool(tc.function.name, args); } catch (e) { result = { error: String(e.message || e) }; }
      if (tc.function.name === 'done') { note = (result && result.note) || ''; finished = true; }
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 1500) });
    }
    if (finished) break;
  }
  if (!note && actions.length) note = actions.map(a => a.action).join('；');
  if (note) db.prepare('UPDATE items SET agent_log=? WHERE id=?').run(JSON.stringify({ note, actions }), itemId);
  return { actions, note };
}

// ---------- 问答智能体：多轮检索循环（模型自主决定检索/深读/作答） ----------
const CHAT_TOOLS = [
  { type: 'function', function: { name: 'search_library', description: '在用户的收藏库中检索相关片段。结果不足时换关键词再检索', parameters: { type: 'object', properties: { query: { type: 'string', description: '检索关键词或短语' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'read_item', description: '深读某篇收藏的完整正文（id 来自检索结果）', parameters: { type: 'object', properties: { item_id: { type: 'integer' } }, required: ['item_id'] } } },
  { type: 'function', function: { name: 'finish', description: '证据足够，提交最终回答', parameters: { type: 'object', properties: { answer: { type: 'string', description: '中文回答，引用证据时在句末标注[编号]' } }, required: ['answer'] } } }
];

async function chatAgent(userId, q) {
  const evidence = [];
  const steps = [];
  const execTool = async (name, args) => {
    if (name === 'search_library') {
      const query = String(args.query || '').trim();
      if (!query) return { error: '检索词为空' };
      steps.push('🔍 检索「' + query.slice(0, 20) + '」');
      const hits = retrieve(query, userId, 8);
      if (!hits.length) return { result: '没有命中任何片段。建议换更具体的关键词，或换个角度检索。' };
      const out = [];
      for (const h of hits) {
        if (evidence.some(e => e.item_id === h.item_id && e.text === h.text)) continue;
        const n = evidence.length + 1;
        evidence.push({ n, item_id: h.item_id, title: h.title, snippet: h.text.slice(0, 150), text: h.text });
        out.push('[' + n + '] 《' + h.title + '》' + h.text.slice(0, 300));
      }
      if (!out.length) return { result: '命中的片段都已读过。可对其中某篇调用 read_item 深读，或调用 finish 作答。' };
      return { evidence: out };
    }
    if (name === 'read_item') {
      const it = db.prepare('SELECT id, title, content FROM items WHERE id=? AND user_id=?').get(Number(args.item_id), userId);
      if (!it) return { error: '找不到该收藏' };
      steps.push('📖 深读《' + it.title + '》');
      return { title: it.title, content: String(it.content || '').slice(0, 4000) };
    }
    if (name === 'finish') return { ok: true, answer: String(args.answer || '') };
    return { error: '未知工具' };
  };
  const sys = '你是用户个人收藏库的问答智能体。通过工具多轮检索自己的收藏来回答问题：先 search_library 检索；若片段不足以回答，就换关键词再检索，或用 read_item 深读相关文章；证据足够后调用 finish，用中文简洁分点作答，引用证据时在句末标注编号如[1][3]。如果两轮检索都没有相关内容，直接 finish 说明收藏库里暂时没有相关内容。';
  const msgs = [
    { role: 'system', content: sys },
    { role: 'user', content: '问题：' + q }
  ];
  let answer = null;
  for (let step = 0; step < 6; step++) {
    let msg;
    try { msg = await llmMsg(msgs, CHAT_TOOLS); } catch (e) { break; }
    if (!msg) break;
    msgs.push(msg);
    const calls = msg.tool_calls || [];
    if (!calls.length) { answer = msg.content || null; break; }
    let finished = false;
    for (const tc of calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
      let result;
      try { result = await execTool(tc.function.name, args); } catch (e) { result = { error: String(e.message || e) }; }
      if (tc.function.name === 'finish') { answer = (result && result.answer) || null; finished = true; }
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 4000) });
    }
    if (finished) break;
  }
  if (!answer) {
    // 循环用尽仍未 finish：把已有证据交给模型做最后一次总结
    try {
      const m2 = await llmMsg(msgs.concat([{ role: 'user', content: '请直接根据以上证据回答最初的问题：' + q + '。引用证据标注[编号]。' }]), null);
      answer = m2 && m2.content ? m2.content : null;
    } catch (e) { answer = null; }
  }
  if (!answer) answer = '你的收藏库里暂时没有和这个问题相关的内容。先收藏几篇文章再来问我吧。';
  const cited = [...new Set((answer.match(/\[(\d{1,2})\]/g) || []).map(s => Number(s.slice(1, -1))))].filter(n => evidence.some(e => e.n === n)).sort((a, b) => a - b);
  let sources = cited.map(n => { const e = evidence.find(x => x.n === n); return { n: e.n, item_id: e.item_id, title: e.title, snippet: e.snippet }; });
  if (!sources.length && evidence.length) sources = evidence.slice(0, 3).map(e => ({ n: e.n, item_id: e.item_id, title: e.title, snippet: e.snippet }));
  return { answer, sources, steps };
}

// ---------- 每日策展智能体：观察 -> 自主定策略 -> 生成阅读计划 ----------
function getBacklog(userId) {
  return db.prepare(`SELECT i.id, i.title, i.minutes, i.tags, i.book_id, i.created_at,
    CAST(julianday('now','localtime') - julianday(i.created_at) AS INTEGER) AS age_days
    FROM items i WHERE i.user_id=? AND NOT EXISTS(SELECT 1 FROM item_opens o WHERE o.item_id=i.id AND o.user_id=?)
    ORDER BY i.created_at ASC LIMIT 20`).all(userId, userId);
}

const CURATOR_TOOLS = [
  { type: 'function', function: { name: 'get_backlog', description: '查看用户积压未读的收藏（含积压天数、时长、标签、所属书）', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'get_reading_stats', description: '查看用户最近14天实际读了什么（兴趣信号）', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'get_book_progress', description: '查看书架上每本书的已读/未读进度', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'get_yesterday_feedback', description: '查看昨天推送了什么、用户实际读了没有', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'get_social', description: '查看广场上同学们最近在讨论什么', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'submit_digest', description: '提交今日策展', parameters: { type: 'object', properties: {
    theme: { type: 'string', description: '今天的策展主题，10字内' },
    intro: { type: 'string', description: '两句话说明今天为什么这样安排' },
    strategy: { type: 'string', description: '策略名：主题阅读/清理积压/跟进兴趣/跟随同学热门等' },
    goal: { type: 'string', description: '一句今日目标' },
    picks: { type: 'array', description: '今日推荐阅读 3-5 篇（item_id 必须来自 get_backlog）', items: { type: 'object', properties: { item_id: { type: 'integer' }, reason: { type: 'string' } }, required: ['item_id', 'reason'] } },
    cleanups: { type: 'array', description: '建议删除的过期收藏 0-2 条', items: { type: 'object', properties: { item_id: { type: 'integer' }, reason: { type: 'string' } }, required: ['item_id', 'reason'] } }
  }, required: ['theme', 'intro', 'goal', 'picks'] } } }
];

async function curatorAgent(userId, budget) {
  let payload = null;
  const execTool = async (name, args) => {
    if (name === 'get_backlog') return { budget_minutes: budget, backlog: getBacklog(userId) };
    if (name === 'get_reading_stats') {
      const rows = db.prepare("SELECT i.id, i.title, i.tags, o.opened_at FROM item_opens o JOIN items i ON i.id=o.item_id WHERE o.user_id=? AND o.opened_at >= datetime('now','localtime','-14 day') ORDER BY o.opened_at DESC LIMIT 30").all(userId);
      return { total: rows.length, recent_opens: rows };
    }
    if (name === 'get_book_progress') {
      return db.prepare(`SELECT b.title, b.author,
        (SELECT COUNT(*) FROM items i WHERE i.book_id=b.id AND i.user_id=?) AS total,
        (SELECT COUNT(*) FROM items i WHERE i.book_id=b.id AND i.user_id=? AND NOT EXISTS(SELECT 1 FROM item_opens o WHERE o.item_id=i.id AND o.user_id=?)) AS unread
        FROM books b WHERE b.user_id=? OR EXISTS(SELECT 1 FROM book_subs s WHERE s.book_id=b.id AND s.user_id=?)
        OR EXISTS(SELECT 1 FROM items i2 WHERE i2.book_id=b.id AND i2.user_id=?)`).all(userId, userId, userId, userId, userId, userId);
    }
    if (name === 'get_yesterday_feedback') {
      const yp = db.prepare("SELECT payload FROM daily_pushes WHERE user_id=? AND date=date('now','localtime','-1 day')").get(userId);
      if (!yp) return { note: '昨天没有推送记录' };
      try {
        const p = JSON.parse(yp.payload);
        return { theme: p.theme, picks: (p.picks || []).map(pk => ({ title: pk.title, opened: !!db.prepare('SELECT 1 FROM item_opens WHERE user_id=? AND item_id=?').get(userId, pk.item_id) })) };
      } catch (e) { return { note: '记录损坏' }; }
    }
    if (name === 'get_social') {
      return db.prepare(`SELECT i.id, i.title, i.one_sentence, (SELECT COUNT(*) FROM comments c WHERE c.item_id=i.id) AS comments
        FROM items i LEFT JOIN folders f ON f.id=i.folder_id
        WHERE f.is_public=1 AND i.created_at >= datetime('now','localtime','-7 day') ORDER BY i.id DESC LIMIT 6`).all();
    }
    if (name === 'submit_digest') {
      const picks = [];
      for (const pk of (Array.isArray(args.picks) ? args.picks : []).slice(0, 5)) {
        const it = db.prepare('SELECT id, title, minutes FROM items WHERE id=? AND user_id=?').get(Number(pk.item_id), userId);
        if (it) picks.push({ item_id: it.id, title: it.title, reason: String(pk.reason || '').slice(0, 80) });
      }
      if (!picks.length) return { error: 'picks 不能为空，且必须是用户自己的收藏' };
      const cleanups = [];
      for (const c of (Array.isArray(args.cleanups) ? args.cleanups : []).slice(0, 2)) {
        const it = db.prepare('SELECT id, title FROM items WHERE id=? AND user_id=?').get(Number(c.item_id), userId);
        if (it) cleanups.push({ item_id: it.id, title: it.title, reason: String(c.reason || '').slice(0, 80) });
      }
      payload = {
        theme: String(args.theme || '今日策展').slice(0, 30),
        intro: String(args.intro || '').slice(0, 200),
        strategy: String(args.strategy || '').slice(0, 30),
        goal: String(args.goal || '').slice(0, 60),
        picks, cleanups, generated: 'agent'
      };
      return { ok: true };
    }
    return { error: '未知工具' };
  };
  const sys = '你是"拾页"的每日策展智能体，解决用户"收藏了不看"的问题。先用工具观察状态（积压、阅读历史、书架进度、昨日反馈、广场热门），再自主决定今天的策展策略，最后调用 submit_digest。规则：1) picks 挑 3-5 篇，总时长尽量贴近预算；2) 每篇 reason 一句话讲清"为什么今天读它"；3) 过期且不值得读的可以进 cleanups 劝退；4) 昨天推了没读的类型，今天换策略；5) 不要推荐用户最近已读过的内容。';
  const msgs = [
    { role: 'system', content: sys },
    { role: 'user', content: '今天是 ' + new Date().toLocaleDateString('zh-CN') + '，用户每日阅读预算约 ' + budget + ' 分钟。请开始今日策展。' }
  ];
  for (let step = 0; step < 10; step++) {
    let msg;
    try { msg = await llmMsg(msgs, CURATOR_TOOLS); } catch (e) { break; }
    if (!msg) break;
    msgs.push(msg);
    const calls = msg.tool_calls || [];
    if (!calls.length) break;
    let done = false;
    for (const tc of calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
      let result;
      try { result = await execTool(tc.function.name, args); } catch (e) { result = { error: String(e.message || e) }; }
      if (tc.function.name === 'submit_digest') done = !!payload;
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 4000) });
    }
    if (done) break;
  }
  return payload ? { payload } : null;
}

// 无 key / 智能体失败时的规则兜底：按陈旧度凑预算
function dailyFallback(userId, budget) {
  const backlog = getBacklog(userId);
  const budgetMin = Number(budget) || 10;
  const picks = []; let used = 0;
  for (const b of backlog) {
    const m = b.minutes || 3;
    if (used + m > budgetMin) continue;
    picks.push({ item_id: b.id, title: b.title, reason: '收藏 ' + Math.max(1, b.age_days) + ' 天未读' });
    used += m;
    if (picks.length >= 3) break;
  }
  if (!picks.length && backlog.length) picks.push({ item_id: backlog[0].id, title: backlog[0].title, reason: '积压最久的一篇，今天就从它开始' });
  const cleanups = backlog.filter(b => b.age_days >= 30).slice(0, 2).map(b => ({ item_id: b.id, title: b.title, reason: '收藏 ' + b.age_days + ' 天从未打开，建议清理' }));
  return { theme: '清理积压', intro: '今天先从积压最久的收藏开始，慢慢消化。', strategy: '按陈旧度排序', goal: '读完 ' + picks.length + ' 篇积压收藏', picks, cleanups, generated: 'fallback' };
}

async function generateDaily(userId) {
  const budget = (db.prepare('SELECT daily_minutes FROM users WHERE id=?').get(userId) || {}).daily_minutes || 10;
  if (LLM_KEY) {
    try { const r = await curatorAgent(userId, budget); if (r && r.payload) return r.payload; } catch (e) {}
  }
  return dailyFallback(userId, budget);
}

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
    const u = db.prepare('SELECT username, nickname, bio, avatar, daily_minutes FROM users WHERE id=?').get(me);
    return json(res, 200, u ? { username: u.username, nickname: u.nickname || '', bio: u.bio || '', avatar: u.avatar || '', daily_minutes: u.daily_minutes || 10 } : { username: '同学', nickname: '', bio: '', avatar: '', daily_minutes: 10 });
  }

  if (method === 'GET' && pathname === '/api/state') {
    const folders = db.prepare('SELECT * FROM folders WHERE user_id=? ORDER BY id').all(me);
    // 书全局共享：我的书架 = 我创建的 + 我订阅的 + 我挂过资料的书
    const books = db.prepare(`SELECT b.*,
      EXISTS(SELECT 1 FROM book_subs s WHERE s.book_id=b.id AND s.user_id=?) AS subscribed,
      (SELECT COUNT(*) FROM items i WHERE i.book_id=b.id AND i.user_id=?) AS my_items,
      (SELECT COUNT(DISTINCT i2.user_id) FROM items i2 WHERE i2.book_id=b.id) AS readers
      FROM books b WHERE b.user_id=? OR EXISTS(SELECT 1 FROM book_subs s2 WHERE s2.book_id=b.id AND s2.user_id=?)
        OR EXISTS(SELECT 1 FROM items i3 WHERE i3.book_id=b.id AND i3.user_id=?)
      ORDER BY b.id`).all(me, me, me, me, me);
    const items = db.prepare('SELECT * FROM items WHERE user_id=? ORDER BY id DESC').all(me).map(itemRow);
    // 评论跨用户展示（条目自己的评论 + 书籍讨论聚合在前端做）
    const mine = items.map(i => i.id);
    let comments = [];
    for (const iid of mine) comments = comments.concat(commentsFor(iid, me));
    const square = db.prepare(`SELECT i.id, i.title, i.one_sentence, i.minutes, i.recommend_note, i.author_name, i.user_id,
      u.username AS owner, f.name AS folder_name, i.book_id, bb.title AS book_title, i.tags,
      (SELECT COUNT(*) FROM comments c WHERE c.item_id = i.id) AS comment_count,
      (SELECT COALESCE(NULLIF(u2.nickname,''), u2.username, c.user_name) || '：' || c.text FROM comments c LEFT JOIN users u2 ON u2.id = c.user_id WHERE c.item_id = i.id ORDER BY (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = c.id) DESC, c.id DESC LIMIT 1) AS hot_comment
      FROM items i LEFT JOIN folders f ON f.id = i.folder_id LEFT JOIN users u ON u.id = i.user_id LEFT JOIN books bb ON bb.id = i.book_id
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
    const r = await resolveBook(me, b.title, b.author, b.note);
    if (r.error) return json(res, r.error.indexOf('不像一本书名') !== -1 ? 422 : 400, { error: r.error });
    db.prepare('INSERT OR IGNORE INTO book_subs(user_id,book_id) VALUES(?,?)').run(me, r.book.id);
    return json(res, 200, { id: r.book.id, title: r.book.title, created: r.created, ai: r.ai, subscribed: true });
  }

  // 订阅一本已有书（加入我的书架）
  const sm = pathname.match(/^\/api\/books\/(\d+)\/subscribe$/);
  if (method === 'POST' && sm) {
    const book = db.prepare('SELECT * FROM books WHERE id=?').get(Number(sm[1]));
    if (!book) return json(res, 404, { error: 'not found' });
    db.prepare('INSERT OR IGNORE INTO book_subs(user_id,book_id) VALUES(?,?)').run(me, book.id);
    return json(res, 200, { ok: true });
  }

  // 书籍详情（公开）：我的资料 + 其他同学的公开资料
  const bm = pathname.match(/^\/api\/books\/(\d+)$/);
  if (method === 'GET' && bm) {
    const book = db.prepare('SELECT * FROM books WHERE id=?').get(Number(bm[1]));
    if (!book) return json(res, 404, { error: 'not found' });
    const mine = db.prepare('SELECT * FROM items WHERE book_id=? AND user_id=? ORDER BY id DESC').all(book.id, me).map(itemRow);
    const others = db.prepare(`SELECT i.*, u.username AS owner, COALESCE(NULLIF(u.nickname,''), u.username) AS owner_name, u.avatar AS owner_avatar
      FROM items i LEFT JOIN users u ON u.id = i.user_id
      WHERE i.book_id=? AND i.user_id != ? AND (
        EXISTS(SELECT 1 FROM folders f WHERE f.id = i.folder_id AND f.is_public = 1)
        OR (i.recommend_note IS NOT NULL AND i.recommend_note != ''))
      ORDER BY i.id DESC LIMIT 50`).all(book.id, me).map(itemRow);
    const readers = db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM items WHERE book_id=?').get(book.id).n;
    return json(res, 200, { book, mine, others, readers });
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
        if (!text && b.html && String(b.html).length > 500) {
          try { const t2 = htmlToText(String(b.html)); if (t2.length >= 200) text = t2; } catch (e) {}
        }
        if (!text && b.text && b.text.trim().length > 30) text = cleanPlainText(b.text);
        if (!text) return json(res, 422, { error: '该网页抓取失败（可能有登录墙），请去主页手动粘贴正文' });
      } else if (b.text && b.text.trim().length > 30) {
        text = cleanPlainText(b.text);
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
      let agent = { actions: [], note: '' };
      try { agent = await organizeItem(id, me); } catch (e) { /* 整理失败不影响收藏 */ }
      const item = itemRow(db.prepare('SELECT * FROM items WHERE id=?').get(id));
      return json(res, 200, { item, agent, ai: !!LLM_KEY && a.summary !== fallbackAnalyze(title, text).summary || !!(a && a.tags && a.tags.length && a.tags[0] !== '待整理') });
    } catch (e) {
      return json(res, 422, { error: String(e.message || e) });
    }
  }

  // 让整理智能体重新整理某篇收藏
  const om = pathname.match(/^\/api\/items\/(\d+)\/organize$/);
  if (method === 'POST' && om) {
    const item = db.prepare('SELECT id FROM items WHERE id=? AND user_id=?').get(Number(om[1]), me);
    if (!item) return json(res, 404, { error: 'not found' });
    const agent = await organizeItem(item.id, me);
    const out = itemRow(db.prepare('SELECT * FROM items WHERE id=?').get(item.id));
    return json(res, 200, { item: out, agent });
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
    db.prepare('INSERT INTO item_opens(user_id,item_id) VALUES(?,?)').run(me, item.id);
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
    let dailyMinutes = u.daily_minutes || 10;
    if ('daily_minutes' in b) dailyMinutes = Math.max(5, Math.min(60, Number(b.daily_minutes) || 10));
    db.prepare('UPDATE users SET nickname=?, bio=?, avatar=?, daily_minutes=? WHERE id=?').run(nickname, bio, avatar, dailyMinutes, me);
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

  // 每日策展：GET 懒生成（一天一次），POST ?force=1 重新生成
  if (pathname === '/api/daily' && (method === 'GET' || method === 'POST')) {
    if (method === 'POST' && query.get('force') === '1') {
      db.prepare("DELETE FROM daily_pushes WHERE user_id=? AND date=date('now','localtime')").run(me);
    }
    let row = db.prepare("SELECT payload FROM daily_pushes WHERE user_id=? AND date=date('now','localtime')").get(me);
    if (!row) {
      const payload = await generateDaily(me);
      db.prepare("INSERT INTO daily_pushes(user_id,date,payload) VALUES(?,date('now','localtime'),?)").run(me, JSON.stringify(payload));
      row = { payload: JSON.stringify(payload) };
    }
    return json(res, 200, { push: JSON.parse(row.payload) });
  }

  if (method === 'POST' && pathname === '/api/chat') {
    const b = await readBody(req);
    const q = String(b.question || '').trim();
    if (!q) return json(res, 400, { error: '请输入问题' });
    if (!LLM_KEY) {
      // 演示模式：单轮检索兜底
      const kws = await extractKeywords(q);
      const hits = retrieve(q, me, 6, kws);
      if (!hits.length) return json(res, 200, { answer: '你的收藏库里暂时没有和这个问题相关的内容。先收藏几篇文章再来问我吧。', sources: [] });
      return json(res, 200, { answer: '【演示模式】根据你的收藏，最相关的内容是：\n\n' + hits.slice(0, 3).map(h => '· 《' + h.title + '》' + h.text.slice(0, 80) + '……').join('\n'), sources: hits.slice(0, 3).map((h, i) => ({ n: i + 1, item_id: h.item_id, title: h.title, snippet: h.text.slice(0, 120) })) });
    }
    const r = await chatAgent(me, q);
    return json(res, 200, { answer: r.answer, sources: r.sources, steps: r.steps });
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
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
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









