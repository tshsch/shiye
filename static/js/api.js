// 前端基础设施：DOM 工具、接口封装、提示浮层
const $ = id => document.getElementById(id);
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(path, method, body) {
  const r = await fetch('/api/' + path, {
    method: method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const d = await r.json().catch(() => ({ error: '服务器错误' }));
  if (!r.ok) throw new Error(d.error || r.status);
  return d;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, 2200);
}