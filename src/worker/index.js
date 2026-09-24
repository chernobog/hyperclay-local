/**
 * Cloudgolem - Malleable HTML File Cloud Host for Cloudflare Workers & R2
 * Implements Malleable HTML File Specification (Spec v1, draft)
 *
 * Capabilities:
 * - Serves documents & assets from R2 storage (`GET /*`)
 * - Saves malleable HTML documents (`POST /_/save`) with ETag & If-Match support
 * - Uploads document assets (`POST /_/upload`)
 * - Capability discovery (`GET /_/meta`)
 * - Version backup history (`_versions/<path>/<timestamp>.html`)
 * - Built-in Cloudgolem Hub launcher with:
 *     - Multi-template starter catalog (Writer, Kanban, DevLog, Checklist, Blank)
 *     - Direct Malleable HTML file uploader (drag & drop import)
 *     - App management (Open, Clone, Delete)
 */

// Helper to compute Spec §6 ETag (first 16 chars of sha256)
async function computeEtag(content) {
  const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hex.substring(0, 16);
}

// Check if If-Match header matches current ETag (Spec §6)
function isIfMatchSatisfied(ifMatchHeader, currentEtag, currentLength) {
  if (!ifMatchHeader) return true;
  const header = String(ifMatchHeader).trim();
  if (header === '*') return currentLength > 0;
  return header.split(',').some(entry => {
    const clean = entry.trim().replace(/^W\//i, '').replace(/^"(.*)"$/, '$1');
    return clean !== '' && clean === currentEtag;
  });
}

// Sanitize and resolve file paths within storage
function resolveStoragePath(pathname) {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {}

  // Remove leading slash
  let clean = decoded.replace(/^\/+/, '');
  if (!clean || clean === '') clean = 'index.html';

  // Prevent path traversal
  const segments = clean.split('/').filter(s => s !== '' && s !== '.');
  if (segments.some(s => s === '..')) {
    return null;
  }
  return segments.join('/');
}

// MIME types dictionary
const MIME_TYPES = {
  html: 'text/html; charset=utf-8',
  htmlclay: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  pdf: 'application/pdf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf'
};

function getMimeType(path) {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  return MIME_TYPES[ext] || 'application/octet-stream';
}

// Verify authorization if AUTH_KEY is set in environment
function isAuthorized(request, env) {
  if (!env.AUTH_KEY) return true; // Open access or secured via Cloudflare Access

  // Check Cloudflare Access identity headers
  if (request.headers.get('cf-access-authenticated-user-email') || request.headers.get('cf-access-jwt-assertion')) {
    return true;
  }

  // Check Bearer Token
  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    if (authHeader.slice(7).trim() === env.AUTH_KEY) return true;
  }

  // Check query param (?key=...)
  const url = new URL(request.url);
  if (url.searchParams.get('key') === env.AUTH_KEY) return true;

  return false;
}

// Common client-side malleable self-saving script
function getMalleableClientScript() {
  return `
    let isDirty = false;
    function markDirty() {
      isDirty = true;
      const st = document.getElementById('status');
      if (st) {
        st.textContent = 'Unsaved changes';
        st.style.color = '#e3b341';
        st.style.borderColor = '#e3b341';
      }
    }

    document.querySelectorAll('[contenteditable="true"]').forEach(el => {
      el.addEventListener('input', markDirty);
    });

    async function saveApp() {
      const st = document.getElementById('status');
      if (st) {
        st.textContent = 'Saving...';
        st.style.color = '#58a6ff';
        st.style.borderColor = '#58a6ff';
      }

      // Sync checkboxes & inputs to DOM attributes
      document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        if (cb.checked) cb.setAttribute('checked', '');
        else cb.removeAttribute('checked');
      });
      document.querySelectorAll('input[type="text"], textarea').forEach(inp => {
        inp.setAttribute('value', inp.value);
      });

      // Clone DOM and strip [no-save] elements
      const clone = document.documentElement.cloneNode(true);
      clone.querySelectorAll('[no-save]').forEach(el => el.remove());

      const payload = '<!DOCTYPE html>\\n' + clone.outerHTML;

      try {
        const res = await fetch('/_/save', {
          method: 'POST',
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Document-URL': window.location.href
          },
          body: payload
        });

        if (res.ok) {
          isDirty = false;
          if (st) {
            st.textContent = 'Saved';
            st.style.color = '#3fb950';
            st.style.borderColor = '#30363d';
          }
        } else {
          const err = await res.json().catch(() => ({ msg: 'Save failed' }));
          if (st) {
            st.textContent = 'Error: ' + (err.msg || 'Save failed');
            st.style.color = '#f85149';
            st.style.borderColor = '#f85149';
          }
        }
      } catch (e) {
        if (st) {
          st.textContent = 'Connection error';
          st.style.color = '#f85149';
          st.style.borderColor = '#f85149';
        }
      }
    }

    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveApp();
      }
    });

    window.addEventListener('beforeunload', (e) => {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  `;
}

