/** Single-page workspace UI. No build step; served from the same process. */
export function workspaceHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Agent Workspace</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
:root {
  --bg0:#0e1013; --bg1:#161a20; --panel:#12151a; --ink:#e8ecf1; --muted:#93a0ae;
  --accent:#7aa2ff; --accent2:#c4f542; --line:#252c36; --danger:#ff6b6b;
}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;font-family:"IBM Plex Sans",sans-serif;color:var(--ink);
  background:radial-gradient(1100px 500px at 15% -10%, #1b2430 0%, transparent 55%),
             radial-gradient(900px 500px at 100% 0%, #17251c 0%, transparent 50%), var(--bg0);}
header{display:flex;align-items:center;gap:14px;padding:14px 22px;border-bottom:1px solid var(--line)}
header h1{margin:0;font-size:18px;letter-spacing:-0.01em}
nav{display:flex;gap:4px;margin-left:12px}
nav button{border:none;background:transparent;color:var(--muted);font:inherit;font-size:13px;
  padding:8px 12px;border-radius:8px;cursor:pointer}
nav button.active{background:var(--bg1);color:var(--ink)}
.pill{margin-left:auto;font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--muted);
  border:1px solid var(--line);padding:3px 9px;border-radius:999px}
.pill.live{border-color:var(--accent2);color:var(--accent2)}
main{height:calc(100vh - 61px)}
.view{display:none;height:100%}
.view.active{display:flex}
/* chat */
#chatView aside{width:270px;border-right:1px solid var(--line);padding:14px;display:flex;flex-direction:column;gap:10px;background:color-mix(in oklab,var(--bg1) 70%,transparent)}
#chatView aside button.new{background:var(--accent2);color:#111;border:none;border-radius:8px;padding:9px;font-weight:600;cursor:pointer}
#sessionList{list-style:none;margin:0;padding:0;overflow:auto;flex:1}
#sessionList li{padding:9px 10px;border-radius:8px;cursor:pointer;font-size:13px;display:flex;justify-content:space-between;gap:8px}
#sessionList li:hover{background:var(--bg1)}
#sessionList li.active{background:var(--bg1);outline:1px solid var(--line)}
#sessionList .n{color:var(--muted);font-family:"IBM Plex Mono",monospace;font-size:11px}
#chatMain{flex:1;display:flex;flex-direction:column;min-width:0}
#thread{flex:1;overflow:auto;padding:22px;display:flex;flex-direction:column;gap:14px}
.msg{max-width:72ch;line-height:1.5;font-size:14px;white-space:pre-wrap;word-break:break-word;
  padding:12px 15px;border-radius:12px}
.msg.user{align-self:flex-end;background:#1d2836;border:1px solid #2b3a4f}
.msg.assistant{align-self:flex-start;background:var(--panel);border-left:3px solid var(--accent2);border-radius:0 12px 12px 0}
.msg.err{align-self:center;color:var(--danger);background:transparent;font-family:"IBM Plex Mono",monospace;font-size:12px}
#composer{display:flex;gap:10px;padding:14px 22px;border-top:1px solid var(--line)}
#composer textarea{flex:1;resize:none;min-height:52px;max-height:160px;font:inherit;font-size:14px;
  background:var(--bg1);color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:11px 13px}
#composer button{background:var(--accent2);border:none;border-radius:10px;padding:0 22px;font-weight:600;cursor:pointer;color:#111}
#composer button:disabled{opacity:.5;cursor:wait}
/* generic split views */
.split{display:flex;width:100%;height:100%}
.split .list{width:300px;border-right:1px solid var(--line);overflow:auto;padding:14px;background:color-mix(in oklab,var(--bg1) 70%,transparent)}
.split .body{flex:1;display:flex;flex-direction:column;min-width:0;padding:14px 18px;gap:10px}
.split .body textarea{flex:1;font-family:"IBM Plex Mono",monospace;font-size:13px;line-height:1.5;
  background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:13px}
.rowbtns{display:flex;gap:8px}
.rowbtns button{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--bg1);color:var(--ink);
  border-radius:8px;padding:8px 14px;cursor:pointer}
