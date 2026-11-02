// 页面主逻辑：状态、页签、收藏、书架、广场、问答、个人主页
let S = null;            // 全局状态（由 /api/state 拉取）
let curFolder = 'all';   // 当前选中的收藏夹

// ---------- 启动与刷新 ----------
async function refresh() {
  S = await api('state');
  $('aiBadge').textContent = S.llm ? 'AI 已连接' : '演示模式（未配置 key）';
  renderFolders(); renderItems(); renderBooks(); renderSquare(); renderSuggests();
}

// ---------- 页签切换 ----------
document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  document.querySelectorAll('nav button').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  for (const t of ['inbox', 'shelf', 'square', 'chat', 'ext']) {
    $('tab-' + t).style.display = b.dataset.tab === t ? '' : 'none';
  }
});

// ---------- 收藏入库 ----------
async function saveItem() {
  const url = $('urlInput').value.trim(), text = $('textInput').value.trim();
  if (!url && text.length < 30) return toast('请粘贴链接，或至少 30 字的正文');
  const btn = $('saveBtn'); btn.disabled = true;
  btn.innerHTML = '<span class="loading"></span>AI 正在阅读…';
  try {
    const d = await api('items', 'POST', { url, text });
    $('urlInput').value = ''; $('textInput').value = '';
    const n = $('saveNote'); n.style.display = 'block';
    n.textContent = '已收藏《' + d.item.title + '》，AI 生成了导读，去收藏夹看看 →';
    await refresh();
  } catch (e) { toast(e.message); }
  btn.disabled = false; btn.textContent = '收进来';
}

// ---------- 收藏夹 ----------
function renderFolders() {
  const strip = $('folderStrip');
  let html = `<div class="folder-chip ${curFolder === 'all' ? 'on' : ''}" onclick="curFolder='all';renderFolders();renderItems()">全部</div>`;
  for (const f of S.folders) {
    const cnt = S.items.filter(i => i.folder_id === f.id).length;
    html += `<div class="folder-chip ${curFolder === f.id ? 'on' : ''}" onclick="curFolder=${f.id};renderFolders();renderItems()">${esc(f.name)} ${cnt} ${f.is_public ? '<span class="pub">公开</span>' : ''}</div>`;
  }
  html += `<div class="folder-chip" onclick="newFolder()">＋ 新建</div>`;
  if (curFolder !== 'all') {
    const cf = S.folders.find(x => x.id === curFolder);
    if (cf) html += `<div class="folder-chip" onclick="togglePublic(${cf.id})">${cf.is_public ? '🔒 设为私有' : '🌐 设为公开（广场可见）'}</div>`;
  }
  strip.innerHTML = html;
}

async function newFolder() {
  const name = prompt('收藏夹名称：'); if (!name) return;
  await api('folders', 'POST', { name }); refresh();
}

async function togglePublic(id) {
  const f = S.folders.find(x => x.id === id);
  if (!f) return;
  if (!f.is_public && !confirm('设为公开后，这个夹子里的内容会出现在校园广场，确定？')) return;
  await api('folders/' + id, 'PATCH', { is_public: !f.is_public });
  refresh(); toast(f.is_public ? '已设为私有' : '已公开，广场可见');
}

function renderItems() {
  const g = $('itemGrid');
  const items = curFolder === 'all' ? S.items : S.items.filter(i => i.folder_id === curFolder);
  g.innerHTML = items.length ? '' : '<div class="empty" style="grid-column:1/-1">这里还空空的，先收藏一篇文章吧</div>';
  for (const it of items) {
    const book = S.books.find(b => b.id === it.book_id);
    const folder = S.folders.find(f => f.id === it.folder_id);
    const card = document.createElement('div'); card.className = 'card';
    card.onclick = () => openItem(it.id);
    card.innerHTML = `
      <div class="del" onclick="event.stopPropagation();delClick(this, ${it.id})">×</div>
      <h3>${esc(it.title)}</h3>
      <div class="one">${esc(it.one_sentence)}</div>
      <div class="tags">${it.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      ${it.recommend_note ? `<div class="reco">💬 ${esc(it.author_name || '同学')}：${esc(it.recommend_note)}</div>` : ''}
      <div class="meta"><span>约 ${it.minutes} 分钟</span>${folder ? `<span>📁 ${esc(folder.name)}</span>` : ''}${book ? `<span>📖 ${esc(book.title)}</span>` : ''}<span class="recoBtn" onclick="event.stopPropagation();openRecommend(${it.id})">📢 推荐</span></div>`;
    g.appendChild(card);
  }
}

