/**
 * Response-compression tests: raw bytes over the wire (node:http, no
 * auto-decoding fetch), then decompress with zlib to prove roundtrips.
 *
 * Two servers: default threshold (1024) for "small stays small", and a
 * 10-byte threshold to exercise encoders + type exclusions.
 */
'use strict';

process.env.PET_COMPRESS_MIN_BYTES = '1024';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, api, login, ADMIN_EMAIL, ADMIN_PASSWORD, TINY_PNG_BASE64 } = require('./helpers');

/** Raw HTTP GET — returns undecoded bytes + headers. */
function rawGet(base, urlPath, headers = {}) {
  const url = new URL(urlPath, base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET', headers },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

let ctx; // default threshold
let low; // 10-byte threshold
let admin;
const FIXTURE_NOTE = 'x'.repeat(600);

before(async () => {
  ctx = await startServer();
  admin = await login(ctx.base, ADMIN_EMAIL, ADMIN_PASSWORD);

  // Bulk up a list response so it clears the 1 KB default threshold.
  for (let i = 0; i < 6; i += 1) {
    const r = await api(ctx.base, 'POST', '/api/students', {
      token: admin.access_token,
      body: { name: `Compression Candidate ${i}`, notes: `${FIXTURE_NOTE}-${i}`, acknowledge_duplicates: true },
    });
    assert.equal(r.status, 201);
  }

  process.env.PET_COMPRESS_MIN_BYTES = '10';
  low = await startServer();
  await login(low.base, ADMIN_EMAIL, ADMIN_PASSWORD);
});

after(async () => {
  await ctx.close();
  await low.close();
});

test('Accept-Encoding negotiation is honoured on the wire (br)', async () => {
  const res = await rawGet(ctx.base, '/api/students', {
    'accept-encoding': 'br',
    authorization: `Bearer ${admin.access_token}`,
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], 'br');
  assert.match(String(res.headers.vary || ''), /accept-encoding/i);
  const decoded = zlib.brotliDecompressSync(res.body);
  const json = JSON.parse(decoded.toString('utf8'));
  assert.ok(json.total >= 6, 'payload decompressed intact');
  assert.ok(res.body.length < decoded.length, 'wire bytes smaller than payload');
});

test('zstd roundtrips on the wire', async () => {
  const res = await rawGet(ctx.base, '/api/students', {
    'accept-encoding': 'zstd',
    authorization: `Bearer ${admin.access_token}`,
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], 'zstd');
  assert.match(String(res.headers.vary || ''), /accept-encoding/i);
  const decoded = zlib.zstdDecompressSync(res.body);
  const json = JSON.parse(decoded.toString('utf8'));
  assert.ok(json.total >= 6);
  assert.ok(res.body.length < decoded.length);
});

test('responses below the threshold stay identity', async () => {
  const res = await rawGet(ctx.base, '/health', { 'accept-encoding': 'br, zstd' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], undefined);
  assert.equal(JSON.parse(res.body.toString()).status, 'ok');
});

test('no Accept-Encoding → identity', async () => {
  const res = await rawGet(ctx.base, '/api/students', {
    authorization: `Bearer ${admin.access_token}`,
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], undefined);
});

test('gzip-only client (no br/zstd) gets identity — we do not do gzip', async () => {
  const res = await rawGet(ctx.base, '/api/students', {
    'accept-encoding': 'gzip, deflate',
    authorization: `Bearer ${admin.access_token}`,
  });
  assert.equal(res.headers['content-encoding'], undefined);
});

test('client q-values pick br when zstd is disabled', async () => {
  const res = await rawGet(low.base, '/health', { 'accept-encoding': 'zstd;q=0, br' });
  assert.equal(res.headers['content-encoding'], 'br');
  assert.equal(JSON.parse(zlib.brotliDecompressSync(res.body).toString()).status, 'ok');
});

test('tiny payload on the low-threshold server still compresses (zstd)', async () => {
  const res = await rawGet(low.base, '/health', { 'accept-encoding': 'zstd' });
  assert.equal(res.headers['content-encoding'], 'zstd');
  const json = JSON.parse(zlib.zstdDecompressSync(res.body).toString());
  assert.equal(json.status, 'ok');
});

test('already-compressed media is excluded even above threshold', async () => {
  // PNG uploaded through the real API, then fetched with encodings offered.
  // (Must auth against `low` — each server has its own in-memory users.)
  const loginLow = await login(low.base, ADMIN_EMAIL, ADMIN_PASSWORD);
  const upload = await api(low.base, 'POST', '/api/uploads', {
    token: loginLow.access_token,
    body: {
      category: 'documents',
      fileName: 'photo.png',
      mimeType: 'image/png',
      dataBase64: TINY_PNG_BASE64,
    },
  });
  assert.equal(upload.status, 201);

  const res = await rawGet(low.base, `/api/files/${upload.json.relative_path}`, {
    'accept-encoding': 'br, zstd',
    authorization: `Bearer ${loginLow.access_token}`,
  });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /image\/png/);
  assert.equal(res.headers['content-encoding'], undefined, 'PNG must not be recompressed');
  assert.deepEqual(res.body, Buffer.from(TINY_PNG_BASE64, 'base64'), 'bytes intact');
});

test('built SPA asset (when present) streams through zstd intact', async () => {
  const assetsDir = path.join(__dirname, '..', 'public', 'app', 'assets');
  if (!fs.existsSync(assetsDir)) {
    // Not built in this checkout — covered by the office build instead.
    return;
  }
  const [name] = fs.readdirSync(assetsDir).filter(f => f.endsWith('.js'));
  if (!name) return;
  const onDisk = fs.readFileSync(path.join(assetsDir, name));
  assert.ok(onDisk.length > 1024, 'fixture is a real bundle');

  const loginLow = await login(low.base, ADMIN_EMAIL, ADMIN_PASSWORD);
  const res = await rawGet(low.base, `/assets/${name}`, {
    'accept-encoding': 'zstd, br',
    authorization: `Bearer ${loginLow.access_token}`,
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], 'zstd', 'zstd preferred on tie');
  assert.equal(res.headers['content-length'], undefined, 'length rewritten to chunked');
  const decoded = zlib.zstdDecompressSync(res.body);
  assert.deepEqual(decoded, onDisk, 'bundle decompresses byte-for-byte');
});
