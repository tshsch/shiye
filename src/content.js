const db = require('./db');

// ---------- 正文清洗：过滤导航/广告/噪音行 ----------
const JUNK_PATTERNS = [
  /扫码|二维码|关注我们|点击关注|立即订阅|广告|赞助|登录|注册|忘记密码|验证码/i,
  /^(首页|导航|分类|标签|搜索|登录|注册|关于|联系|版权|免责声明|往期|推荐阅读|相关文章|热门|最新|下一篇|上一篇|分享到|上一篇：|下一篇：)/,
  /all\s*rights\s*reserved|copyright|©|ICP备/i,
  /^\W+$/,                                  // 纯符号
  /^(<-|->|\|+|·+|\*+|-+|_+|\=+)$/,         // 分隔符行
];

function isJunkLine(line) {
  const s = line.trim();
  if (s.length < 6 && !/[。！？.!?]$/.test(s)) return true;          // 过短且非完整句
  if (s.length > 500) return false;
  return JUNK_PATTERNS.some(p => p.test(s));
}

function cleanArticleText(text) {
  return text.split('\n').filter(l => !isJunkLine(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

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
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ').replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  // 正文容器识别：优先 <article>，其次常见正文容器，取文本量最大的候选
  const candidates = [];
  const article = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (article) candidates.push(article[1]);
  const container = html.match(/<(?:div|main|section)[^>]*(?:id|class)\s*=\s*["'][^"']*(?:article|post-content|post_body|content|main-content|entry|rich_media_content|topic-content|QuestionAnswer-content)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|main|section)>/i);
  if (container) candidates.push(container[1]);

  const toText = h => h
    .replace(/<\/(p|div|li|h[1-6]|br|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

  let body = '';
  for (const cand of candidates) {
    const txt = toText(cand).split('\n').map(s => s.trim()).filter(s => s.length > 1).join('\n');
    if (txt.length > body.length) body = txt;
  }
  if (body.length < 200) {
    body = toText(html);
  }

  const text = cleanArticleText(body.split('\n').map(s => s.trim()).filter(s => s.length > 1).join('\n').replace(/\n{3,}/g, '\n\n'));
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
const STOPWORDS = new Set([
  '怎么', '怎样', '如何', '为什么', '什么', '哪些', '哪个', '是不是', '请问', '看待',
  '这个', '那个', '这些', '那些', '可以', '就是', '没有', '还是', '以及', '关于',
  '而且', '但是', '因为', '所以', '如果', '虽然', '大家', '自己', '时候', '地方',
  '文章', '内容', '收藏', '问题', '里面', '还有', '来说', '对于', '通过', '进行',
  '一下', '有些', '有的', '的话', '我', '你', '他', '她', '它', '我们', '你们', '他们'
]);

function terms(q) {
  // 去掉问句语气词与填充词，避免“怎么讲土地财政”里的“怎么”污染检索
  const cleaned = q.replace(/请问|是不是|怎么样|怎么看|怎么看|怎么讲|怎么说|为什么|怎么|如何|什么|哪些|哪个|吗|呢|吧|啊|呀|了|的|是|在|和|与|有/g, ' ');
  const set = new Set();
  for (const w of (q + ' ' + cleaned).split(/[\s，。？！、；："（）\[\]{}?!,:;()]+/)) {
    if (w.length >= 2 && !STOPWORDS.has(w)) set.add(w);
  }
  const cjk = cleaned.replace(/\s+/g, '').match(/[\u4e00-\u9fff]{2,}/g);
  if (cjk) {
    for (const seg of cjk) {
      for (let i = 0; i < seg.length - 1; i++) {
        const bg = seg.slice(i, i + 2);
        if (!STOPWORDS.has(bg)) set.add(bg);
      }
    }
  }
  return [...set].filter(w => w.length >= 2);
}

function scoreText(text, ts) {
  let s = 0;
  for (const t of ts) {
    let i = -1, n = 0;
    while ((i = text.indexOf(t, i + 1)) !== -1 && n < 50) { n++; s += t.length; }
  }
  return s;
}

function retrieve(question, userId, k = 8, extraTerms = []) {
  const ts = [...new Set([...terms(question), ...(extraTerms || []).filter(t => t && t.length >= 2)])];
  const rows = db.prepare('SELECT c.item_id, c.idx, c.text, i.title FROM chunks c JOIN items i ON i.id = c.item_id WHERE i.user_id = ?').all(userId);
  const scored = rows.map(r => ({
    ...r,
    // 标题命中权重远高于正文命中：标题是最可靠的匹配信号
    score: scoreText(r.title || '', ts) * 5 + scoreText(r.text, ts)
  })).filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
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

module.exports = { extractFromUrl, cleanArticleText, chunkText, terms, retrieve, commentsFor };