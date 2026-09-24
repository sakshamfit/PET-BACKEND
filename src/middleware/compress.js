/**
 * Response compression — Zstd first, Brotli second, identity otherwise.
 *
 * Both codecs come from `node:zlib` (no dependencies, matching the
 * office-PC install story): brotli for universal quality, zstd for the
 * modern clients that can take it (RFC 8831 registers `zstd` in
 * Accept-Encoding). JSON API payloads and the SPA bundle are where the
 * bytes are; already-compressed media is left alone.
 *
 * Behaviour, mirroring the well-known `compression` package:
 *   • negotiate from Accept-Encoding (q-values, `*`, explicit `;q=0`);
 *   • buffer until `compressMinBytes` — smaller responses go out as-is
 *     (compressing a 200-byte JSON error costs CPU for negative gain);
 *   • once the threshold is crossed, stream through the encoder so large
 *     static assets (JS/CSS/HTML) never sit fully in memory;
 *   • skip images/video/audio/pdf/fonts, any response that already has a
 *     Content-Encoding, and `Cache-Control: no-transform`;
 *   • set `Vary: Accept-Encoding` on anything that DID vary so caches
 *     (Cloudflare Tunnel, any future CDN) stay honest.
 *
 * Tunables: PET_COMPRESS_MIN_BYTES, PET_BROTLI_QUALITY (0–11),
 * PET_ZSTD_LEVEL (0–22, default = zlib's ZSTD_CLEVEL_DEFAULT).
 */
'use strict';

const zlib = require('zlib');

/** Content types that must not be recompressed (already dense / binary). */
const SKIP_CONTENT_TYPE = [
  /^image\//,
  /^video\//,
  /^audio\//,
  /^font\//,
  /^application\/(zip|gzip|x-gzip|x-brotli|x-zstd|pdf|woff2?|vnd\.ms-fontobject|protobuf|wasm)/,
  /^text\/markdown\b/, // rare, not worth the CPU
];

/**
 * Parse Accept-Encoding → preferred encoding this client understands.
 * Order: zstd (fast + small) → br (best ratio, universal since 2016).
 */
function negotiate(acceptHeader) {
  const raw = String(acceptHeader || '');
  if (!raw.trim()) return null;

  const entries = raw
    .split(',')
    .map(part => {
      const [name, ...params] = part.trim().split(';');
      const qParam = params.find(p => p.trim().toLowerCase().startsWith('q='));
      let q = 1;
      if (qParam) {
        const parsed = Number.parseFloat(qParam.trim().slice(2));
        if (Number.isFinite(parsed)) q = parsed;
      }
      return { name: name.trim().toLowerCase(), q };
    })
    .filter(e => e.name);

  const qualityOf = token => {
    const exact = entries.find(e => e.name === token);
    if (exact) return exact.q;
    const star = entries.find(e => e.name === '*');
    return star ? star.q : 0;
  };

  // Honour explicit client preference (q), breaking ties zstd > br.
  const qZstd = qualityOf('zstd');
  const qBr = qualityOf('br');
  if (qZstd <= 0 && qBr <= 0) return null;
  if (qZstd > qBr) return 'zstd';
  if (qBr > qZstd) return 'br';
  return qZstd > 0 ? 'zstd' : 'br';
}

function makeEncoder(encoding, config) {
  if (encoding === 'zstd') {
    const level = Number.isFinite(config.zstdLevel)
      ? config.zstdLevel
      : zlib.constants.ZSTD_CLEVEL_DEFAULT;
    return zlib.createZstdCompress({
      params: { [zlib.constants.ZSTD_c_compressionLevel]: level },
    });
  }
  return zlib.createBrotliCompress({
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: config.brotliQuality,
      // Text mode: our payloads are JSON/JS/CSS/HTML, not JPEG entropy.
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
    },
  });
}

