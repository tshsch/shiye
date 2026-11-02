const { json, readBody } = require('../lib/http');
const { LLM_KEY } = require('../config');
const { llm } = require('../llm');
const { retrieve } = require('../content');

// 让 AI 先从问题中提取检索关键词，显著提升无语义检索的准确率
async function extractKeywords(question) {
  if (!LLM_KEY) return [];
  try {
    const raw = await llm([
      { role: 'system', content: '从用户问题中提取 3-6 个最适合用于在中文文章库里做关键词检索的词（可以是词组）。只返回 JSON：{"keywords":["词1","词2"]}。不要输出其他内容。' },
      { role: 'user', content: question }
    ], true);
    const d = JSON.parse(raw);
    return (d.keywords || []).filter(k => typeof k === 'string' && k.length >= 2).slice(0, 6);
  } catch (e) { return []; }
}

module.exports = async function chatRoutes(req, res, ctx) {
  const { pathname, method, me } = ctx;

  if (method === 'POST' && pathname === '/api/chat') {
    const b = await readBody(req);
    const q = String(b.question || '').trim();
    if (!q) return json(res, 400, { error: '请输入问题' }), true;

    const keywords = await extractKeywords(q);
    const hits = retrieve(q, me, 8, keywords);
    if (!hits.length) {
      json(res, 200, { answer: '你的收藏库里暂时没有和这个问题相关的内容。先收藏几篇文章再来问我吧。', sources: [] });
      return true;
    }

    // 按文章分组生成引用上下文
    const byItem = new Map();
    for (const h of hits) {
      if (!byItem.has(h.item_id)) byItem.set(h.item_id, []);
      byItem.get(h.item_id).push(h);
    }
    const context = [];
    const sources = [];
    let n = 1;
    for (const [itemId, hs] of byItem) {
      let cited = false;
      for (const h of hs) {
        context.push('[' + n + '] ' + h.title + '：' + h.text);
        if (!cited) sources.push({ n, item_id: itemId, title: h.title, snippet: h.text.slice(0, 120) });
        cited = true;
        n++;
      }
    }

    let answer = null;
    try {
      answer = await llm([
        { role: 'system', content: '你是用户个人收藏库的问答助手。只根据提供的收藏片段回答问题，回答中在支持结论的位置标注引用编号如[1][3]。如果片段不足以回答，就明确说不确定。用中文，简洁分点。' },
        { role: 'user', content: '我的收藏片段：\n\n' + context.join('\n\n') + '\n\n问题：' + q }
      ], false);
    } catch (e) { answer = null; }

    if (!answer) {
      answer = '【演示模式】根据你的收藏，最相关的内容是：\n\n' +
        hits.slice(0, 3).map(h => '· 《' + h.title + '》' + h.text.slice(0, 80) + '……').join('\n');
    }
    json(res, 200, { answer, sources, keywords });
    return true;
  }

  return false;
};