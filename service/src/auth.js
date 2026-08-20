/**
 * Upload auth via Bearer / X-WAC-Key against SHA-256 digests in KV.
 *
 * Binding: env.WAC_KEYS
 * Each KV key is a scope string; value is the SHA-256 hex digest of the token.
 *
 * Lookup order (first match wins):
 *   1. org/site/wacPath
 *   2. org/site
 *   3. org
 *   4. *
 *
 * Add / rotate (not in git):
 *   node -e "console.log(require('crypto').createHash('sha256').update('TOKEN').digest('hex'))"
 *   npx wrangler kv key put --binding WAC_KEYS --preview false --remote "adobecom/wac-demo" "<sha256-hex>"
 *   npx wrangler kv key put --binding WAC_KEYS --preview --remote "adobecom/wac-demo" "<sha256-hex>"
 */

/**
 * @param {Request} request
 * @param {{ WAC_KEYS?: KVNamespace }} env
 * @param {{ org: string, site: string, wacPath?: string }} target
 * @returns {Promise<{ ok: true } | { ok: false, error: string, status: number }>}
 */
export async function authorizeUpload(request, env, target) {
  const presented = getPresentedKey(request);
  if (!presented) {
    return {
      ok: false,
      status: 401,
      error: 'missing_credentials',
    };
  }

  if (!env.WAC_KEYS) {
    return {
      ok: false,
      status: 503,
      error: 'upload_keys_not_configured',
    };
  }

  const presentedHash = await sha256Hex(presented);

  const candidates = [];
  if (target.wacPath) {
    candidates.push(`${target.org}/${target.site}/${target.wacPath}`);
  }
  candidates.push(`${target.org}/${target.site}`, target.org, '*');

  let sawAny = false;
  for (const scope of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const expected = await env.WAC_KEYS.get(scope);
    if (!expected) continue;
    sawAny = true;
    if (timingSafeEqual(presentedHash, expected.trim())) {
      return { ok: true };
    }
  }

  if (!sawAny) {
    // No digests configured for this site tree at all.
    return {
      ok: false,
      status: 503,
      error: 'upload_keys_not_configured',
    };
  }

  return {
    ok: false,
    status: 403,
    error: 'forbidden',
  };
}

/**
 * @param {Request} request
 */
function getPresentedKey(request) {
  const header = request.headers.get('Authorization') || '';
  const bearer = header.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();

  const xKey = request.headers.get('X-WAC-Key');
  if (xKey) return xKey.trim();

  return '';
}

/**
 * @param {string} value
 */
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * @param {string} a
 * @param {string} b
 */
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const aa = enc.encode(a);
  const bb = enc.encode(b);
  if (aa.byteLength !== bb.byteLength) {
    // Still walk the longer buffer to reduce length-oracle timing.
    let diff = aa.byteLength ^ bb.byteLength;
    const len = Math.max(aa.byteLength, bb.byteLength);
    for (let i = 0; i < len; i += 1) {
      diff |= (aa[i] || 0) ^ (bb[i] || 0);
    }
    return false;
  }
  let diff = 0;
  for (let i = 0; i < aa.byteLength; i += 1) {
    diff |= aa[i] ^ bb[i];
  }
  return diff === 0;
}
