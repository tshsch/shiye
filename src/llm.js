const { LLM_KEY, LLM_BASE, LLM_MODEL } = require('./config');

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
  // 部分平台不支持 response_format，去掉后降级重试
  if (!r.ok && jsonMode && (r.status === 400 || r.status === 404)) {
    r = await call(base);
  }
  if (!r.ok) throw new Error('LLM ' + r.status + ': ' + (await r.text()).slice(0, 300));
  const data = await r.json();
  return data.choices[0].message.content;
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

module.exports = { llm, analyzePrompt, fallbackAnalyze };