// -----------------------------------------------------------------
// Template 1: Distraction-Free Writer & Notes
// -----------------------------------------------------------------
function generateWriterHtml(title) {
  const cleanTitle = title || 'Distraction-Free Writer';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${cleanTitle}</title>
  <style>
    :root {
      --bg: #0d1117;
      --card: #161b22;
      --border: #30363d;
      --text: #e6edf3;
      --muted: #8b949e;
      --accent: #58a6ff;
      --success: #238636;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      max-width: 780px;
      margin: 40px auto;
      padding: 0 24px;
      line-height: 1.8;
      transition: font-family 0.2s;
    }
    body.serif-mode {
      font-family: Georgia, Cambria, "Times New Roman", Times, serif;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--border);
    }
    .meta-bar {
      display: flex;
      gap: 14px;
      font-size: 13px;
      color: var(--muted);
      align-items: center;
    }
    .toolbar {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      background: var(--card);
      border: 1px solid var(--border);
      padding: 8px 12px;
      border-radius: 8px;
      margin-bottom: 28px;
      position: sticky;
      top: 16px;
      z-index: 100;
      backdrop-filter: blur(8px);
    }
    .tool-btn {
      background: #21262d;
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 5px 11px;
      font-size: 13px;
      cursor: pointer;
      font-weight: 500;
    }
    .tool-btn:hover { background: #30363d; }
    .save-badge {
      display: inline-flex;
      align-items: center;
      font-size: 12px;
      background: #21262d;
      padding: 4px 10px;
      border-radius: 16px;
      border: 1px solid var(--border);
      color: #3fb950;
    }
    button.save-btn {
      background: var(--success);
      color: #fff;
      border: none;
      padding: 6px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      font-size: 13px;
    }
    .editor-title {
      font-size: 34px;
      font-weight: 700;
      line-height: 1.25;
      margin-bottom: 10px;
      outline: none;
      color: #fff;
    }
    .editor-subtitle {
      font-size: 18px;
      color: var(--muted);
      margin-bottom: 30px;
      outline: none;
    }
    .editor-body {
      font-size: 17px;
      outline: none;
      min-height: 480px;
    }
    .editor-body h2 { color: #fff; margin-top: 36px; margin-bottom: 12px; font-size: 24px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
    .editor-body h3 { color: #fff; margin-top: 24px; margin-bottom: 8px; font-size: 20px; }
    .editor-body blockquote {
      border-left: 3px solid var(--accent);
      margin: 18px 0;
      padding-left: 16px;
      color: #8b949e;
      font-style: italic;
    }
    .editor-body ul, .editor-body ol { padding-left: 24px; margin: 16px 0; }
    .editor-body li { margin-bottom: 6px; }
    .editor-body code {
      background: #21262d;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: ui-monospace, SFMono-Regular, monospace;
      font-size: 0.9em;
    }
  </style>
</head>
<body>
  <header no-save>
    <div class="meta-bar">
      <a href="/_/hub" style="color: var(--muted); text-decoration: none; font-weight: 500;">&larr; Hub</a>
      <span id="wordCount">0 words</span>
      <span id="charCount">0 chars</span>
      <span id="readTime">1 min read</span>
    </div>
    <div style="display: flex; gap: 8px; align-items: center;">
      <span id="status" class="save-badge">Saved</span>
      <button class="save-btn" onclick="saveApp()">Save (Ctrl+S)</button>
    </div>
  </header>

  <div class="toolbar" no-save>
    <button class="tool-btn" onclick="formatDoc('bold')" title="Bold"><b>B</b></button>
    <button class="tool-btn" onclick="formatDoc('italic')" title="Italic"><i>I</i></button>
    <button class="tool-btn" onclick="formatDoc('strikeThrough')" title="Strikethrough"><s>S</s></button>
    <button class="tool-btn" onclick="formatBlock('h2')" title="Heading 2">H2</button>
    <button class="tool-btn" onclick="formatBlock('h3')" title="Heading 3">H3</button>
    <button class="tool-btn" onclick="formatBlock('blockquote')" title="Quote">&ldquo;&rdquo;</button>
    <button class="tool-btn" onclick="formatDoc('insertUnorderedList')" title="Bullet List">&bull; List</button>
    <button class="tool-btn" onclick="formatDoc('insertOrderedList')" title="Numbered List">1. List</button>
    <button class="tool-btn" onclick="toggleSerif()" title="Toggle Serif / Sans">Aa</button>
  </div>

  <article>
    <h1 class="editor-title" contenteditable="true">${cleanTitle}</h1>
    <div class="editor-subtitle" contenteditable="true">A distraction-free malleable workspace for essays, documentation, and notes.</div>
    <div class="editor-body" contenteditable="true">
      <p>Writing in a malleable HTML document is fundamentally different from traditional word processors. The text you write, the typography you apply, and the structure of your thoughts are stored verbatim directly in this file's DOM on Cloudflare R2.</p>
      <blockquote>"Malleable software gives the user agency to customize and own their software environment as easily as writing in a physical journal."</blockquote>
      <h2>Key Capabilities</h2>
      <ul>
        <li><b>Zero Vendor Lock-in</b>: The entire file can be saved offline, opened anywhere, and edited in any browser.</li>
        <li><b>Instant Saving</b>: Press <kbd>Ctrl+S</kbd> or <kbd>Cmd+S</kbd> to persist changes back to Cloudgolem.</li>
        <li><b>Versioned History</b>: Every save automatically creates an immutable backup snapshot in your R2 bucket.</li>
      </ul>
      <h2>My Draft</h2>
      <p>Start writing your thoughts here. You can format text using the toolbar or standard keyboard shortcuts.</p>
    </div>
  </article>

  <script>
    function formatDoc(cmd, val = null) {
      document.execCommand(cmd, false, val);
      markDirty();
    }
    function formatBlock(tag) {
      document.execCommand('formatBlock', false, tag);
      markDirty();
    }
    function toggleSerif() {
      document.body.classList.toggle('serif-mode');
      markDirty();
    }
    function updateCounts() {
      const text = document.querySelector('.editor-body')?.innerText || '';
      const words = text.trim() ? text.trim().split(/\\s+/).length : 0;
      const chars = text.length;
      const readMin = Math.max(1, Math.ceil(words / 200));
      const wc = document.getElementById('wordCount');
      const cc = document.getElementById('charCount');
      const rt = document.getElementById('readTime');
      if (wc) wc.textContent = words + ' words';
      if (cc) cc.textContent = chars + ' chars';
      if (rt) rt.textContent = readMin + ' min read';
    }
    document.addEventListener('input', updateCounts);
    updateCounts();

    ${getMalleableClientScript()}
  </script>
</body>
</html>`;
}

// -----------------------------------------------------------------
// Template 2: Interactive Kanban Board
// -----------------------------------------------------------------
function generateKanbanHtml(title) {
  const cleanTitle = title || 'Project Kanban Board';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${cleanTitle}</title>
  <style>
    :root {
      --bg: #0d1117;
      --card: #161b22;
      --card-bg: #21262d;
      --border: #30363d;
      --text: #e6edf3;
      --muted: #8b949e;
      --accent: #58a6ff;
      --success: #238636;
      --purple: #bc8cff;
      --amber: #e3b341;
    }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 30px;
      line-height: 1.5;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    h1 { margin: 0; font-size: 26px; color: #fff; outline: none; }
    .save-badge {
      display: inline-flex;
      align-items: center;
      font-size: 13px;
      background: #21262d;
      padding: 5px 12px;
      border-radius: 20px;
      border: 1px solid var(--border);
      color: #3fb950;
    }
    button.save-btn {
      background: var(--success);
      color: #fff;
      border: none;
      padding: 7px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
    }
    .board {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 20px;
      align-items: start;
    }
    .column {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      display: flex;
      flex-direction: column;
    }
    .col-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 14px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--border);
    }
    .col-title { font-weight: 700; font-size: 16px; color: #fff; outline: none; }
    .col-badge {
      font-size: 12px;
      background: #30363d;
      padding: 2px 8px;
      border-radius: 12px;
      color: var(--muted);
    }
    .card-list {
      min-height: 120px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .kanban-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px 14px;
      cursor: grab;
      position: relative;
      transition: transform 0.15s, box-shadow 0.15s;
    }
    .kanban-card:active { cursor: grabbing; }
    .kanban-card.dragging {
      opacity: 0.4;
      border-style: dashed;
    }
    .card-tag {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      padding: 2px 6px;
      border-radius: 4px;
      display: inline-block;
      margin-bottom: 6px;
      background: rgba(88, 166, 255, 0.15);
      color: var(--accent);
      outline: none;
    }
    .card-tag.urgent { background: rgba(248, 81, 73, 0.15); color: #f85149; }
    .card-tag.feature { background: rgba(188, 140, 255, 0.15); color: var(--purple); }
    .card-tag.done { background: rgba(63, 185, 80, 0.15); color: #3fb950; }
    .card-title {
      font-weight: 600;
      font-size: 14px;
      color: #fff;
      margin-bottom: 4px;
      outline: none;
    }
    .card-desc {
      font-size: 13px;
      color: var(--muted);
      outline: none;
    }
    .card-actions {
      display: flex;
      justify-content: flex-end;
      margin-top: 8px;
    }
    .card-del-btn {
      background: none;
      border: none;
      color: #6e7681;
      cursor: pointer;
      font-size: 14px;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .card-del-btn:hover { color: #f85149; background: #30363d; }
    .add-card-btn {
      margin-top: 14px;
      background: #21262d;
      border: 1px dashed var(--border);
      color: var(--text);
      padding: 8px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      width: 100%;
    }
    .add-card-btn:hover { background: #30363d; border-color: var(--accent); }
    .drag-over {
      background: rgba(88, 166, 255, 0.05);
      border-radius: 6px;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1 contenteditable="true">${cleanTitle}</h1>
      <p style="margin: 4px 0 0; color: #8b949e; font-size: 13px;">Drag cards between columns &bull; Inline editable &bull; Powered by Cloudgolem</p>
    </div>
    <div style="display: flex; gap: 10px; align-items: center;" no-save>
      <a href="/_/hub" style="color: #8b949e; text-decoration: none; font-size: 13px; margin-right: 8px;">&larr; Hub</a>
      <span id="status" class="save-badge">Saved</span>
      <button class="save-btn" onclick="saveApp()">Save (Ctrl+S)</button>
    </div>
  </header>

  <main class="board">
    <!-- Column 1 -->
    <div class="column" id="col-backlog">
      <div class="col-header">
        <span class="col-title" contenteditable="true">💡 Backlog & Ideas</span>
        <span class="col-badge">2</span>
      </div>
      <div class="card-list" ondragover="handleDragOver(event)" ondragleave="handleDragLeave(event)" ondrop="handleDrop(event)">
        <div class="kanban-card" draggable="true" ondragstart="handleDragStart(event)" ondragend="handleDragEnd(event)">
          <span class="card-tag feature" contenteditable="true">Feature</span>
          <div class="card-title" contenteditable="true">Design Edge Database View</div>
          <div class="card-desc" contenteditable="true">Explore storing tabular JSON records inside custom malleable HTML tables.</div>
          <div class="card-actions" no-save>
            <button class="card-del-btn" onclick="deleteCard(this)" title="Delete Card">&times;</button>
          </div>
        </div>
        <div class="kanban-card" draggable="true" ondragstart="handleDragStart(event)" ondragend="handleDragEnd(event)">
          <span class="card-tag" contenteditable="true">Research</span>
          <div class="card-title" contenteditable="true">Evaluate ClayJS Reactive Lib</div>
          <div class="card-desc" contenteditable="true">Check if lightweight signals enhance inline reactivity without build steps.</div>
          <div class="card-actions" no-save>
            <button class="card-del-btn" onclick="deleteCard(this)" title="Delete Card">&times;</button>
          </div>
        </div>
      </div>
      <button class="add-card-btn" onclick="addCard('col-backlog')" no-save>+ Add Card</button>
    </div>

    <!-- Column 2 -->
    <div class="column" id="col-progress">
      <div class="col-header">
        <span class="col-title" contenteditable="true">⚡ In Progress</span>
        <span class="col-badge">1</span>
      </div>
      <div class="card-list" ondragover="handleDragOver(event)" ondragleave="handleDragLeave(event)" ondrop="handleDrop(event)">
        <div class="kanban-card" draggable="true" ondragstart="handleDragStart(event)" ondragend="handleDragEnd(event)">
          <span class="card-tag urgent" contenteditable="true">Urgent</span>
          <div class="card-title" contenteditable="true">Multi-Template Deployment</div>
          <div class="card-desc" contenteditable="true">Ship Writer, Kanban, DevLog, and Blank templates to Cloudgolem Edge.</div>
          <div class="card-actions" no-save>
            <button class="card-del-btn" onclick="deleteCard(this)" title="Delete Card">&times;</button>
          </div>
        </div>
      </div>
      <button class="add-card-btn" onclick="addCard('col-progress')" no-save>+ Add Card</button>
    </div>

    <!-- Column 3 -->
    <div class="column" id="col-done">
      <div class="col-header">
        <span class="col-title" contenteditable="true">✅ Completed</span>
        <span class="col-badge">1</span>
      </div>
      <div class="card-list" ondragover="handleDragOver(event)" ondragleave="handleDragLeave(event)" ondrop="handleDrop(event)">
        <div class="kanban-card" draggable="true" ondragstart="handleDragStart(event)" ondragend="handleDragEnd(event)">
          <span class="card-tag done" contenteditable="true">Done</span>
          <div class="card-title" contenteditable="true">Configure Cloudflare R2 & Access</div>
          <div class="card-desc" contenteditable="true">Bound cloudgolem-storage bucket to worker runtime.</div>
          <div class="card-actions" no-save>
            <button class="card-del-btn" onclick="deleteCard(this)" title="Delete Card">&times;</button>
          </div>
        </div>
      </div>
      <button class="add-card-btn" onclick="addCard('col-done')" no-save>+ Add Card</button>
    </div>
  </main>

  <script>
    let draggedElement = null;

    function handleDragStart(e) {
      draggedElement = e.currentTarget;
      draggedElement.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    }

    function handleDragEnd(e) {
      if (draggedElement) draggedElement.classList.remove('dragging');
      draggedElement = null;
      document.querySelectorAll('.card-list').forEach(l => l.classList.remove('drag-over'));
      updateColCounts();
    }

    function handleDragOver(e) {
      e.preventDefault();
      e.currentTarget.classList.add('drag-over');
    }

    function handleDragLeave(e) {
      e.currentTarget.classList.remove('drag-over');
    }

    function handleDrop(e) {
      e.preventDefault();
      const list = e.currentTarget;
      list.classList.remove('drag-over');
      if (draggedElement) {
        list.appendChild(draggedElement);
        updateColCounts();
        markDirty();
      }
    }

    function deleteCard(btn) {
      const card = btn.closest('.kanban-card');
      if (card) {
        card.remove();
        updateColCounts();
        markDirty();
      }
    }

    function addCard(colId) {
      const col = document.getElementById(colId);
      const list = col.querySelector('.card-list');
      const card = document.createElement('div');
      card.className = 'kanban-card';
      card.setAttribute('draggable', 'true');
      card.addEventListener('dragstart', handleDragStart);
      card.addEventListener('dragend', handleDragEnd);
      card.innerHTML = \`
        <span class="card-tag" contenteditable="true">Task</span>
        <div class="card-title" contenteditable="true">New Card Title</div>
        <div class="card-desc" contenteditable="true">Click to edit details...</div>
        <div class="card-actions" no-save>
          <button class="card-del-btn" onclick="deleteCard(this)" title="Delete Card">&times;</button>
        </div>
      \`;
      card.querySelectorAll('[contenteditable="true"]').forEach(el => el.addEventListener('input', markDirty));
      list.appendChild(card);
      card.querySelector('.card-title').focus();
      updateColCounts();
      markDirty();
    }

    function updateColCounts() {
      document.querySelectorAll('.column').forEach(col => {
        const badge = col.querySelector('.col-badge');
        const count = col.querySelectorAll('.kanban-card').length;
        if (badge) badge.textContent = count;
      });
    }

    // Bind existing cards on load
    document.querySelectorAll('.kanban-card').forEach(card => {
      card.addEventListener('dragstart', handleDragStart);
      card.addEventListener('dragend', handleDragEnd);
    });
    updateColCounts();

    ${getMalleableClientScript()}
  </script>
</body>
</html>`;
}

// -----------------------------------------------------------------
// Template 3: Developer Scratchpad & Engineering Log
// -----------------------------------------------------------------
function generateDevLogHtml(title) {
  const cleanTitle = title || 'Engineering Scratchpad';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${cleanTitle}</title>
  <style>
    :root {
      --bg: #0d1117;
      --card: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --muted: #8b949e;
      --accent: #58a6ff;
      --code-bg: #11151c;
      --success: #238636;
    }
    * { box-sizing: border-box; }
    body {
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
      background: var(--bg);
      color: var(--text);
      max-width: 900px;
      margin: 30px auto;
      padding: 0 20px;
      line-height: 1.6;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--border);
    }
    h1 { margin: 0; font-size: 24px; color: #fff; outline: none; }
    .save-badge {
      display: inline-flex;
      align-items: center;
      font-size: 12px;
      background: #21262d;
      padding: 5px 12px;
      border-radius: 16px;
      border: 1px solid var(--border);
      color: #3fb950;
    }
    button.save-btn {
      background: var(--success);
      color: #fff;
      border: none;
      padding: 6px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      font-family: inherit;
    }
    .action-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      gap: 12px;
    }
    .btn-action {
      background: #21262d;
      color: #fff;
      border: 1px solid var(--border);
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-family: inherit;
      font-size: 13px;
    }
    .btn-action:hover { background: #30363d; border-color: var(--accent); }
    .search-input {
      background: var(--card);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 8px 12px;
      border-radius: 6px;
      font-family: inherit;
      font-size: 13px;
      width: 250px;
    }
    .timeline {
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .log-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 18px 20px;
    }
    .log-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px dashed var(--border);
    }
    .log-meta { display: flex; gap: 10px; align-items: center; }
    .log-date { font-size: 12px; color: var(--muted); outline: none; }
    .log-tag {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 4px;
      background: rgba(88, 166, 255, 0.15);
      color: var(--accent);
      outline: none;
    }
    .log-del {
      background: none;
      border: none;
      color: #6e7681;
      cursor: pointer;
      font-size: 16px;
    }
    .log-del:hover { color: #f85149; }
    .log-title {
      font-size: 16px;
      font-weight: 600;
      color: #fff;
      margin-bottom: 8px;
      outline: none;
    }
    .log-body {
      font-size: 14px;
      color: var(--text);
      outline: none;
      margin-bottom: 12px;
      white-space: pre-wrap;
    }
    pre {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px 14px;
      overflow-x: auto;
      margin: 8px 0 0;
      position: relative;
    }
    code {
      font-family: inherit;
      font-size: 13px;
      color: #79c0ff;
      outline: none;
      display: block;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1 contenteditable="true">${cleanTitle}</h1>
      <p style="margin: 4px 0 0; color: #8b949e; font-size: 12px;">Architecture notes, snippets & timestamps &bull; Cloudgolem Edge</p>
    </div>
    <div style="display: flex; gap: 10px; align-items: center;" no-save>
      <a href="/_/hub" style="color: #8b949e; text-decoration: none; font-size: 12px; margin-right: 8px;">&larr; Hub</a>
      <span id="status" class="save-badge">Saved</span>
      <button class="save-btn" onclick="saveApp()">Save (Ctrl+S)</button>
    </div>
  </header>

  <div class="action-bar" no-save>
    <button class="btn-action" onclick="addLogEntry()">+ New Log Entry</button>
    <input type="text" class="search-input" placeholder="Filter logs..." oninput="filterLogs(this.value)">
  </div>

  <main class="timeline" id="logTimeline">
    <!-- Sample Log Entry 1 -->
    <div class="log-card">
      <div class="log-header">
        <div class="log-meta">
          <span class="log-date" contenteditable="true">2026-09-23 21:40</span>
          <span class="log-tag" contenteditable="true">[architecture]</span>
        </div>
        <button class="log-del" onclick="deleteLog(this)" title="Delete entry" no-save>&times;</button>
      </div>
      <div class="log-title" contenteditable="true">Malleable Specification v1 Implementation Details</div>
      <div class="log-body" contenteditable="true">Implemented strict Spec v1 compliance for Cloudflare Workers & R2:
- Conditional writes via ETag calculation (SHA-256 slice 16) and If-Match checking.
- Automated undo backups pushed to _versions/<app>/<timestamp>-<etag>.html.
- Exact byte preservation on all POST /_/save payloads.</div>
      <pre><code contenteditable="true">// Verify Worker syntax prior to production deploy
npx wrangler deploy
node -c src/worker/index.js</code></pre>
    </div>

    <!-- Sample Log Entry 2 -->
    <div class="log-card">
      <div class="log-header">
        <div class="log-meta">
          <span class="log-date" contenteditable="true">2026-09-23 18:15</span>
          <span class="log-tag" contenteditable="true">[cloudflare]</span>
        </div>
        <button class="log-del" onclick="deleteLog(this)" title="Delete entry" no-save>&times;</button>
      </div>
      <div class="log-title" contenteditable="true">Custom Domain Routing & R2 Bucket Binding</div>
      <div class="log-body" contenteditable="true">Cloudgolem is bound to the golem.akhensetukh.com custom domain and backed by the cloudgolem-storage R2 bucket. Zero Trust protects mutations.</div>
    </div>
  </main>

  <script>
    function addLogEntry() {
      const timeline = document.getElementById('logTimeline');
      const now = new Date();
      const dateStr = now.toISOString().replace('T', ' ').slice(0, 16);
      const card = document.createElement('div');
      card.className = 'log-card';
      card.innerHTML = \`
        <div class="log-header">
          <div class="log-meta">
            <span class="log-date" contenteditable="true">\${dateStr}</span>
            <span class="log-tag" contenteditable="true">[note]</span>
          </div>
          <button class="log-del" onclick="deleteLog(this)" title="Delete entry" no-save>&times;</button>
        </div>
        <div class="log-title" contenteditable="true">New Entry Title</div>
        <div class="log-body" contenteditable="true">Write log details or observations here...</div>
        <pre><code contenteditable="true">// code snippet or command</code></pre>
      \`;
      card.querySelectorAll('[contenteditable="true"]').forEach(el => el.addEventListener('input', markDirty));
      timeline.prepend(card);
      card.querySelector('.log-title').focus();
      markDirty();
    }

    function deleteLog(btn) {
      const card = btn.closest('.log-card');
      if (card) {
        card.remove();
        markDirty();
      }
    }

    function filterLogs(query) {
      const q = query.toLowerCase();
      document.querySelectorAll('.log-card').forEach(card => {
        const text = card.innerText.toLowerCase();
        card.style.display = text.includes(q) ? '' : 'none';
      });
    }

    ${getMalleableClientScript()}
  </script>
</body>
</html>`;
}

// -----------------------------------------------------------------
// Template 4: Interactive Project Checklist & Task Tracker
// -----------------------------------------------------------------
function generateTodoHtml(title) {
  const cleanTitle = title || 'Project Checklist';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${cleanTitle}</title>
  <style>
    :root {
      --bg: #0d1117;
      --card: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --accent: #58a6ff;
      --success: #238636;
    }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      max-width: 800px;
      margin: 40px auto;
      padding: 0 20px;
      line-height: 1.6;
    }
    header {
      border-bottom: 1px solid var(--border);
      padding-bottom: 20px;
      margin-bottom: 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    h1 { margin: 0; color: #fff; font-size: 28px; outline: none; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 24px;
      margin-bottom: 20px;
    }
    [contenteditable="true"] {
      outline: none;
      padding: 2px 4px;
      border-radius: 4px;
      transition: background 0.2s;
    }
    [contenteditable="true"]:focus {
      background: rgba(88, 166, 255, 0.1);
      box-shadow: 0 0 0 2px var(--accent);
    }
    .save-badge {
      display: inline-flex;
      align-items: center;
      font-size: 13px;
      background: #21262d;
      padding: 6px 12px;
      border-radius: 20px;
      border: 1px solid var(--border);
      color: #3fb950;
    }
    button.save-btn {
      background: var(--success);
      color: #fff;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
    }
    .progress-bar-container {
      background: #21262d;
      border-radius: 8px;
      height: 8px;
      overflow: hidden;
      margin-top: 12px;
      border: 1px solid var(--border);
    }
    .progress-bar-fill {
      background: var(--success);
      height: 100%;
      width: 0%;
      transition: width 0.3s ease;
    }
    .filter-tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }
    .tab-btn {
      background: #21262d;
      border: 1px solid var(--border);
      color: var(--text);
      padding: 4px 12px;
      border-radius: 14px;
      font-size: 12px;
      cursor: pointer;
    }
    .tab-btn.active {
      background: var(--accent);
      color: #0d1117;
      font-weight: 600;
      border-color: var(--accent);
    }
    ul { list-style: none; padding: 0; margin: 0; }
    li.todo-item {
      padding: 10px 14px;
      background: #21262d;
      border: 1px solid var(--border);
      border-radius: 6px;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    li.todo-item.completed span.task-text {
      text-decoration: line-through;
      color: #8b949e;
    }
    input[type="checkbox"] {
      width: 18px;
      height: 18px;
      accent-color: var(--accent);
      cursor: pointer;
    }
    .add-input-bar {
      display: flex;
      gap: 8px;
      margin-top: 16px;
    }
    .add-input {
      flex: 1;
      background: #0d1117;
      border: 1px solid var(--border);
      color: var(--text);
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 14px;
    }
    .btn-add {
      background: #238636;
      color: #fff;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
    }
    .del-btn {
      background: none;
      border: none;
      color: #6e7681;
      font-size: 16px;
      cursor: pointer;
    }
    .del-btn:hover { color: #f85149; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1 contenteditable="true">${cleanTitle}</h1>
      <p style="margin: 4px 0 0; color: #8b949e; font-size: 14px;">Interactive checklist stored directly in R2 &bull; Cloudgolem Edge</p>
    </div>
    <div style="display: flex; gap: 10px; align-items: center;" no-save>
      <a href="/_/hub" style="color: #8b949e; text-decoration: none; font-size: 13px; margin-right: 8px;">&larr; Hub</a>
      <span id="status" class="save-badge">Saved</span>
      <button class="save-btn" onclick="saveApp()">Save (Ctrl+S)</button>
    </div>
  </header>

  <main>
    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <h3 style="color: #fff; margin: 0;">Task Progress</h3>
        <span id="progressText" style="font-size: 13px; color: #8b949e;" no-save>0 of 0 completed</span>
      </div>
      <div class="progress-bar-container" no-save>
        <div class="progress-bar-fill" id="progressBar"></div>
      </div>
    </div>

    <div class="card">
      <div class="filter-tabs" no-save>
        <button class="tab-btn active" onclick="setFilter('all', this)">All</button>
        <button class="tab-btn" onclick="setFilter('active', this)">Active</button>
        <button class="tab-btn" onclick="setFilter('completed', this)">Completed</button>
      </div>

      <ul id="checklist">
        <li class="todo-item">
          <div style="display: flex; align-items: center; gap: 12px; flex: 1;">
            <input type="checkbox" onchange="toggleItem(this)">
            <span class="task-text" contenteditable="true">Define Cloudgolem architecture and R2 storage</span>
          </div>
          <button class="del-btn" onclick="deleteItem(this)" title="Delete task" no-save>&times;</button>
        </li>
        <li class="todo-item">
          <div style="display: flex; align-items: center; gap: 12px; flex: 1;">
            <input type="checkbox" onchange="toggleItem(this)">
            <span class="task-text" contenteditable="true">Test inline editing and Ctrl+S saving</span>
          </div>
          <button class="del-btn" onclick="deleteItem(this)" title="Delete task" no-save>&times;</button>
        </li>
        <li class="todo-item">
          <div style="display: flex; align-items: center; gap: 12px; flex: 1;">
            <input type="checkbox" onchange="toggleItem(this)">
            <span class="task-text" contenteditable="true">Deploy starter templates and custom file uploader</span>
          </div>
          <button class="del-btn" onclick="deleteItem(this)" title="Delete task" no-save>&times;</button>
        </li>
      </ul>

      <div class="add-input-bar" no-save>
        <input type="text" id="newTaskInput" class="add-input" placeholder="Add a new task..." onkeydown="if(event.key==='Enter') addTask()">
        <button class="btn-add" onclick="addTask()">Add Task</button>
      </div>
    </div>
  </main>

  <script>
    function updateProgress() {
      const items = document.querySelectorAll('#checklist li.todo-item');
      const checked = document.querySelectorAll('#checklist input[type="checkbox"]:checked');
      const total = items.length;
      const count = checked.length;
      const pct = total === 0 ? 0 : Math.round((count / total) * 100);

      const bar = document.getElementById('progressBar');
      const text = document.getElementById('progressText');
      if (bar) bar.style.width = pct + '%';
      if (text) text.textContent = \`\${count} of \${total} completed (\${pct}%)\`;
    }

    function toggleItem(cb) {
      const li = cb.closest('li.todo-item');
      if (cb.checked) {
        li.classList.add('completed');
        cb.setAttribute('checked', '');
      } else {
        li.classList.remove('completed');
        cb.removeAttribute('checked');
      }
      updateProgress();
      markDirty();
    }

    function deleteItem(btn) {
      const li = btn.closest('li.todo-item');
      if (li) {
        li.remove();
        updateProgress();
        markDirty();
      }
    }

    function addTask() {
      const inp = document.getElementById('newTaskInput');
      const text = inp.value.trim();
      if (!text) return;
      const ul = document.getElementById('checklist');
      const li = document.createElement('li');
      li.className = 'todo-item';
      li.innerHTML = \`
        <div style="display: flex; align-items: center; gap: 12px; flex: 1;">
          <input type="checkbox" onchange="toggleItem(this)">
          <span class="task-text" contenteditable="true">\${text}</span>
        </div>
        <button class="del-btn" onclick="deleteItem(this)" title="Delete task" no-save>&times;</button>
      \`;
      li.querySelector('.task-text').addEventListener('input', markDirty);
      ul.appendChild(li);
      inp.value = '';
      updateProgress();
      markDirty();
    }

    function setFilter(filter, btn) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('#checklist li.todo-item').forEach(li => {
        const isCompleted = li.classList.contains('completed');
        if (filter === 'all') li.style.display = '';
        else if (filter === 'active') li.style.display = isCompleted ? 'none' : '';
        else if (filter === 'completed') li.style.display = isCompleted ? '' : 'none';
      });
    }

    // Initialize checkboxes on load
    document.querySelectorAll('#checklist input[type="checkbox"]').forEach(cb => {
      if (cb.hasAttribute('checked')) {
        cb.checked = true;
        cb.closest('li.todo-item')?.classList.add('completed');
      }
    });
    updateProgress();

    ${getMalleableClientScript()}
  </script>
</body>
</html>`;
}

// -----------------------------------------------------------------
// Template 5: Blank Minimal Canvas
// -----------------------------------------------------------------
function generateBlankHtml(title) {
  const cleanTitle = title || 'Blank Canvas';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${cleanTitle}</title>
  <style>
    :root {
      --bg: #0d1117;
      --card: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --accent: #58a6ff;
      --success: #238636;
    }
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      max-width: 900px;
      margin: 40px auto;
      padding: 0 24px;
      line-height: 1.6;
    }
    header {
      border-bottom: 1px solid var(--border);
      padding-bottom: 16px;
      margin-bottom: 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    h1 { margin: 0; color: #fff; font-size: 26px; outline: none; }
    .save-badge {
      display: inline-flex;
      align-items: center;
      font-size: 13px;
      background: #21262d;
      padding: 6px 12px;
      border-radius: 20px;
      border: 1px solid var(--border);
      color: #3fb950;
    }
    button.save-btn {
      background: var(--success);
      color: #fff;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
    }
    .canvas-area {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 32px;
      min-height: 480px;
      outline: none;
    }
    .canvas-area:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent);
    }
    [contenteditable="true"]:empty:before {
      content: attr(data-placeholder);
      color: #6e7681;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1 contenteditable="true">${cleanTitle}</h1>
      <p style="margin: 4px 0 0; color: #8b949e; font-size: 13px;">Cloudgolem Malleable HTML Canvas</p>
    </div>
    <div style="display: flex; gap: 10px; align-items: center;" no-save>
      <a href="/_/hub" style="color: #8b949e; font-size: 13px; text-decoration: none; margin-right: 8px;">&larr; Hub</a>
      <span id="status" class="save-badge">Saved</span>
      <button class="save-btn" onclick="saveApp()">Save (Ctrl+S)</button>
    </div>
  </header>

  <main>
    <div class="canvas-area" contenteditable="true" data-placeholder="Start typing or pasting HTML here... Anything created here saves directly back to Cloudflare R2 on Ctrl+S."></div>
  </main>

  <script>
    ${getMalleableClientScript()}
  </script>
</body>
</html>`;
}

// Master template dispatcher
function generateTemplate(type, title) {
  switch (type) {
    case 'writer':
      return generateWriterHtml(title);
    case 'kanban':
      return generateKanbanHtml(title);
    case 'devlog':
      return generateDevLogHtml(title);
    case 'todo':
      return generateTodoHtml(title);
    case 'blank':
    default:
      return generateBlankHtml(title);
  }
}

// -----------------------------------------------------------------
// Built-in Hub / Launcher page
// -----------------------------------------------------------------
async function renderHubPage(env, origin) {
  let apps = [];
  try {
    const list = await env.STORAGE.list({ limit: 100 });
    apps = list.objects
      .filter(o => o.key.endsWith('.html') || o.key.endsWith('.htmlclay'))
      .filter(o => !o.key.startsWith('_versions/'));
  } catch {}

  const appsListHtml = apps.length === 0
    ? `<div style="text-align: center; padding: 40px 20px; color: #8b949e;">
        <div style="font-size: 32px; margin-bottom: 10px;">📦</div>
        <p style="margin: 0; font-size: 15px;">No malleable apps in this bucket yet.</p>
        <p style="margin: 6px 0 0; font-size: 13px;">Pick a starter template above or upload an existing HTML file to begin.</p>
      </div>`
    : `<ul style="list-style: none; padding: 0; margin: 0;">
        ${apps.map(a => `
          <li style="padding: 14px 18px; background: #21262d; border: 1px solid #30363d; border-radius: 8px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
            <div style="display: flex; align-items: center; gap: 12px;">
              <span style="font-size: 22px;">📄</span>
              <div>
                <a href="/${a.key}" style="color: #58a6ff; font-weight: 600; text-decoration: none; font-size: 16px;">${a.key}</a>
                <div style="font-size: 12px; color: #8b949e; margin-top: 3px;">
                  Size: ${(a.size / 1024).toFixed(1)} KB &bull; Updated: ${new Date(a.uploaded).toLocaleString()}
                </div>
              </div>
            </div>
            <div style="display: flex; gap: 8px; align-items: center;">
              <button onclick="cloneApp('${a.key}')" style="background: #30363d; color: #c9d1d9; border: 1px solid #484f58; padding: 6px 12px; border-radius: 6px; font-size: 13px; cursor: pointer;" title="Duplicate this app">📋 Clone</button>
              <button onclick="deleteApp('${a.key}')" style="background: #21262d; color: #f85149; border: 1px solid #30363d; padding: 6px 12px; border-radius: 6px; font-size: 13px; cursor: pointer;" title="Delete this app">🗑️ Delete</button>
              <a href="/${a.key}" style="background: #238636; color: #fff; padding: 6px 16px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 600;">Open &rarr;</a>
            </div>
          </li>
        `).join('')}
      </ul>`;

  const hubHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cloudgolem - Edge Malleable HTML Studio</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      max-width: 940px;
      margin: 40px auto;
      padding: 0 20px 60px;
      line-height: 1.6;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #30363d;
      padding-bottom: 24px;
      margin-bottom: 30px;
      flex-wrap: wrap;
      gap: 16px;
    }
    .logo-group {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .logo {
      width: 50px;
      height: 50px;
      background: linear-gradient(135deg, #1f6feb, #238636);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
      box-shadow: 0 4px 12px rgba(31, 111, 235, 0.25);
    }
    .badge-pill {
      font-size: 12px;
      padding: 4px 10px;
      background: #21262d;
      border: 1px solid #30363d;
      border-radius: 12px;
      color: #8b949e;
    }
    .card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 10px;
      padding: 24px;
      margin-bottom: 24px;
    }
    .card-title {
      color: #fff;
      margin-top: 0;
      margin-bottom: 6px;
      font-size: 20px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .card-desc {
      color: #8b949e;
      font-size: 14px;
      margin-top: 0;
      margin-bottom: 18px;
    }
    .template-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .template-card {
      background: #21262d;
      border: 2px solid #30363d;
      border-radius: 8px;
      padding: 14px;
      cursor: pointer;
      transition: all 0.2s;
      text-align: center;
    }
    .template-card:hover {
      border-color: #58a6ff;
      background: #262c36;
    }
    .template-card.selected {
      border-color: #58a6ff;
      background: rgba(88, 166, 255, 0.12);
    }
    .template-card .icon {
      font-size: 26px;
      margin-bottom: 6px;
    }
    .template-card .name {
      font-weight: 600;
      font-size: 14px;
      color: #fff;
      margin-bottom: 4px;
    }
    .template-card .desc {
      font-size: 11px;
      color: #8b949e;
      line-height: 1.3;
    }
    .create-form {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }
    input[type="text"] {
      background: #0d1117;
      border: 1px solid #30363d;
      color: #c9d1d9;
      padding: 10px 14px;
      border-radius: 6px;
      font-size: 14px;
      flex: 1;
      min-width: 240px;
    }
    input[type="text"]:focus {
      outline: none;
      border-color: #58a6ff;
      box-shadow: 0 0 0 2px rgba(88, 166, 255, 0.2);
    }
    button.btn-primary {
      background: #238636;
      color: #fff;
      border: none;
      padding: 10px 20px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      font-size: 14px;
      transition: opacity 0.2s;
    }
    button.btn-primary:hover { opacity: 0.9; }

    /* Drop Zone */
    .dropzone {
      border: 2px dashed #30363d;
      border-radius: 8px;
      padding: 24px;
      text-align: center;
      background: #0d1117;
      cursor: pointer;
      transition: all 0.2s;
    }
    .dropzone:hover, .dropzone.dragover {
      border-color: #58a6ff;
      background: rgba(88, 166, 255, 0.04);
    }
    .dropzone-icon {
      font-size: 30px;
      margin-bottom: 8px;
    }

    .info-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 14px;
      font-size: 13px;
    }
    .info-item {
      background: #21262d;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 12px;
    }
    .info-item b { color: #fff; display: block; margin-bottom: 4px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo-group">
      <div class="logo">&#9874;</div>
      <div>
        <h1 style="margin: 0; color: #fff; font-size: 26px;">Cloudgolem</h1>
        <p style="margin: 4px 0 0; color: #8b949e; font-size: 14px;">Malleable HTML Cloud Host & Application Studio on Cloudflare</p>
      </div>
    </div>
    <div style="display: flex; gap: 8px;">
      <span class="badge-pill">Spec v1 Draft</span>
      <span class="badge-pill">R2 Storage</span>
      <span class="badge-pill">golem.akhensetukh.com</span>
    </div>
  </div>

  <!-- Section 1: Template Launcher -->
  <div class="card">
    <h2 class="card-title"><span>✨</span> Create New Malleable Application</h2>
    <p class="card-desc">Choose a starter template or start with a blank malleable canvas. State is stored natively in the DOM on Cloudflare R2.</p>

    <div class="template-grid" id="templateGrid">
      <div class="template-card selected" onclick="selectTemplate('writer', 'notes.html', this)">
        <div class="icon">📝</div>
        <div class="name">Writer & Notes</div>
        <div class="desc">Distraction-free essay & notes with live word count</div>
      </div>

      <div class="template-card" onclick="selectTemplate('kanban', 'board.html', this)">
        <div class="icon">📋</div>
        <div class="name">Kanban Board</div>
        <div class="desc">Drag-and-drop cards across customizable columns</div>
      </div>

      <div class="template-card" onclick="selectTemplate('devlog', 'scratchpad.html', this)">
        <div class="icon">💻</div>
        <div class="name">DevLog & Snippets</div>
        <div class="desc">Timestamped engineering log with code blocks</div>
      </div>

      <div class="template-card" onclick="selectTemplate('todo', 'todo.html', this)">
        <div class="icon">✅</div>
        <div class="name">Project Checklist</div>
        <div class="desc">Task tracker with progress metrics & filters</div>
      </div>

      <div class="template-card" onclick="selectTemplate('blank', 'app.html', this)">
        <div class="icon">📄</div>
        <div class="name">Blank Canvas</div>
        <div class="desc">Minimal malleable starter wired with self-saving protocol</div>
      </div>
    </div>

    <form action="/_/apps/create" method="POST" class="create-form">
      <input type="hidden" name="template" id="selectedTemplate" value="writer">
      <input type="text" name="filename" id="filenameInput" value="notes.html" placeholder="e.g. notes.html, ideas.html" required pattern="^[a-zA-Z0-9_-]+\\.(html|htmlclay)$">
      <button type="submit" class="btn-primary">Create & Launch &rarr;</button>
    </form>
  </div>

  <!-- Section 2: Direct File Import / Uploader -->
  <div class="card">
    <h2 class="card-title"><span>📥</span> Import Existing Malleable App</h2>
    <p class="card-desc">Have a malleable HTML file or Clay app from Hyperclay or your local disk? Drop it here to store and run it at the edge.</p>

    <div class="dropzone" id="dropzone" onclick="document.getElementById('fileUploadInput').click()">
      <div class="dropzone-icon">☁️</div>
      <div style="font-weight: 600; color: #fff; margin-bottom: 4px;">Drag and drop an .html or .htmlclay file here</div>
      <div style="font-size: 13px; color: #8b949e;">or click to browse from your computer</div>
      <input type="file" id="fileUploadInput" accept=".html,.htmlclay" style="display: none;" onchange="handleFileUpload(this.files[0])">
    </div>
  </div>

  <!-- Section 3: Applications List -->
  <div class="card">
    <h2 class="card-title"><span>📂</span> Your Stored Applications</h2>
    ${appsListHtml}
  </div>

  <!-- Section 4: Specifications & Edge Info -->
  <div class="card" style="background: transparent; border-color: #21262d;">
    <h3 style="color: #c9d1d9; margin-top: 0; font-size: 15px; margin-bottom: 12px;">Architecture & Protocol Specifications</h3>
    <div class="info-grid">
      <div class="info-item">
        <b>Specification</b>
        <a href="https://malleablehtmlfile.com" target="_blank" style="color: #58a6ff; text-decoration: none;">Malleable HTML File Spec (v1)</a>
      </div>
      <div class="info-item">
        <b>Save Protocol</b>
        <code>POST /_/save</code> with <code>Document-URL</code>
      </div>
      <div class="info-item">
        <b>Storage Layer</b>
        Cloudflare R2 Bucket: <code>cloudgolem-storage</code>
      </div>
      <div class="info-item">
        <b>Concurrency Control</b>
        Conditional writes via ETags (SHA-256 slice 16)
      </div>
    </div>
  </div>

  <script>
    function selectTemplate(type, defaultFile, el) {
      document.querySelectorAll('.template-card').forEach(c => c.classList.remove('selected'));
      el.classList.add('selected');
      document.getElementById('selectedTemplate').value = type;
      const fnInput = document.getElementById('filenameInput');
      if (!fnInput.dataset.userEdited) {
        fnInput.value = defaultFile;
      }
    }

    document.getElementById('filenameInput').addEventListener('input', function() {
      this.dataset.userEdited = 'true';
    });

    // App actions: Clone & Delete
    async function cloneApp(filename) {
      const newName = prompt('Enter a name for the duplicated app:', filename.replace(/\\.(html|htmlclay)$/, '-copy.html'));
      if (!newName) return;
      try {
        const res = await fetch('/_/apps/clone', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: filename, target: newName })
        });
        if (res.ok) {
          window.location.reload();
        } else {
          const err = await res.json().catch(() => ({ msg: 'Clone failed' }));
          alert('Error cloning app: ' + (err.msg || 'Clone failed'));
        }
      } catch (e) {
        alert('Network error while cloning app');
      }
    }

    async function deleteApp(filename) {
      if (!confirm(\`Are you sure you want to delete '\${filename}'?\\nThis action cannot be undone.\`)) {
        return;
      }
      try {
        const res = await fetch('/_/apps/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename })
        });
        if (res.ok) {
          window.location.reload();
        } else {
          const err = await res.json().catch(() => ({ msg: 'Delete failed' }));
          alert('Error deleting app: ' + (err.msg || 'Delete failed'));
        }
      } catch (e) {
        alert('Network error while deleting app');
      }
    }

    // Drag and drop file uploader
    const dropzone = document.getElementById('dropzone');
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        handleFileUpload(e.dataTransfer.files[0]);
      }
    });

    async function handleFileUpload(file) {
      if (!file) return;
      if (!file.name.endsWith('.html') && !file.name.endsWith('.htmlclay')) {
        alert('Please upload a valid .html or .htmlclay file.');
        return;
      }
      const formData = new FormData();
      formData.append('file', file);
      dropzone.innerHTML = \`<div class="dropzone-icon">⏳</div><div style="color: #58a6ff; font-weight: 600;">Uploading \${file.name}...</div>\`;

      try {
        const res = await fetch('/_/apps/upload-file', {
          method: 'POST',
          body: formData
        });
        if (res.ok) {
          const json = await res.json();
          window.location.href = json.url || ('/' + file.name);
        } else {
          const err = await res.json().catch(() => ({ msg: 'Upload failed' }));
          alert('Upload failed: ' + (err.msg || 'Error'));
          window.location.reload();
        }
      } catch (e) {
        alert('Error uploading file');
        window.location.reload();
      }
    }
  </script>
</body>
</html>`;

  return new Response(hubHtml, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

// -----------------------------------------------------------------
// Cloudflare Worker Main Entrypoint
// -----------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Document-URL, Page-URL, If-Match, Authorization'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // -------------------------------------------------------------
    // Route 1: Hub / Dashboard (`GET /_/hub` or `GET /_/dashboard`)
    // -------------------------------------------------------------
    if (pathname === '/_/hub' || pathname === '/_/dashboard') {
      return renderHubPage(env, url.origin);
    }

    // -------------------------------------------------------------
    // Route 2: Hub Create App (`POST /_/apps/create`)
    // -------------------------------------------------------------
    if (request.method === 'POST' && pathname === '/_/apps/create') {
      if (!isAuthorized(request, env)) {
        return new Response('Unauthorized', { status: 401 });
      }
      let filename = 'app.html';
      let template = 'writer';
      const contentType = request.headers.get('content-type') || '';

      if (contentType.includes('application/x-www-form-urlencoded')) {
        const formData = await request.formData();
        filename = (formData.get('filename') || 'app.html').toString();
        template = (formData.get('template') || 'writer').toString();
      } else if (contentType.includes('application/json')) {
        const json = await request.json();
        filename = json.filename || 'app.html';
        template = json.template || 'writer';
      }

      if (!filename.endsWith('.html') && !filename.endsWith('.htmlclay')) {
        filename += '.html';
      }
      const cleanPath = resolveStoragePath(filename);
      if (!cleanPath) return new Response('Invalid filename', { status: 400 });

      // Generate HTML from selected template
      const title = cleanPath.replace(/\.(html|htmlclay)$/, '').replace(/[-_]/g, ' ');
      const content = generateTemplate(template, title);

      await env.STORAGE.put(cleanPath, content, {
        httpMetadata: { contentType: 'text/html; charset=utf-8' }
      });

      return Response.redirect(new URL('/' + cleanPath, url.origin).toString(), 303);
    }

    // -------------------------------------------------------------
    // Route 3: Hub Upload App File (`POST /_/apps/upload-file`)
    // -------------------------------------------------------------
    if (request.method === 'POST' && pathname === '/_/apps/upload-file') {
      if (!isAuthorized(request, env)) {
        return Response.json({ msg: 'Unauthorized' }, { status: 401, headers: corsHeaders });
      }

      const contentType = request.headers.get('content-type') || '';
      let filename = 'uploaded.html';
      let content = null;

      if (contentType.includes('multipart/form-data')) {
        const formData = await request.formData();
        const file = formData.get('file');
        if (!file || typeof file === 'string') {
          return Response.json({ msg: 'Missing file' }, { status: 400, headers: corsHeaders });
        }
        filename = file.name || 'uploaded.html';
        content = await file.text();
      } else {
        filename = request.headers.get('X-File-Name') || 'uploaded.html';
        content = await request.text();
      }

      const cleanPath = resolveStoragePath(filename);
      if (!cleanPath || (!cleanPath.endsWith('.html') && !cleanPath.endsWith('.htmlclay'))) {
        return Response.json({ msg: 'Invalid HTML filename' }, { status: 400, headers: corsHeaders });
      }

      await env.STORAGE.put(cleanPath, content, {
        httpMetadata: { contentType: 'text/html; charset=utf-8' }
      });

      return Response.json({
        msg: 'Uploaded successfully',
        url: '/' + cleanPath
      }, { headers: corsHeaders });
    }

    // -------------------------------------------------------------
    // Route 4: Hub Clone App (`POST /_/apps/clone`)
    // -------------------------------------------------------------
    if (request.method === 'POST' && pathname === '/_/apps/clone') {
      if (!isAuthorized(request, env)) {
        return Response.json({ msg: 'Unauthorized' }, { status: 401, headers: corsHeaders });
      }

      let source = '';
      let target = '';
      const contentType = request.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const json = await request.json();
        source = json.source;
        target = json.target;
      } else {
        const formData = await request.formData();
        source = formData.get('source');
        target = formData.get('target');
      }

      const cleanSource = resolveStoragePath(source);
      const cleanTarget = resolveStoragePath(target);
      if (!cleanSource || !cleanTarget) {
        return Response.json({ msg: 'Invalid source or target filename' }, { status: 400, headers: corsHeaders });
      }

      const obj = await env.STORAGE.get(cleanSource);
      if (!obj) {
        return Response.json({ msg: 'Source file not found' }, { status: 404, headers: corsHeaders });
      }

      const body = await obj.text();
      await env.STORAGE.put(cleanTarget, body, {
        httpMetadata: { contentType: 'text/html; charset=utf-8' }
      });

      return Response.json({ msg: 'Cloned successfully', url: '/' + cleanTarget }, { headers: corsHeaders });
    }

    // -------------------------------------------------------------
    // Route 5: Hub Delete App (`POST /_/apps/delete`)
    // -------------------------------------------------------------
    if (request.method === 'POST' && pathname === '/_/apps/delete') {
      if (!isAuthorized(request, env)) {
        return Response.json({ msg: 'Unauthorized' }, { status: 401, headers: corsHeaders });
      }

      let filename = '';
      const contentType = request.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const json = await request.json();
        filename = json.filename;
      } else {
        const formData = await request.formData();
        filename = formData.get('filename');
      }

      const cleanPath = resolveStoragePath(filename);
      if (!cleanPath) {
        return Response.json({ msg: 'Invalid filename' }, { status: 400, headers: corsHeaders });
      }

      await env.STORAGE.delete(cleanPath);
      return Response.json({ msg: 'Deleted successfully' }, { headers: corsHeaders });
    }

    // -------------------------------------------------------------
    // Route 6: Spec §5 Capability Discovery (`GET /_/meta`)
    // -------------------------------------------------------------
    if (request.method === 'GET' && pathname === '/_/meta') {
      const docHeader = request.headers.get('Document-URL') || request.headers.get('Page-URL');
      const meta = {
        spec: 1,
        extensions: ['conditional', 'upload']
      };

      if (docHeader) {
        try {
          const docPath = new URL(docHeader).pathname;
          const target = resolveStoragePath(docPath);
          if (target) {
            const obj = await env.STORAGE.get(target);
            if (obj) {
              const body = await obj.text();
              meta.document = { etag: await computeEtag(body) };
            }
          }
        } catch {}
      }

      return Response.json(meta, { headers: corsHeaders });
    }

    // -------------------------------------------------------------
    // Route 7: Spec §3 & §4 Malleable Save (`POST /_/save`)
    // -------------------------------------------------------------
    if (request.method === 'POST' && pathname === '/_/save') {
      if (!isAuthorized(request, env)) {
        return Response.json({ msg: 'Unauthorized', code: 'forbidden' }, { status: 403, headers: corsHeaders });
      }

      const docHeader = request.headers.get('Document-URL') || request.headers.get('Page-URL');
      if (!docHeader) {
        return Response.json({ msg: 'Missing Document-URL header', code: 'bad-request' }, { status: 400, headers: corsHeaders });
      }

      let targetPath;
      try {
        targetPath = resolveStoragePath(new URL(docHeader).pathname);
      } catch {
        return Response.json({ msg: 'Invalid Document-URL', code: 'bad-request' }, { status: 400, headers: corsHeaders });
      }

      if (!targetPath) {
        return Response.json({ msg: 'Path escapes root', code: 'forbidden' }, { status: 403, headers: corsHeaders });
      }

      const bodyText = await request.text();

      // Enforce doctype check
      if (!/^\s*<!doctype html>/i.test(bodyText) || !bodyText.includes('<html')) {
        return Response.json({ msg: 'Not a complete HTML document', code: 'invalid-document' }, { status: 422, headers: corsHeaders });
      }

      // Spec §6: Check conditional If-Match if present
      const ifMatch = request.headers.get('If-Match');
      const existing = await env.STORAGE.get(targetPath);
      let existingContent = null;

      if (existing) {
        existingContent = await existing.text();
        const currentEtag = await computeEtag(existingContent);

        if (ifMatch && !isIfMatchSatisfied(ifMatch, currentEtag, existingContent.length)) {
          return Response.json({ msg: 'Conflict: document changed', code: 'conflict' }, { status: 412, headers: corsHeaders });
        }

        // Backup existing version for undo / version history
        const timestamp = Date.now();
        const versionKey = `_versions/${targetPath}/${timestamp}-${currentEtag}.html`;
        ctx.waitUntil(env.STORAGE.put(versionKey, existingContent, {
          httpMetadata: { contentType: 'text/html; charset=utf-8' }
        }));
      }

      // Store updated document in R2
      const newEtag = await computeEtag(bodyText);
      await env.STORAGE.put(targetPath, bodyText, {
        httpMetadata: { contentType: 'text/html; charset=utf-8' },
        customMetadata: { etag: newEtag, updated: new Date().toISOString() }
      });

      return Response.json({ msg: 'Saved', etag: newEtag }, {
        status: 200,
        headers: {
          ...corsHeaders,
          'ETag': `"${newEtag}"`
        }
      });
    }

    // -------------------------------------------------------------
    // Route 8: Spec §9 Asset Uploads (`POST /_/upload`)
    // -------------------------------------------------------------
    if (request.method === 'POST' && pathname === '/_/upload') {
      if (!isAuthorized(request, env)) {
        return Response.json({ msg: 'Unauthorized', code: 'forbidden' }, { status: 403, headers: corsHeaders });
      }

      const docHeader = request.headers.get('Document-URL') || request.headers.get('Page-URL');
      const docPath = docHeader ? new URL(docHeader).pathname : '/app.html';
      const docClean = resolveStoragePath(docPath) || 'index.html';
      const docStem = docClean.replace(/\.(html?|htmlclay)$/i, '');
      const assetDir = `assets-${docStem}`;

      const contentType = request.headers.get('content-type') || '';
      let filename = 'file';
      let fileBuffer = null;

      if (contentType.includes('multipart/form-data')) {
        const formData = await request.formData();
        const file = formData.get('file');
        if (!file || typeof file === 'string') {
          return Response.json({ msg: 'Missing file in form data', code: 'bad-request' }, { status: 400 });
        }
        filename = file.name || 'upload';
        fileBuffer = await file.arrayBuffer();
      } else {
        fileBuffer = await request.arrayBuffer();
        filename = request.headers.get('X-File-Name') || 'upload.bin';
      }

      // Safe filename
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const ext = safeName.includes('.') ? safeName.slice(safeName.lastIndexOf('.')) : '';
      const base = safeName.replace(ext, '');
      const hash = (await computeEtag(fileBuffer)).slice(0, 8);
      const storedFileName = `${base}-${hash}${ext}`;
      const assetKey = `${assetDir}/${storedFileName}`;

      const mime = getMimeType(storedFileName);
      await env.STORAGE.put(assetKey, fileBuffer, {
        httpMetadata: { contentType: mime }
      });

      return Response.json({
        name: storedFileName,
        url: `/${assetKey}`,
        bytes: fileBuffer.byteLength
      }, { headers: corsHeaders });
    }

    // -------------------------------------------------------------
    // Route 9: Static Document & Asset Serving (`GET /*`)
    // -------------------------------------------------------------
    if (request.method === 'GET') {
      const targetPath = resolveStoragePath(pathname);

      if (!targetPath) {
        return new Response('Not Found', { status: 404 });
      }

      // If root '/' requested, try index.html, else fall back to Hub
      if (pathname === '/' || pathname === '') {
        const indexObj = await env.STORAGE.get('index.html');
        if (indexObj) {
          const body = await indexObj.text();
          const etag = await computeEtag(body);
          return new Response(body, {
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'ETag': `"${etag}"`,
              'Cache-Control': 'no-cache',
              ...corsHeaders
            }
          });
        }
        // No index.html yet; show the Cloudgolem Hub launcher
        return renderHubPage(env, url.origin);
      }

      const obj = await env.STORAGE.get(targetPath);
      if (!obj) {
        return new Response(`Document '${targetPath}' not found`, { status: 404 });
      }

      const isHtml = targetPath.endsWith('.html') || targetPath.endsWith('.htmlclay');
      const mime = getMimeType(targetPath);
      const headers = new Headers({
        'Content-Type': mime,
        'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=86400',
        ...corsHeaders
      });

      if (obj.httpEtag) headers.set('ETag', obj.httpEtag);

      return new Response(obj.body, { headers });
    }

    return new Response('Method Not Allowed', { status: 405 });
  }
};
