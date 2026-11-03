// API 地址：默认公网服务器，本地调试时改回 http://localhost:3000/api
const API = "http://43.138.186.196:3000/api";
const $ = id => document.getElementById(id);
let page = null;
let loggedIn = false;

function esc(s) { return String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

async function apiGet(path) {
  const r = await fetch(API + "/" + path, { credentials: "include" });
  if (!r.ok) throw Object.assign(new Error(), { status: r.status, body: await r.json().catch(() => ({})) });
  return r.json();
}

async function init() {
  // 登录检查
  try {
    const me = await apiGet("me");
    loggedIn = true;
    $("whoami").textContent = "👤 " + me.username;
    $("authBox").style.display = "none";
    $("userBar").style.display = "flex";
    $("main").style.display = "";
    await loadFolders();
  } catch (e) {
    loggedIn = false;
    $("authBox").style.display = "block";
    $("userBar").style.display = "none";
    $("main").style.display = "none";
    return;
  }
  // 读取当前页面
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.url || !/^https?:/.test(tab.url)) {
      $("title").textContent = "这个页面无法收藏（请打开普通网页）";
      $("save").disabled = true;
      return;
    }
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const el = document.querySelector('article') || document.querySelector('main') || document.body;
        return {
          title: document.title,
          text: document.body ? document.body.innerText.slice(0, 16000) : "",
          html: el ? el.innerHTML.slice(0, 60000) : ""
        };
      }
    });
    page = { url: tab.url, title: r.result.title, text: r.result.text, html: r.result.html };
    $("title").textContent = r.result.title || tab.url;
    if ((r.result.text || "").trim().length < 30) {
      $("err").style.display = "block";
      $("err").textContent = "这个页面正文太少（可能是登录墙），请去主页手动粘贴正文";
    }
  } catch (e) {
    $("title").textContent = "无法读取此页面";
    $("save").disabled = true;
  }
}

async function loadFolders() {
  try {
    const s = await apiGet("state");
    $("folder").innerHTML = "";
    for (const f of s.folders) {
      const o = document.createElement("option");
      o.value = f.id; o.textContent = "📁 " + f.name;
      $("folder").appendChild(o);
    }
  } catch (e) { /* keep default */ }
}

$("authGo").onclick = async () => {
  $("authErr").textContent = "";
  try {
    const r = await fetch(API + "/login", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: $("authUser").value.trim(), password: $("authPass").value })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "登录失败");
    init();
  } catch (e) { $("authErr").textContent = e.message; }
};
$("authPass").addEventListener("keydown", e => { if (e.key === "Enter") $("authGo").click(); });

$("logout").onclick = async () => {
  await fetch(API + "/logout", { method: "POST", credentials: "include" });
  location.reload();
};

$("save").onclick = async () => {
  if (!page) return;
  const btn = $("save");
  btn.disabled = true; btn.textContent = "AI 正在阅读…";
  try {
    const r = await fetch(API + "/items", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: page.url, title: page.title, text: page.text, html: page.html, folder_id: $("folder").value ? Number($("folder").value) : null })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "收藏失败");
    btn.textContent = "✓ 已收藏";
    const it = d.item;
    const box = $("result");
    box.style.display = "block";
    const ag = d.agent && d.agent.note ? "🤖 " + esc(d.agent.note) + "<br>" : "";
    box.innerHTML = `<b>${esc(it.title)}</b><br>${esc(it.one_sentence)}<br>${it.tags.map(t => "#" + esc(t)).join(" ")} · 约${it.minutes}分钟<br>${ag}`;
  } catch (e) {
    if (e.status === 401) { loggedIn = false; init(); return; }
    $("err").style.display = "block";
    $("err").textContent = e.message;
    btn.disabled = false; btn.textContent = "一键收藏";
  }
};

init();
