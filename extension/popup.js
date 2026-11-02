const API = "http://localhost:3000/api";
const $ = id => document.getElementById(id);
let page = null;

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.url || !/^https?:/.test(tab.url)) {
      $("title").textContent = "这个页面无法收藏（请打开普通网页）";
      $("save").disabled = true;
      return;
    }
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ title: document.title, text: document.body ? document.body.innerText.slice(0, 16000) : "" })
    });
    page = { url: tab.url, title: r.result.title, text: r.result.text };
    $("title").textContent = r.result.title || tab.url;
    if ((r.result.text || "").trim().length < 30) {
      $("err").style.display = "block";
      $("err").textContent = "这个页面正文太少（可能是登录墙），请去拾页主页手动粘贴正文";
    }
  } catch (e) {
    $("title").textContent = "无法读取此页面";
    $("save").disabled = true;
  }
  try {
    const s = await fetch(API + "/state").then(r => r.json());
    for (const f of s.folders) {
      const o = document.createElement("option");
      o.value = f.id; o.textContent = "📁 " + f.name;
      $("folder").appendChild(o);
    }
  } catch (e) {
    $("err").style.display = "block";
    $("err").textContent = "连不上拾页服务（先双击 启动拾页.bat）";
    $("save").disabled = true;
  }
}

$("save").onclick = async () => {
  if (!page) return;
  const btn = $("save");
  btn.disabled = true; btn.textContent = "AI 正在阅读…";
  try {
    const r = await fetch(API + "/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: page.url, title: page.title, text: page.text, folder_id: $("folder").value ? Number($("folder").value) : null })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "收藏失败");
    btn.textContent = "✓ 已收藏";
    const it = d.item;
    const box = $("result");
    box.style.display = "block";
    box.innerHTML = `<b>${esc(it.title)}</b><br>${esc(it.one_sentence)}<br>${it.tags.map(t => "#" + esc(t)).join(" ")} · 约${it.minutes}分钟`;
  } catch (e) {
    $("err").style.display = "block";
    $("err").textContent = e.message;
    btn.disabled = false; btn.textContent = "一键收藏";
  }
};

function esc(s) { return String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
init();