.rowbtns button.primary{background:var(--accent2);border:none;color:#111;font-weight:600}
.entry{display:flex;justify-content:space-between;gap:8px;padding:7px 9px;border-radius:7px;cursor:pointer;font-size:13px;font-family:"IBM Plex Mono",monospace}
.entry:hover{background:var(--bg1)}
.entry.dir{color:var(--accent)}
.entry .meta{color:var(--muted);font-size:11px}
.crumbs{font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--muted);margin-bottom:8px}
.crumbs a{color:var(--accent);cursor:pointer;text-decoration:none}
/* terminal */
#termOut{flex:1;overflow:auto;background:#080b0e;border:1px solid var(--line);border-radius:10px;padding:13px;
  font-family:"IBM Plex Mono",monospace;font-size:12.5px;white-space:pre-wrap;word-break:break-all}
#termIn{font-family:"IBM Plex Mono",monospace;font-size:13px;background:var(--bg1);color:var(--ink);
  border:1px solid var(--line);border-radius:8px;padding:10px 12px}
/* login overlay */
#login{position:fixed;inset:0;background:rgba(8,10,12,.92);display:none;align-items:center;justify-content:center;z-index:50}
#login.open{display:flex}
#login form{background:var(--bg1);border:1px solid var(--line);border-radius:14px;padding:26px;width:320px;display:flex;flex-direction:column;gap:12px}
#login input{font:inherit;background:var(--bg0);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:10px 12px}
#login button{background:var(--accent2);border:none;border-radius:8px;padding:10px;font-weight:600;cursor:pointer}
#login .err{color:var(--danger);font-size:12px;min-height:14px}
.note{color:var(--muted);font-size:12.5px;line-height:1.5;max-width:60ch}
</style>
</head>
<body>
<header>
  <h1>Agent Workspace</h1>
  <nav>
    <button data-view="chatView" class="active">Chat</button>
    <button data-view="filesView">Files</button>
    <button data-view="memoryView">Memory</button>
    <button data-view="skillsView">Skills</button>
    <button data-view="termView">Terminal</button>
  </nav>
  <span class="pill" id="backendPill">…</span>
</header>
<main>
  <section class="view active" id="chatView">
    <aside>
      <button class="new" id="newChat">New chat</button>
      <ul id="sessionList"></ul>
    </aside>
    <div id="chatMain">
      <div id="thread"><p class="note" style="padding:22px">Create a chat and talk to the model. Replies stream live and every message persists across restarts.</p></div>
      <div id="composer">
        <textarea id="chatText" placeholder="Message the agent…"></textarea>
        <button id="send">Send</button>
      </div>
    </div>
  </section>

  <section class="view" id="filesView">
    <div class="split">
      <div class="list">
        <div class="crumbs" id="crumbs"></div>
        <div id="fileList"></div>
      </div>
      <div class="body">
        <div class="rowbtns">
          <span class="crumbs" id="openPath" style="flex:1"></span>
          <button class="primary" id="saveFile" disabled>Save</button>
        </div>
        <textarea id="fileBody" placeholder="Open a file from the left."></textarea>
      </div>
    </div>
  </section>

  <section class="view" id="memoryView">
    <div class="split">
      <div class="list">
        <div class="rowbtns" style="margin-bottom:10px">
          <button class="primary" id="newNote">New note</button>
        </div>
        <div id="noteList"></div>
      </div>
      <div class="body">
        <div class="rowbtns">
          <span class="crumbs" id="notePath" style="flex:1"></span>
          <button id="deleteNote" disabled>Delete</button>
          <button class="primary" id="saveNote" disabled>Save</button>
        </div>
        <textarea id="noteBody" placeholder="Shared markdown memory. The agent's context, your edits."></textarea>
      </div>
    </div>
  </section>

  <section class="view" id="skillsView">
    <div class="split">
      <div class="list"><div id="skillList"></div></div>
      <div class="body">
        <span class="crumbs" id="skillPath"></span>
        <textarea id="skillBody" readonly placeholder="Read-only skill documents (drop .md files in the skills dir)."></textarea>
      </div>
    </div>
  </section>

  <section class="view" id="termView">
    <div class="split"><div class="body">
      <div id="termOut">Terminal connects on open. Piped bash (no PTY) — line-based commands work best.</div>
      <input id="termIn" placeholder="type a command and press Enter" />
    </div></div>
  </section>
</main>

<div id="login"><form id="loginForm">
  <strong>Workspace locked</strong>
  <span class="note">This deployment sets WORKSPACE_PASSWORD. Enter it to continue.</span>
  <input type="password" id="pw" placeholder="password" autofocus />
  <div class="err" id="loginErr"></div>
  <button type="submit">Unlock</button>
</form></div>

<script>
const $ = (s) => document.querySelector(s);
let sessionId = null;
let sending = false;
let curFileDir = '.';
let curFile = null;
let curNote = null;
let termWs = null;

