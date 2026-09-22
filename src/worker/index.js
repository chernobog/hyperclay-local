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
 * - Built-in Cloudgolem Hub launcher when root index.html is absent
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

// Starter malleable HTML document generator
function generateStarterHtml(title) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title || 'My Malleable App'}</title>
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
    h1 { margin: 0; color: #fff; font-size: 28px; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 24px;
      margin-bottom: 20px;
    }
    [contenteditable="true"] {
      outline: none;
      padding: 4px;
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
      gap: 6px;
      font-size: 13px;
      background: #21262d;
      padding: 6px 12px;
      border-radius: 20px;
      border: 1px solid var(--border);
    }
    button.save-btn {
      background: var(--success);
      color: #fff;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      transition: opacity 0.2s;
    }
    button.save-btn:hover { opacity: 0.9; }
    ul { list-style: none; padding: 0; }
    li {
      padding: 10px 14px;
      background: #21262d;
      border: 1px solid var(--border);
      border-radius: 6px;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    input[type="checkbox"] {
      width: 18px;
      height: 18px;
      accent-color: var(--accent);
      cursor: pointer;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1 contenteditable="true">${title || 'Malleable Document'}</h1>
      <p style="margin: 4px 0 0; color: #8b949e; font-size: 14px;">Powered by Cloudgolem on Cloudflare Edge</p>
    </div>
    <div style="display: flex; gap: 10px; align-items: center;">
      <span id="status" class="save-badge" no-save>Saved</span>
      <button class="save-btn" onclick="saveApp()" no-save>Save (Ctrl+S)</button>
    </div>
  </header>

  <main>
    <div class="card">
      <h3 style="color: #fff; margin-top: 0;">Interactive Content</h3>
      <p contenteditable="true">
        This document is a malleable HTML file. Click anywhere inside this paragraph or header to edit text directly.
        When you press Save or hit <kbd>Ctrl+S</kbd> / <kbd>Cmd+S</kbd>, the page automatically writes its modified DOM back to Cloudgolem on Cloudflare R2!
      </p>
    </div>

    <div class="card">
      <h3 style="color: #fff; margin-top: 0;">Live Checklist</h3>
      <ul id="checklist">
        <li><input type="checkbox" onchange="markDirty()"> <span contenteditable="true">Create first malleable document</span></li>
        <li><input type="checkbox" onchange="markDirty()"> <span contenteditable="true">Edit inline and save via Ctrl+S</span></li>
        <li><input type="checkbox" onchange="markDirty()"> <span contenteditable="true">Explore Cloudgolem dashboard</span></li>
      </ul>
      <button onclick="addCheckItem()" style="background:#30363d; color:#fff; border:none; padding:6px 12px; border-radius:4px; cursor:pointer;" no-save>+ Add Item</button>
    </div>
  </main>

  <script>
    let isDirty = false;
    function markDirty() {
      isDirty = true;
      const st = document.getElementById('status');
      if (st) { st.textContent = 'Unsaved changes'; st.style.color = '#e3b341'; }
    }

    document.querySelectorAll('[contenteditable="true"]').forEach(el => {
      el.addEventListener('input', markDirty);
    });

    function addCheckItem() {
      const ul = document.getElementById('checklist');
      const li = document.createElement('li');
      li.innerHTML = '<input type="checkbox" onchange="markDirty()"> <span contenteditable="true">New task</span>';
      ul.appendChild(li);
      li.querySelector('span').focus();
      markDirty();
    }

    async function saveApp() {
      const st = document.getElementById('status');
      if (st) { st.textContent = 'Saving...'; st.style.color = '#58a6ff'; }

      // Synchronize form values to DOM attributes before saving
      document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        if (cb.checked) cb.setAttribute('checked', '');
        else cb.removeAttribute('checked');
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
          if (st) { st.textContent = 'Saved'; st.style.color = '#3fb950'; }
        } else {
          const err = await res.json().catch(() => ({ msg: 'Save failed' }));
          if (st) { st.textContent = 'Error: ' + (err.msg || 'Save failed'); st.style.color = '#f85149'; }
        }
      } catch (e) {
        if (st) { st.textContent = 'Connection error'; st.style.color = '#f85149'; }
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
  </script>
</body>
</html>`;
}

// Built-in Hub / Launcher page
async function renderHubPage(env, origin) {
  let apps = [];
  try {
    const list = await env.STORAGE.list({ limit: 100 });
    apps = list.objects
      .filter(o => o.key.endsWith('.html') || o.key.endsWith('.htmlclay'))
      .filter(o => !o.key.startsWith('_versions/'));
  } catch {}

  const appsListHtml = apps.length === 0
    ? `<p style="color: #8b949e;">No malleable HTML apps found yet in this bucket.</p>`
    : `<ul style="list-style: none; padding: 0;">
        ${apps.map(a => `
          <li style="padding: 12px 16px; background: #21262d; border: 1px solid #30363d; border-radius: 6px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;">
            <div>
              <a href="/${a.key}" style="color: #58a6ff; font-weight: 600; text-decoration: none; font-size: 16px;">${a.key}</a>
              <div style="font-size: 12px; color: #8b949e; margin-top: 2px;">
                Size: ${(a.size / 1024).toFixed(1)} KB &bull; Updated: ${new Date(a.uploaded).toLocaleString()}
              </div>
            </div>
            <a href="/${a.key}" style="background: #238636; color: #fff; padding: 6px 14px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 600;">Open &rarr;</a>
          </li>
        `).join('')}
      </ul>`;

  const hubHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cloudgolem - Edge Malleable HTML Host</title>
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      max-width: 840px;
      margin: 40px auto;
      padding: 0 20px;
      line-height: 1.6;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 16px;
      border-bottom: 1px solid #30363d;
      padding-bottom: 24px;
      margin-bottom: 30px;
    }
    .logo {
      width: 48px;
      height: 48px;
      background: linear-gradient(135deg, #1f6feb, #238636);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 26px;
    }
    .card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 24px;
      margin-bottom: 24px;
    }
    input[type="text"] {
      background: #0d1117;
      border: 1px solid #30363d;
      color: #c9d1d9;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 14px;
      width: 250px;
    }
    button {
      background: #238636;
      color: #fff;
      border: none;
      padding: 8px 18px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
    }
    button:hover { opacity: 0.9; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">&#9874;</div>
    <div>
      <h1 style="margin: 0; color: #fff; font-size: 28px;">Cloudgolem</h1>
      <p style="margin: 4px 0 0; color: #8b949e;">Malleable HTML Cloud Host on Cloudflare Workers & R2</p>
    </div>
  </div>

  <div class="card">
    <h2 style="color: #fff; margin-top: 0; font-size: 20px;">Create New Malleable App</h2>
    <p style="color: #8b949e; font-size: 14px;">Instant self-saving HTML application created directly in your R2 bucket.</p>
    <form action="/_/apps/create" method="POST" style="display: flex; gap: 10px; align-items: center; margin-top: 15px;">
      <input type="text" name="filename" placeholder="e.g. notes.html, todo.html" required pattern="^[a-zA-Z0-9_-]+\\.html$">
      <button type="submit">Create App</button>
    </form>
  </div>

  <div class="card">
    <h2 style="color: #fff; margin-top: 0; font-size: 20px;">Your Applications</h2>
    ${appsListHtml}
  </div>

  <div class="card" style="font-size: 13px; color: #8b949e;">
    <h3 style="color: #c9d1d9; margin-top: 0;">Malleable HTML Protocol Info</h3>
    <p>This host implements the open <a href="https://malleablehtmlfile.com" target="_blank" style="color: #58a6ff;">Malleable HTML Specification</a>.</p>
    <p>&bull; Discovery: <code>GET /_/meta</code></p>
    <p>&bull; Save: <code>POST /_/save</code> with <code>Document-URL</code> header</p>
    <p>&bull; Uploads: <code>POST /_/upload</code> to asset subfolders</p>
    <p>&bull; Storage: Cloudflare R2 bucket <code>cloudgolem-storage</code></p>
  </div>
</body>
</html>`;

  return new Response(hubHtml, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Optional CORS headers for cross-origin tooling if needed
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Document-URL, Page-URL, If-Match, Authorization'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // -------------------------------------------------------------
    // Route 1: Hub / Dashboard
    // -------------------------------------------------------------
    if (pathname === '/_/hub' || pathname === '/_/dashboard') {
      return renderHubPage(env, url.origin);
    }

    // -------------------------------------------------------------
    // Route 2: Hub Create App
    // -------------------------------------------------------------
    if (request.method === 'POST' && pathname === '/_/apps/create') {
      if (!isAuthorized(request, env)) {
        return new Response('Unauthorized', { status: 401 });
      }
      let filename = 'app.html';
      const contentType = request.headers.get('content-type') || '';
      if (contentType.includes('application/x-www-form-urlencoded')) {
        const formData = await request.formData();
        filename = (formData.get('filename') || 'app.html').toString();
      } else if (contentType.includes('application/json')) {
        const json = await request.json();
        filename = json.filename || 'app.html';
      }

      if (!filename.endsWith('.html')) filename += '.html';
      const cleanPath = resolveStoragePath(filename);
      if (!cleanPath) return new Response('Invalid filename', { status: 400 });

      // Generate starter HTML
      const title = cleanPath.replace('.html', '').replace(/[-_]/g, ' ');
      const starter = generateStarterHtml(title);

      await env.STORAGE.put(cleanPath, starter, {
        httpMetadata: { contentType: 'text/html; charset=utf-8' }
      });

      return Response.redirect(new URL('/' + cleanPath, url.origin).toString(), 303);
    }

    // -------------------------------------------------------------
    // Route 3: Spec §5 Capability Discovery (`GET /_/meta`)
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
    // Route 4: Spec §3 & §4 Malleable Save (`POST /_/save`)
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

        // Backup existing version for undo / anti-data-loss
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
    // Route 5: Spec §9 Asset Uploads (`POST /_/upload`)
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
    // Route 6: Static File Serving (`GET /*`)
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