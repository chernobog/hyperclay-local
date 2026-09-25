// Automated Conformance Verification for Malleable HTML File Specification (Spec v1)
// Simulates Worker fetch against an in-memory R2 storage mock

import worker from '../src/worker/index.js';
import assert from 'node:assert/strict';

// Mock R2 Storage
class MemoryR2 {
  constructor() {
    this.store = new Map();
  }
  async get(key) {
    if (!this.store.has(key)) return null;
    const item = this.store.get(key);
    return {
      text: async () => item.body,
      arrayBuffer: async () => item.buffer || new TextEncoder().encode(item.body).buffer,
      customMetadata: item.customMetadata || {},
      httpMetadata: item.httpMetadata || {},
      httpEtag: `"${item.customMetadata?.etag || 'dummy'}"`
    };
  }
  async put(key, body, options = {}) {
    const isBuffer = body instanceof ArrayBuffer || ArrayBuffer.isView(body);
    const bodyText = isBuffer ? '' : String(body);
    const buffer = isBuffer ? (body.buffer || body) : new TextEncoder().encode(bodyText).buffer;
    this.store.set(key, {
      body: bodyText,
      buffer,
      customMetadata: options.customMetadata || {},
      httpMetadata: options.httpMetadata || {}
    });
  }
  async delete(key) {
    this.store.delete(key);
  }
  async list() {
    const objects = [];
    for (const [key, val] of this.store.entries()) {
      objects.push({ key, size: val.body.length || val.buffer.byteLength, uploaded: new Date() });
    }
    return { objects };
  }
}