async function delItem(id) { await api('items/' + id, 'DELETE'); refresh(); toast('已删除'); }
// 两段式删除：第一次点击变为“确认删除”，再点才真正删除（避免浏览器拦截 confirm 导致静默失效）
function delClick(el, id) {
  if (el.dataset.armed) { el.dataset.armed = ''; delItem(id); return; }
  el.dataset.armed = '1';
  el.textContent = '确认删除';
  el.classList.add('sure');
  setTimeout(() => { el.dataset.armed = ''; el.textContent = '×'; el.classList.remove('sure'); }, 2500);
}

// ---------- 详情弹窗（自己的内容可管理，广场上他人的内容只读+评论） ----------
async function openItem(id) {
  let it = S.items.find(i => i.id === id), cs = null;
  const ownerView = !!it;
  if (!it) {
    try {
      const d = await api('items/' + id);
      it = d.item; cs = d.comments;
    } catch (e) { toast(e.message || '无法查看'); return; }
  } else {
    cs = S.comments.filter(c => c.item_id === id);
  }
  it = { ...it, tags: Array.isArray(it.tags) ? it.tags : JSON.parse(it.tags || '[]') };

  let selectorHtml = '', noteHtml = '';
  if (ownerView) {
    const folderOpts = S.folders.map(f => `<option value="${f.id}" ${f.id === it.folder_id ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
    const bookOpts = '<option value="">不挂到书</option>' + S.books.map(b => `<option value="${b.id}" ${b.id === it.book_id ? 'selected' : ''}>${esc(b.title)}</option>`).join('');
    selectorHtml = `
    <div class="selrow" style="margin-top:12px">
      📁 <select id="mFolder">${folderOpts}</select>
      📖 <select id="mBook">${bookOpts}</select>
      <button class="btn small ghost" onclick="saveMeta(${id})">保存</button>
    </div>`;
    noteHtml = `
    <div class="selrow" style="margin:-4px 0 14px">
      💬 <textarea id="mNote" rows="3" placeholder="推荐到广场的理由（选填，写了就上广场，支持长文）" style="flex:1;border:1px solid var(--line);border-radius:8px;padding:8px 12px;font-size:13px;font-family:inherit;resize:vertical">${esc(it.recommend_note)}</textarea>
    </div>`;
  } else {
    selectorHtml = `<div class="hint" style="margin:10px 0">👤 来自 <b>${esc(it.owner_name || '同学')}</b> 的收藏</div>`;
  }

  $('modalBody').innerHTML = `
    <h2>${esc(it.title)}</h2>
    <div class="meta"><span>约 ${it.minutes} 分钟读完</span>${it.url ? `<a href="${esc(it.url)}" target="_blank">原文链接</a>` : ''}</div>
    <div class="sum"><b>AI 导读</b><br>${esc(it.summary)}</div>
    <div class="tags">${it.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    ${selectorHtml}
    ${noteHtml}
    <details><summary style="cursor:pointer;font-size:13px;color:var(--sub)">查看正文</summary><div class="content" style="margin-top:10px">${esc(it.content)}</div></details>
    <div class="section" style="font-size:14px;margin:16px 0 4px">评论讨论</div>
    ${cs.map(c => commentHtml(c, id)).join('') || '<div class="hint">还没有评论</div>'}
    <div class="cform" style="flex-direction:column;align-items:stretch">
      <textarea id="ctext" rows="2" placeholder="写下你的看法，支持长评（Ctrl+回车发送）…" style="border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:13px;font-family:inherit;resize:vertical" onkeydown="if(event.ctrlKey&&event.key==='Enter')postComment(${id})"></textarea>
      <button class="btn small" onclick="postComment(${id})" style="align-self:flex-end;margin-top:6px">发送</button>
    </div>`;
  $('mask').classList.add('show');
}

function commentHtml(c, id) {
  return `<div class="comment"><b>${esc(c.user_name)}</b>${c.user_avatar ? `<img class="cava" src="${esc(c.user_avatar)}">` : ''}<span class="c-sub">${c.created_at}</span><br>${esc(c.text)}<div class="cact"><span class="cbtn ${c.liked_by_me ? 'on' : ''}" onclick="toggleComment(${c.id},'like',${id})">👍 ${c.like_count || 0}</span><span class="cbtn ${c.faved_by_me ? 'on' : ''}" onclick="toggleComment(${c.id},'fav',${id})">⭐ 收藏</span></div></div>`;
}

function closeModal() { $('mask').classList.remove('show'); }

async function saveMeta(id) {
  await api('items/' + id, 'PATCH', {
    folder_id: $('mFolder').value || null,
    book_id: $('mBook').value || null,
    recommend_note: $('mNote').value.trim(),
    author_name: S.username || '同学'
  });
  await refresh(); closeModal();
  toast($('mNote').value.trim() ? '已保存并推荐到广场' : '已保存');
}

async function postComment(id) {
  const text = $('ctext').value.trim();
  if (!text) return;
  await api('comments', 'POST', { item_id: id, user_name: (S.username || '同学'), text });
  await refresh(); openItem(id);
}

async function toggleComment(cid, kind, itemId) {
  try {
    const r = await api('comments/' + cid + '/' + kind, 'POST');
    toast(kind === 'like' ? (r.active ? '已点赞' : '已取消点赞') : (r.active ? '已收藏该评论' : '已取消收藏'));
    if (itemId) { await refresh(); openItem(itemId); }
    else if ($('favList')) { loadFavs(); }
  } catch (e) { toast(e.message); }
}

// ---------- 书架 ----------
async function addBook() {
  const title = $('bookTitle').value.trim(); if (!title) return toast('输入书名');
  await api('books', 'POST', { title }); $('bookTitle').value = ''; refresh();
}

function renderBooks() {
  const g = $('bookGrid');
  g.innerHTML = S.books.length ? '' : '<div class="empty" style="grid-column:1/-1">还没有书，建一本开始聚合资料</div>';
  for (const b of S.books) {
    const n = S.items.filter(i => i.book_id === b.id).length;
    const card = document.createElement('div'); card.className = 'card bookcard';
    card.onclick = () => openBook(b.id);
    card.innerHTML = `<h3>📖 ${esc(b.title)}</h3><p>${esc(b.author || '')}${b.author ? ' · ' : ''}${n} 篇相关资料</p>`;
    g.appendChild(card);
  }
}

function openBook(id) {
  const b = S.books.find(x => x.id === id);
  const items = S.items.filter(i => i.book_id === id);
  $('bookDetail').innerHTML = `
    <div class="section">《${esc(b.title)}》 · ${items.length} 篇资料</div>
    <p class="hint" style="margin-bottom:8px">${esc(b.note || '')}</p>
    <div class="grid">${items.map(it => `
      <div class="card" onclick="openItem(${it.id})"><h3>${esc(it.title)}</h3><div class="one">${esc(it.one_sentence)}</div>
      <div class="tags">${it.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div></div>`).join('')
      || '<div class="empty">这本书下还没有资料，收藏文章后在详情里挂到这本书下</div>'}</div>`;
  $('bookDetail').scrollIntoView({ behavior: 'smooth' });
}

// ---------- 广场 ----------
function renderSquare() {
  const g = $('squareGrid');
  const pubs = S.square || [];
  g.innerHTML = pubs.length ? '' : '<div class="empty" style="grid-column:1/-1">广场还很安静，点上方按钮推荐一篇试试</div>';
  for (const it of pubs) {
    const mine = S.items.some(x => x.id === it.id);
    const card = document.createElement('div'); card.className = 'card';
    card.onclick = () => openItem(it.id);
    card.innerHTML = `
      <div class="reco">💬 ${esc(it.author_name || it.owner || '同学')}：${esc(it.recommend_note || '觉得不错，分享给大家')}</div>
      <h3>${esc(it.title)}</h3>
      <div class="one">${esc(it.one_sentence)}</div>
      ${it.hot_comment ? `<div class="hotc clamp3">🔥 ${esc(it.hot_comment)}</div>` : ''}
      <div class="meta"><span>👤 ${esc(it.owner || '同学')}${mine ? '（你）' : ''}</span><span>💬 ${it.comment_count || 0} 条讨论</span><span>约 ${it.minutes} 分钟</span></div>`;
    g.appendChild(card);
  }
}

// ---------- 推荐到广场 ----------
function openRecommend(preId) {
  if (!S.items.length) { toast('先收藏几篇文章，再来推荐'); return; }
  const opts = S.items.map(i => `<option value="${i.id}" ${i.id === preId ? 'selected' : ''}>${esc(i.title)}</option>`).join('');
  $('modalBody').innerHTML = `
    <h2>📢 推荐到广场</h2>
    <p class="hint" style="margin:6px 0 12px">选择你的一篇收藏，写一句理由，全年级都能看到并参与讨论。</p>
    <select id="rItem">${opts}</select>
    <textarea id="rNote" rows="4" placeholder="写下推荐理由，可以是长评（必填）" style="width:100%;border:1px solid var(--line);border-radius:10px;padding:11px 14px;font-size:14px;font-family:inherit;resize:vertical;margin:4px 0 14px"></textarea>
    <button class="btn" onclick="submitRecommend()">发布到广场</button>`;
  $('mask').classList.add('show');
}

async function submitRecommend() {
  const id = $('rItem').value, note = $('rNote').value.trim();
  if (!note) { toast('写一句推荐理由吧'); return; }
  await api('items/' + id, 'PATCH', { recommend_note: note, author_name: (S.username || '同学') });
  await refresh(); closeModal(); toast('已发布到广场 🎉');
  document.querySelector('nav button[data-tab="square"]').click();
}

// ---------- 问收藏 ----------
const SUGGESTS = ['我的收藏里是怎么讲土地财政的？', '收藏的文章怎么看待时间管理？', '论文写作有什么建议？', '分税制改革的影响是什么？'];

function renderSuggests() {
  $('suggestBox').innerHTML = SUGGESTS.map(s => `<button onclick="$('chatInput').value=this.textContent;sendChat()">${s}</button>`).join('');
}

async function sendChat() {
  const q = $('chatInput').value.trim(); if (!q) return;
  $('chatInput').value = '';
  const log = $('chatLog');
  log.insertAdjacentHTML('beforeend', `<div class="bubble me">${esc(q)}</div><div class="bubble ai" id="pending"><span class="loading" style="border-color:var(--accent);border-top-color:transparent"></span>正在翻你的收藏…</div>`);
  log.scrollTop = log.scrollHeight;
  try {
    const d = await api('chat', 'POST', { question: q });
    const srcHtml = (d.sources || []).map(s => `
      <div class="srcCard" id="src-${s.n}" onclick="openItem(${s.item_id})" title="点击打开原文">
        <b>[${s.n}] ${esc(s.title)}</b>
        <div class="snippet">${esc(s.snippet)}……</div>
      </div>`).join('');
    $('pending').outerHTML = `<div class="bubble ai">${renderAnswer(d.answer)}${srcHtml ? '<div class="srcList">' + srcHtml + '</div>' : ''}</div>`;
  } catch (e) { $('pending').outerHTML = `<div class="bubble ai">出错了：${esc(e.message)}</div>`; }
  log.scrollTop = log.scrollHeight;
}

// 引用编号渲染为可点击徽章，点击滚动到对应引用卡片
function renderAnswer(text) {
  return esc(text).replace(/\[(\d{1,2})\]/g, (m, n) => `<sup class="cite" onclick="jumpSource(${n})" title="查看引用来源">${n}</sup>`);
}
function jumpSource(n) {
  const el = $('src-' + n);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1200);
}

// ---------- 个人主页 ----------
$('userBadge').onclick = () => showProfile();

async function showProfile() {
  const me = await api('me');
  $('modalBody').innerHTML = `
    <h2>个人主页</h2>
    <div style="display:flex;gap:16px;align-items:center;margin:14px 0">
      <img id="pAva" src="${me.avatar || '/favicon.svg'}" style="width:64px;height:64px;border-radius:50%;object-fit:cover;border:1px solid var(--line)">
      <div style="flex:1">
        <div style="font-weight:700;font-size:16px">${esc(me.nickname || me.username)}</div>
        <div class="hint">@${esc(me.username)}</div>
      </div>
      <label class="btn small ghost" style="cursor:pointer">换头像<input type="file" id="pAvaFile" accept="image/*" style="display:none" onchange="uploadAvatar(this)"></label>
    </div>
    <div style="margin-bottom:10px"><div class="hint" style="margin-bottom:4px">昵称（展示用，不是登录名）</div>
      <input id="pNick" value="${esc(me.nickname || '')}" placeholder="比如：夜跑爱好者" style="width:100%;border:1px solid var(--line);border-radius:10px;padding:10px 14px;font-size:14px"></div>
    <div style="margin-bottom:14px"><div class="hint" style="margin-bottom:4px">个人简介</div>
      <textarea id="pBio" rows="3" placeholder="介绍一下自己…" style="width:100%;border:1px solid var(--line);border-radius:10px;padding:10px 14px;font-size:14px;font-family:inherit;resize:vertical">${esc(me.bio || '')}</textarea></div>
    <button class="btn" onclick="saveProfile()">保存资料</button>
    <div class="section" style="font-size:14px;margin:18px 0 4px">⭐ 我收藏的评论</div>
    <div id="favList"><div class="hint">加载中…</div></div>
    <div style="margin-top:18px;text-align:right"><a style="color:#dc2626;cursor:pointer;font-size:13px" onclick="doLogout()">退出登录</a></div>`;
  $('mask').classList.add('show');
  loadFavs();
}

async function saveProfile() {
  try {
    await api('profile', 'PATCH', { nickname: $('pNick').value.trim(), bio: $('pBio').value });
    toast('资料已保存');
    const me = await api('me');
    $('userBadge').textContent = '👤 ' + (me.nickname || me.username);
  } catch (e) { toast(e.message); }
}

async function uploadAvatar(input) {
  const f = input.files[0]; if (!f) return;
  if (f.size > 200 * 1024) { toast('图片请小于 200KB，先压缩一下'); return; }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      await api('profile', 'PATCH', { avatar: reader.result });
      $('pAva').src = reader.result; toast('头像已更新');
    } catch (e) { toast(e.message); }
  };
  reader.readAsDataURL(f);
}

async function loadFavs() {
  try {
    const d = await api('fav-comments');
    $('favList').innerHTML = d.comments.length ? d.comments.map(c => `
      <div class="comment"><b>${esc(c.user_name)}</b> <span class="c-sub">评《${esc(c.item_title)}》</span><br>${esc(c.text)}
      <div class="cact"><span class="cbtn ${c.liked_by_me ? 'on' : ''}" onclick="toggleComment(${c.id},'like')">👍 ${c.like_count || 0}</span><span class="cbtn on" onclick="toggleComment(${c.id},'fav')">⭐ 已收藏</span></div></div>`).join('')
      : '<div class="hint">还没有收藏过评论。在任意评论下方点 ⭐ 收藏，它就会出现在这里。</div>';
  } catch (e) { $('favList').innerHTML = '<div class="hint">加载失败</div>'; }
}

async function doLogout() { await api('logout', 'POST'); location.reload(); }

// ---------- 登录 ----------
let registering = false;
function showAuth() { $('authMask').classList.add('show'); }

$('authSwitch').onclick = () => {
  registering = !registering;
  $('authGo').textContent = registering ? '注册并进入' : '登录';
  $('authSwitch').textContent = registering ? '直接登录' : '注册一个';
  $('authErr').textContent = '';
};

$('authGo').onclick = async () => {
  $('authErr').textContent = '';
  try {
    await api(registering ? 'register' : 'login', 'POST', { username: $('authUser').value.trim(), password: $('authPass').value });
    $('authMask').classList.remove('show');
    await boot();
  } catch (e) { $('authErr').textContent = e.message; }
};
$('authPass').addEventListener('keydown', e => { if (e.key === 'Enter') $('authGo').click(); });

async function boot() {
  try {
    const me = await api('me');
    $('userBadge').textContent = '👤 ' + (me.nickname || me.username);
    $('userBadge').style.display = '';
    await refresh();
  } catch (e) { showAuth(); }
}

// ---------- 提交辅助 ----------
$('textInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveItem(); } });
$('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
$('mask').addEventListener('click', e => { if (e.target === $('mask')) closeModal(); });

boot();