function compress(config) {
  const minBytes = config.compressMinBytes;

  return function compressionMiddleware(req, res, next) {
    if (req.method === 'HEAD') return next();
    const encoding = negotiate(req.headers['accept-encoding']);
    if (!encoding) return next();

    let mode = 'buffer'; // buffer → stream | raw | done
    let buffers = [];
    let buffered = 0;
    let encoder = null;

    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    const origFlushHeaders = res.flushHeaders.bind(res);

    function excluded() {
      if (res.getHeader('content-encoding')) return true;
      const status = res.statusCode;
      if (status < 200 || status === 204 || status === 304) return true;
      if (/\bno-transform\b/i.test(String(res.getHeader('cache-control') || ''))) return true;
      const ct = String(res.getHeader('content-type') || '').toLowerCase();
      if (!ct) return false; // type not set yet — assume API JSON (set before writes)
      return SKIP_CONTENT_TYPE.some(re => re.test(ct));
    }

    function addVary() {
      const current = res.getHeader('vary');
      if (current === undefined) {
        res.setHeader('vary', 'Accept-Encoding');
      } else {
        const list = String(current)
          .split(',')
          .map(v => v.trim().toLowerCase())
          .filter(Boolean);
        if (!list.includes('accept-encoding')) {
          res.setHeader('vary', `${current}, Accept-Encoding`);
        }
      }
    }

    function commitHeaders() {
      res.setHeader('content-encoding', encoding);
      addVary();
      // Length changed — let the transport use chunked encoding.
      res.removeHeader('content-length');
    }

    function toBuffer(chunk, enc) {
      if (Buffer.isBuffer(chunk)) return chunk;
      if (typeof enc === 'string') return Buffer.from(chunk, enc);
      return Buffer.from(chunk);
    }

    function startStream() {
      mode = 'stream';
      commitHeaders();
      encoder = makeEncoder(encoding, config);

      encoder.on('data', chunk => {
        if (!origWrite(chunk)) {
          encoder.pause();
          res.once('drain', () => encoder.resume());
        }
      });
      encoder.on('error', err => {
        // Compressor died mid-response: cut the socket so the client sees a
        // truncated transfer instead of silently corrupt data.
        if (!res.writableEnded) res.destroy(err);
      });
      res.on('close', () => {
        if (!encoder.destroyed) encoder.destroy();
      });

      const pending = buffers;
      buffers = [];
      for (const b of pending) encoder.write(b);
    }

    function flushRaw() {
      mode = 'raw';
      const pending = buffers;
      buffers = [];
      buffered = 0;
      for (const b of pending) origWrite(b);
    }

    res.write = function patchedWrite(chunk, enc, cb) {
      if (typeof enc === 'function') {
        cb = enc;
        enc = undefined;
      }
      if (mode === 'done') return origWrite(chunk, enc, cb);
      if (mode === 'raw') return origWrite(chunk, enc, cb);

      if (chunk === undefined || chunk === null) {
        if (typeof cb === 'function') process.nextTick(cb);
        return true;
      }

      const buf = toBuffer(chunk, enc);

      if (mode === 'buffer') {
        if (excluded()) {
          flushRaw();
          return origWrite(chunk, enc, cb);
        }
        buffers.push(buf);
        buffered += buf.length;
        if (buffered >= minBytes) startStream();
        if (typeof cb === 'function') process.nextTick(cb);
        return true;
      }

      // stream mode
      const ok = encoder.write(buf);
      // Backpressure must map to the stream the CALLER waits on: when the
      // encoder is full, `false` here makes the producer wait for 'drain' on
      // `res` — so forward the encoder's drain to res, or file pipes stall
      // forever (res never fills its own socket buffer to emit one).
      if (!ok) encoder.once('drain', () => res.emit('drain'));
      if (typeof cb === 'function') process.nextTick(cb);
      return ok;
    };

    res.flushHeaders = function patchedFlushHeaders(cb) {
      // Nothing has been written yet → we cannot vary yet; lock in identity
      // so the flushed headers stay truthful.
      if (mode === 'buffer') mode = 'raw';
      origFlushHeaders(cb);
    };

    res.end = function patchedEnd(chunk, enc, cb) {
      if (typeof chunk === 'function') {
        cb = chunk;
        chunk = null;
        enc = undefined;
      } else if (typeof enc === 'function') {
        cb = enc;
        enc = undefined;
      }

      if (mode === 'done') return origEnd(chunk, enc, cb);
      if (mode === 'raw') {
        mode = 'done';
        return origEnd(chunk, enc, cb);
      }

      if (mode === 'buffer') {
        if (chunk !== undefined && chunk !== null) {
          const buf = toBuffer(chunk, enc);
          buffers.push(buf);
          buffered += buf.length;
        }
        if (excluded() || buffered < minBytes) {
          flushRaw();
          mode = 'done';
          return origEnd(undefined, undefined, cb);
        }
        // Final chunk pushed us over the threshold — compress it too
        // (startStream flushes everything buffered, this chunk included).
        startStream();
      } else if (chunk !== undefined && chunk !== null) {
        // Stream already running: the last chunk must still reach the encoder.
        encoder.write(toBuffer(chunk, enc));
      }

      // stream mode: drain the encoder fully, THEN end the socket.
      //
      // Note: we wait for the encoder's readable 'end', NOT end()'s
      // callback — for zlib streams the writable callback fires BEFORE any
      // compressed bytes are emitted (verified: 0 bytes at cb), which would
      // truncate every response. 'end' fires after the last 'data'.
      mode = 'done';
      const done = typeof cb === 'function' ? cb : undefined;
      if (encoder.readableEnded) {
        origEnd(done);
      } else {
        encoder.once('end', () => origEnd(done));
        encoder.end();
      }
      return res;
    };

    next();
  };
}

module.exports = { compress, negotiate };