async function runTests() {
  console.log('--- Starting MHF Spec Automated Verification ---');
  const env = { STORAGE: new MemoryR2() };
  const ctx = { waitUntil: (p) => p };
  const origin = 'https://golem.akhensetukh.com';

  // Test 1: GET /_/meta without Document-URL
  {
    const req = new Request(`${origin}/_/meta`, { method: 'GET' });
    const res = await worker.fetch(req, env, ctx);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.spec, 1);
    assert.deepEqual(json.extensions, ['conditional', 'receipts', 'upload']);
    assert.equal(json.document, undefined, 'document block should be omitted when Document-URL absent');
    console.log('✓ Test 1 Passed: GET /_/meta basic discovery & anti-probe omission');
  }

  // Test 2: GET /_/meta with non-existent Document-URL
  {
    const req = new Request(`${origin}/_/meta`, {
      method: 'GET',
      headers: { 'Document-URL': `${origin}/nonexistent.html` }
    });
    const res = await worker.fetch(req, env, ctx);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.document, undefined, 'document block must be withheld by omission for non-existent document');
    console.log('✓ Test 2 Passed: GET /_/meta omission for non-existent document');
  }

  // Test 3: Save round-trip with Save-ID & Save-Trigger
  const testDoc = '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>Test</title></head><body><h1>Hello</h1></body></html>';
  let initialEtag = '';
  {
    const req = new Request(`${origin}/_/save`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Document-URL': `${origin}/app.html`,
        'Save-ID': 'test-save-id-12345',
        'Save-Trigger': 'user',
        'Origin': origin
      },
      body: testDoc
    });
    const res = await worker.fetch(req, env, ctx);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.msg, 'Saved');
    assert.ok(json.etag);
    assert.equal(json.saveId, 'test-save-id-12345', 'Accepted save echoes saveId');
    initialEtag = json.etag;
    console.log('✓ Test 3 Passed: POST /_/save round-trip with Save-ID receipt');
  }

  // Test 4: GET /_/meta with existing Document-URL
  {
    const req = new Request(`${origin}/_/meta`, {
      method: 'GET',
      headers: { 'Document-URL': `${origin}/app.html` }
    });
    const res = await worker.fetch(req, env, ctx);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(json.document, 'document block should be present');
    assert.equal(json.document.etag, initialEtag);
    assert.equal(json.document.saveId, 'test-save-id-12345');
    assert.equal(json.document.writable, true);
    assert.equal(json.document.upload.allowed, true);
    assert.equal(json.document.upload.maxBytes, 52428800);
    console.log('✓ Test 4 Passed: GET /_/meta document block reflects etag, saveId, and upload capabilities');
  }

  // Test 5: Conditional 412 Conflict on Stale If-Match
  {
    const req = new Request(`${origin}/_/save`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Document-URL': `${origin}/app.html`,
        'If-Match': 'stale-etag-value',
        'Save-ID': 'conflict-probe-id',
        'Origin': origin
      },
      body: testDoc.replace('Hello', 'Modified')
    });
    const res = await worker.fetch(req, env, ctx);
    assert.equal(res.status, 412);
    const json = await res.json();
    assert.equal(json.code, 'conflict');
    assert.equal(json.etag, initialEtag, '412 response carries existing etag');
    assert.equal(json.saveId, 'test-save-id-12345', '412 response carries saveId of existing version');
    console.log('✓ Test 5 Passed: 412 Conflict returns code, etag, and causing saveId');
  }

  // Test 6: Cross-origin save rejection
  {
    const req = new Request(`${origin}/_/save`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Document-URL': `${origin}/app.html`,
        'Origin': 'https://malicious-origin.com'
      },
      body: testDoc
    });
    const res = await worker.fetch(req, env, ctx);
    assert.equal(res.status, 403);
    const json = await res.json();
    assert.equal(json.code, 'forbidden');
    console.log('✓ Test 6 Passed: Cross-origin save refused with 403 forbidden');
  }

  // Test 7: Non-HTML body refused
  {
    const req = new Request(`${origin}/_/save`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Document-URL': `${origin}/app.html`,
        'Origin': origin
      },
      body: 'random non html text'
    });
    const res = await worker.fetch(req, env, ctx);
    assert.equal(res.status, 422);
    const json = await res.json();
    assert.equal(json.code, 'invalid-document');
    console.log('✓ Test 7 Passed: Non-HTML body refused with 422 invalid-document');
  }

  // Test 8: Asset Upload - Refuses HTML as unsupported-type (415)
  {
    const req = new Request(`${origin}/_/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'X-File-Name': 'script.html',
        'Document-URL': `${origin}/app.html`,
        'Origin': origin
      },
      body: '<!DOCTYPE html><html><body>test</body></html>'
    });
    const res = await worker.fetch(req, env, ctx);
    assert.equal(res.status, 415);
    const json = await res.json();
    assert.equal(json.code, 'unsupported-type');
    console.log('✓ Test 8 Passed: HTML asset upload refused with 415 unsupported-type');
  }

  // Test 9: Asset Upload - Binary File Success
  {
    const binData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const req = new Request(`${origin}/_/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': 'photo.png',
        'Document-URL': `${origin}/app.html`,
        'Origin': origin
      },
      body: binData
    });
    const res = await worker.fetch(req, env, ctx);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.msg, 'Uploaded 1 file');
    assert.ok(Array.isArray(json.uploads));
    assert.equal(json.uploads.length, 1);
    assert.ok(json.uploads[0].name.startsWith('photo-'));
    assert.ok(json.uploads[0].url.startsWith('assets-app/photo-'), 'URL must be document-relative');
    assert.equal(json.uploads[0].bytes, 8);
    console.log('✓ Test 9 Passed: Asset upload succeeds with document-relative URL in uploads array');
  }

  // Test 10: GET Document - Injects durable documentid
  {
    const req = new Request(`${origin}/app.html`, { method: 'GET' });
    const res = await worker.fetch(req, env, ctx);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(/<html\b[^>]*\bdocumentid="doc-[a-f0-9-]+"/i.test(html), 'Served HTML document has durable documentid injected');
    console.log('✓ Test 10 Passed: GET document injects durable documentid attribute at serve time');
  }

  console.log('\n--- ALL 10 CONFORMANCE TESTS PASSED SUCCESSFULLY! ---');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