// ---- auth ----
async function api(url, opts) {
  const r = await fetch(url, opts);
  if (r.status === 401) { $('#login').classList.add('open'); throw new Error('unauthorized'); }
  return r;
}
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const r = await fetch('/api/login', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ password: $('#pw').value }) });
  if (r.ok) { $('#login').classList.remove('open'); boot(); }
  else $('#loginErr').textContent = (await r.json()).error || 'login failed';
};

// ---- nav ----
document.querySelectorAll('nav button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('nav button').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  b.classList.add('active');
  $('#' + b.dataset.view).classList.add('active');
  if (b.dataset.view === 'filesView') loadFiles(curFileDir);
  if (b.dataset.view === 'memoryView') loadNotes();
  if (b.dataset.view === 'skillsView') loadSkills();
  if (b.dataset.view === 'termView') openTerm();
});

// ---- chat ----
function msgEl(role, text) {
  const d = document.createElement('div');
  d.className = 'msg ' + role;
  d.textContent = text;
  $('#thread').appendChild(d);
  $('#thread').scrollTop = $('#thread').scrollHeight;
  return d;
}
async function loadSessions() {
  const j = await (await api('/api/sessions')).json();
  const ul = $('#sessionList'); ul.replaceChildren();
  for (const s of j.sessions) {
    const li = document.createElement('li');
    if (s.id === sessionId) li.classList.add('active');
    const t = document.createElement('span'); t.textContent = s.title;
    const n = document.createElement('span'); n.className = 'n'; n.textContent = s.messageCount;
    li.appendChild(t); li.appendChild(n);
    li.onclick = () => openSession(s.id);
    ul.appendChild(li);
  }
}
async function openSession(id) {
  sessionId = id;
  const j = await (await api('/api/sessions/' + id + '/messages')).json();
  $('#thread').replaceChildren();
  for (const m of j.messages) msgEl(m.role === 'user' ? 'user' : 'assistant', m.content);
  loadSessions();
}
$('#newChat').onclick = async () => {
  const j = await (await api('/api/sessions', { method: 'POST', headers: {'content-type':'application/json'}, body: '{}' })).json();
  await openSession(j.id);
};
async function send() {
  const text = $('#chatText').value.trim();
  if (!text || sending) return;
  if (!sessionId) await $('#newChat').onclick();
  sending = true; $('#send').disabled = true;
  $('#chatText').value = '';
  msgEl('user', text);
  const holder = msgEl('assistant', '');
  try {
    const r = await api('/api/sessions/' + sessionId + '/chat', {
      method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ text }),
    });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const events = buf.split('\\n\\n'); buf = events.pop() || '';
      for (const ev of events) {
        const type = (ev.match(/^event: (.*)$/m) || [])[1];
        const data = (ev.match(/^data: (.*)$/m) || [])[1];
        if (!type || !data) continue;
        const j = JSON.parse(data);
        if (type === 'delta') { holder.textContent += j.text; $('#thread').scrollTop = $('#thread').scrollHeight; }
        if (type === 'error') msgEl('err', j.message);
      }
    }
  } catch (e) {
    msgEl('err', String(e.message || e));
  }
  sending = false; $('#send').disabled = false;
  loadSessions();
}
$('#send').onclick = send;
$('#chatText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

// ---- files ----
async function loadFiles(dir) {
  curFileDir = dir;
  const j = await (await api('/api/files?dir=' + encodeURIComponent(dir))).json();
  const crumbs = $('#crumbs'); crumbs.replaceChildren();
  const parts = dir === '.' ? [] : dir.split('/');
  const rootA = document.createElement('a'); rootA.textContent = '~'; rootA.onclick = () => loadFiles('.');
  crumbs.appendChild(rootA);
  parts.forEach((p, i) => {
    crumbs.appendChild(document.createTextNode(' / '));
    const a = document.createElement('a'); a.textContent = p;
    a.onclick = () => loadFiles(parts.slice(0, i + 1).join('/'));
    crumbs.appendChild(a);
  });
  const list = $('#fileList'); list.replaceChildren();
  for (const e of j.entries) {
    const d = document.createElement('div');
    d.className = 'entry' + (e.dir ? ' dir' : '');
    const n = document.createElement('span'); n.textContent = (e.dir ? '▸ ' : '') + e.name;
    const m = document.createElement('span'); m.className = 'meta'; m.textContent = e.dir ? '' : (e.size + 'b');
    d.appendChild(n); d.appendChild(m);
    d.onclick = () => e.dir
      ? loadFiles(dir === '.' ? e.name : dir + '/' + e.name)
      : openFile(dir === '.' ? e.name : dir + '/' + e.name);
    list.appendChild(d);
  }
}
async function openFile(rel) {
  const j = await (await api('/api/files/content?path=' + encodeURIComponent(rel))).json();
  if (j.error) return;
  curFile = rel;
  $('#openPath').textContent = rel;
  $('#fileBody').value = j.content;
  $('#saveFile').disabled = false;
}
$('#saveFile').onclick = async () => {
  if (!curFile) return;
  await api('/api/files/content', { method: 'PUT', headers: {'content-type':'application/json'},
    body: JSON.stringify({ path: curFile, content: $('#fileBody').value }) });
  $('#saveFile').textContent = 'Saved ✓';
  setTimeout(() => $('#saveFile').textContent = 'Save', 1200);
};

// ---- memory ----
async function loadNotes() {
  const j = await (await api('/api/memory')).json();
  const list = $('#noteList'); list.replaceChildren();
  for (const n of j.notes) {
    const d = document.createElement('div'); d.className = 'entry'; d.textContent = n;
    d.onclick = () => openNote(n);
    list.appendChild(d);
  }
}
async function openNote(name) {
  const j = await (await api('/api/memory/' + encodeURIComponent(name))).json();
  curNote = name;
  $('#notePath').textContent = name;
  $('#noteBody').value = j.content;
  $('#saveNote').disabled = false;
  $('#deleteNote').disabled = false;
}
$('#newNote').onclick = async () => {
  const name = prompt('Note name (.md)', 'notes-' + Date.now().toString(36) + '.md');
  if (!name) return;
  await api('/api/memory/' + encodeURIComponent(name), { method: 'PUT', headers: {'content-type':'application/json'}, body: JSON.stringify({ content: '# ' + name + '\\n' }) });
  await loadNotes(); openNote(name);
};
$('#saveNote').onclick = async () => {
  if (!curNote) return;
  await api('/api/memory/' + encodeURIComponent(curNote), { method: 'PUT', headers: {'content-type':'application/json'}, body: JSON.stringify({ content: $('#noteBody').value }) });
  $('#saveNote').textContent = 'Saved ✓'; setTimeout(() => $('#saveNote').textContent = 'Save', 1200);
};
$('#deleteNote').onclick = async () => {
  if (!curNote || !confirm('Delete ' + curNote + '?')) return;
  await api('/api/memory/' + encodeURIComponent(curNote), { method: 'DELETE' });
  curNote = null; $('#noteBody').value = ''; $('#notePath').textContent = '';
  $('#saveNote').disabled = true; $('#deleteNote').disabled = true;
  loadNotes();
};

// ---- skills ----
async function loadSkills() {
  const j = await (await api('/api/skills')).json();
  const list = $('#skillList'); list.replaceChildren();
  if (!j.skills.length) {
    const p = document.createElement('p'); p.className = 'note';
    p.textContent = 'No skills installed. Drop .md skill files into the skills dir (WORKSPACE_SKILLS_DIR).';
    list.appendChild(p); return;
  }
  for (const s of j.skills) {
    const d = document.createElement('div'); d.className = 'entry'; d.textContent = s.name;
    d.onclick = async () => {
      const c = await (await api('/api/skills/content?path=' + encodeURIComponent(s.path))).json();
      $('#skillPath').textContent = s.name;
      $('#skillBody').value = c.content || '';
    };
    list.appendChild(d);
  }
}

// ---- terminal ----
function openTerm() {
  if (termWs && termWs.readyState === WebSocket.OPEN) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  termWs = new WebSocket(proto + '://' + location.host + '/ws/terminal');
  termWs.onmessage = (ev) => {
    $('#termOut').textContent += ev.data;
    $('#termOut').scrollTop = $('#termOut').scrollHeight;
  };
  termWs.onclose = () => { $('#termOut').textContent += '\\n[disconnected]\\n'; };
}
$('#termIn').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && termWs) {
    termWs.send($('#termIn').value + '\\n');
    $('#termIn').value = '';
  }
});

// ---- boot ----
async function boot() {
  const r = await fetch('/api/health');
  const j = await r.json();
  $('#backendPill').textContent = j.backend.mode + ' · ' + j.backend.model;
  $('#backendPill').classList.add('live');
  try { await loadSessions(); } catch { /* login overlay already shown */ }
}
boot();
</script>
</body>
</html>`;
}
