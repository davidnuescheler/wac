/**
 * Upload auth via Bearer / X-WAC-Key against WAC_UPLOAD_KEYS JSON.
 *
 * Example .dev.vars / secret value:
 *   WAC_UPLOAD_KEYS={"*":"dev-key","acme/docs":"site-key","acme/docs/preview":"path-key"}
 *
 * Lookup order (first match wins):
 *   1. org/site/wacPath
 *   2. org/site
 *   3. org
 *   4. *
 */

/**
 * @param {Request} request
 * @param {{ WAC_UPLOAD_KEYS?: string }} env
 * @param {{ org: string, site: string, wacPath?: string }} target
 * @returns {{ ok: true } | { ok: false, error: string, status: number }}
 */
export function authorizeUpload(request, env, target) {
  const presented = getPresentedKey(request);
  if (!presented) {
    return {
      ok: false,
      status: 401,
      error: 'missing_credentials',
    };
  }

  const keys = parseUploadKeys(env.WAC_UPLOAD_KEYS);
  if (!keys) {
    return {
      ok: false,
      status: 503,
      error: 'upload_keys_not_configured',
    };
  }

  const candidates = [];
  if (target.wacPath) {
    candidates.push(`${target.org}/${target.site}/${target.wacPath}`);
  }
  candidates.push(`${target.org}/${target.site}`, target.org, '*');

  for (const scope of candidates) {
    const expected = keys[scope];
    if (expected && timingSafeEqual(presented, expected)) {
      return { ok: true };
    }
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
 * @param {string | undefined} raw
 * @returns {Record<string, string> | null}
 */
function parseUploadKeys(raw) {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return /** @type {Record<string, string>} */ (parsed);
  } catch {
    return null;
  }
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
