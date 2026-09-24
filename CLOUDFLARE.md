# Cloudgolem: Malleable HTML Cloud Host

**Cloudgolem** is an edge-native host for malleable HTML applications, deployed directly on Cloudflare's serverless infrastructure.

It implements the [Malleable HTML File Specification](https://malleablehtmlfile.com) and is backed by **Cloudflare R2** object storage, allowing you to create, run, and self-update malleable HTML applications anywhere in the world on Cloudflare's 100% free tier.

---

## Architecture

```
                                  +---------------------------------------+
                                  |    Browser (Malleable HTML App)       |
                                  +---------------------------------------+
                                       |                             ^
       GET /my-app.html                |                             |
       POST /_/save (Ctrl+S)           |                             | HTML & Assets
       POST /_/upload                  v                             |
                                  +---------------------------------------+
                                  |      Cloudflare Zero Trust Access     | (Optional / Recommended)
                                  +---------------------------------------+
                                       |
                                       v
                        +------------------------------+
                        |  Cloudgolem Cloudflare Worker |
                        |  (golem.akhensetukh.com)     |
                        +------------------------------+
                                       |
                        +--------------+---------------+
                        |                              |
                        v                              v
           +--------------------------+  +--------------------------+
           | R2: cloudgolem-storage   |  | R2: _versions/           |
           | (Active documents/assets)|  | (Automated undo history) |
           +--------------------------+  +--------------------------+
```

---

## Features

- **Zero Server Maintenance**: Runs 100% serverless on Cloudflare Workers and R2.
- **Spec Compliant**: Implements:
  - Spec §3: Save endpoint (`POST /_/save`) with `Document-URL` routing.
  - Spec §4: Exact-byte static document and asset serving (`GET /*`).
  - Spec §5: Capability discovery (`GET /_/meta`).
  - Spec §6: Conditional saves with `ETag` and `If-Match` conflict prevention.
  - Spec §9: Multipart asset uploads (`POST /_/upload`).
- **Data Protection & Version History**: Every save automatically archives a backup copy of the previous document into `_versions/<app>/<timestamp>-<etag>.html` before applying writes.
- **Built-in Cloudgolem Hub**: When you open the root URL, if no `index.html` exists, an interactive launcher page is served to let you create and launch new malleable HTML applications instantly.
- **Multi-Template Starter Library**: The built-in Hub allows you to launch diverse malleable apps with one click:
  - 📝 **Writer & Notes**: Distraction-free rich text editor with live word count, typography controls, and notes formatting.
  - 📋 **Kanban Board**: Drag-and-drop cards across customizable columns with tags and inline editing.
  - 💻 **DevLog & Scratchpad**: Timestamped engineering logs, code snippets with copy actions, and quick search.
  - ✅ **Project Checklist**: Task manager with real-time completion progress bar and filter tabs.
  - 📄 **Blank Canvas**: Minimal malleable starter wired with self-saving protocol, ready for arbitrary HTML/CSS/JS.
- **Direct File Import (Drag & Drop)**: Drop any existing `.html` or `.htmlclay` file (from Hyperclay, local projects, or templates) into the Hub to upload and host it instantly in R2.
- **App Management**: Clone / duplicate existing applications and delete unused apps directly from the Hub.
- **Zero Trust Ready**: Compatible with Cloudflare Access (Zero Trust) headers, with optional pre-shared key fallback (`AUTH_KEY`).

---

## Deploying to Cloudflare

### Prerequisites
- Node.js >= 20
- Cloudflare account with R2 enabled
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

### 1. R2 Bucket
Ensure your R2 bucket `cloudgolem-storage` exists (or create it):
```bash
npx wrangler r2 bucket create cloudgolem-storage
```

### 2. Deploy the Worker
Deploy the worker to your Cloudflare account:
```bash
npm run cf:deploy
```
This deploys the worker defined in `wrangler.jsonc` and configures the custom domain route for `golem.akhensetukh.com`.

### 3. (Recommended) Protect with Cloudflare Zero Trust (Access)
Because malleable HTML applications allow persistent writes via `POST /_/save`, you should protect your endpoint:

1. In the **Cloudflare Dashboard**, navigate to **Zero Trust** &rarr; **Access** &rarr; **Applications**.
2. Click **Add an Application** &rarr; **Self-hosted**.
3. Set the Application Domain to `golem.akhensetukh.com`.
4. Configure an Access Policy:
   - **Action**: Allow
   - **Rule**: Include &rarr; Emails &rarr; your email address (e.g. `akhensetukh@proton.me`).
5. Save the policy.

Now, whenever you visit `https://golem.akhensetukh.com/` in your browser, Cloudflare will prompt for a one-time code or login. Once authenticated, your malleable HTML apps will save automatically via `Ctrl+S` with zero token or password prompts!

### Optional: Pre-Shared Key Fallback
If you wish to protect write endpoints without Cloudflare Access, set a secret in your Worker:
```bash
npx wrangler secret put AUTH_KEY
```
When set, mutating requests (`POST /_/save`, `POST /_/upload`) will require an `Authorization: Bearer <AUTH_KEY>` header or `?key=<AUTH_KEY>` query parameter.

---

## Using Your Malleable Apps

1. Navigate to `https://golem.akhensetukh.com/`
2. If `index.html` is not yet set, the **Cloudgolem Hub** opens.
3. Select any starter template (Writer, Kanban, DevLog, Checklist, Blank Canvas) or drop an existing `.html` file into the upload zone.
4. Edit freely! Press `Ctrl+S` or `Cmd+S` anytime to save your changes back to Cloudflare R2.
