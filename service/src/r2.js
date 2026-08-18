/**
 * R2 helpers for serving and deleting WAC prefixes.
 */

import { contentTypeFor } from './mime.js';

/** Manifest lives at <prefix>/.wac/manifest.json */
export const WAC_DIR = '.wac';
export const WAC_MANIFEST = `${WAC_DIR}/manifest.json`;
/** @deprecated legacy single-file manifest */
export const WAC_MANIFEST_LEGACY = '.wac.json';

/**
 * @param {R2Bucket} bucket
 * @param {{ key: string, wantsIndex: boolean }} target
 * @param {boolean} headOnly
 * @param {URL} requestUrl
 */
export async function serveFromR2(bucket, target, headOnly, requestUrl) {
  if (isProtectedKey(target.key)) {
    return notFound();
  }

  if (target.wantsIndex) {
    const index = await getFirst(bucket, [
      `${target.key}/index.html`,
      `${target.key}/index.htm`,
    ]);
    if (index) return respondObject(index.object, index.key, headOnly);

    const redirect = await defaultRedirectFor(bucket, target.key, requestUrl);
    if (redirect) return redirect;
    return notFound();
  }

  // Exact file
  if (!isProtectedKey(target.key)) {
    const exact = await bucket.get(target.key);
    if (exact) return respondObject(exact, target.key, headOnly);
  }

  // Treat as directory container
  const index = await getFirst(bucket, [
    `${target.key}/index.html`,
    `${target.key}/index.htm`,
  ]);
  if (index) return respondObject(index.object, index.key, headOnly);

  const redirect = await defaultRedirectFor(bucket, target.key, requestUrl);
  if (redirect) return redirect;

  return notFound();
}

/**
 * @param {R2Bucket} bucket
 * @param {string[]} keys
 */
async function getFirst(bucket, keys) {
  for (const key of keys) {
    if (isProtectedKey(key)) continue;
    // eslint-disable-next-line no-await-in-loop
    const object = await bucket.get(key);
    if (object) return { object, key };
  }
  return null;
}

/**
 * @param {R2ObjectBody} object
 * @param {string} matchedKey
 * @param {boolean} headOnly
 */
function respondObject(object, matchedKey, headOnly) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', contentTypeFor(matchedKey));
  }
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', cacheControlFor(matchedKey));
  headers.set('Access-Control-Allow-Origin', '*');

  if (headOnly) {
    return new Response(null, { status: 200, headers });
  }

  return new Response(object.body, { status: 200, headers });
}

/**
 * @param {R2Bucket} bucket
 * @param {string} containerKey  org/site/wac-path
 * @param {URL} requestUrl
 */
async function defaultRedirectFor(bucket, containerKey, requestUrl) {
  const manifest = await readWacManifest(bucket, containerKey);
  const defaultsTo = manifest?.default;
  if (!defaultsTo || typeof defaultsTo !== 'string') return null;

  const dest = new URL(requestUrl.href);
  const basePath = `/${containerKey}`.replace(/\/+/g, '/');
  dest.pathname = `${basePath}/${defaultsTo}`.replace(/\/+/g, '/');

  return new Response(null, {
    status: 301,
    headers: {
      Location: dest.pathname + dest.search,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=60',
    },
  });
}

/**
 * @param {string} key
 */
function isProtectedKey(key) {
  const parts = key.split('/');
  return parts.includes(WAC_DIR)
    || key.endsWith(WAC_MANIFEST_LEGACY)
    || key.endsWith(`/${WAC_MANIFEST_LEGACY}`);
}

function notFound() {
  return new Response('Not Found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/**
 * @param {R2Bucket} bucket
 * @param {string} prefix  e.g. goodness/demo/hello
 * @returns {Promise<object | null>}
 */
export async function readWacManifest(bucket, prefix) {
  const primary = await bucket.get(`${prefix}/${WAC_MANIFEST}`);
  if (primary) {
    try {
      return await primary.json();
    } catch {
      return null;
    }
  }

  const legacy = await bucket.get(`${prefix}/${WAC_MANIFEST_LEGACY}`);
  if (!legacy) return null;
  try {
    return await legacy.json();
  } catch {
    return null;
  }
}

/**
 * @param {R2Bucket} bucket
 * @param {string} prefix  e.g. goodness/demo/hello
 * @param {{ files: string[], skipped: string[] }} result
 * @param {{
 *   author?: string | null,
 *   previous?: object | null,
 *   defaultAsset?: string | null,
 * }} [options]
 */
export async function writeWacManifest(bucket, prefix, result, options = {}) {
  const now = new Date().toISOString();
  const previous = options.previous || null;
  const created = previous?.created || previous?.uploadedAt || now;
  const author = options.author ?? previous?.author ?? null;

  const hasIndex = result.files.some((f) => {
    const lower = f.toLowerCase();
    return lower === 'index.html' || lower === 'index.htm';
  });

  let defaultAsset = options.defaultAsset ?? null;
  if (hasIndex) {
    defaultAsset = null;
  } else if (defaultAsset) {
    const normalized = defaultAsset.replace(/^\/+/, '');
    if (!result.files.includes(normalized)) {
      throw new Error('invalid_default');
    }
    defaultAsset = normalized;
  } else if (previous?.default && result.files.includes(previous.default)) {
    defaultAsset = previous.default;
  }

  const body = JSON.stringify({
    path: prefix.split('/').slice(2).join('/'),
    prefix,
    author,
    created,
    lastModified: now,
    default: defaultAsset,
    hasIndex,
    files: result.files,
    fileCount: result.files.length,
    skipped: result.skipped,
  }, null, 2);

  await bucket.put(`${prefix}/${WAC_MANIFEST}`, body, {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { source: 'wac-manifest' },
  });

  // Clean up legacy manifest location if present
  await bucket.delete(`${prefix}/${WAC_MANIFEST_LEGACY}`);

  return JSON.parse(body);
}

/**
 * List uploaded WACs under org/site via `.wac/manifest.json` (and legacy).
 * @param {R2Bucket} bucket
 * @param {string} org
 * @param {string} site
 */
export async function listWacs(bucket, org, site) {
  const base = `${org}/${site}/`;
  const manifests = [];
  let truncated = true;
  let cursor;

  while (truncated) {
    // eslint-disable-next-line no-await-in-loop
    const listed = await bucket.list({
      prefix: base,
      cursor,
      limit: 1000,
    });

    for (const obj of listed.objects) {
      const relative = obj.key.slice(base.length);
      let wacPath = null;

      if (relative.endsWith(`/${WAC_MANIFEST}`)) {
        wacPath = relative.slice(0, -(`/${WAC_MANIFEST}`).length);
      } else if (relative.endsWith(`/${WAC_MANIFEST_LEGACY}`)) {
        wacPath = relative.slice(0, -(`/${WAC_MANIFEST_LEGACY}`).length);
      }

      if (!wacPath || wacPath.includes(`/${WAC_DIR}/`) || wacPath === WAC_DIR) continue;

      manifests.push({
        path: wacPath,
        key: obj.key,
        uploaded: obj.uploaded,
        size: obj.size,
      });
    }

    truncated = listed.truncated;
    cursor = listed.truncated ? listed.cursor : undefined;
  }

  // Prefer new manifest when both exist for the same path
  const byPath = new Map();
  for (const entry of manifests) {
    const existing = byPath.get(entry.path);
    if (!existing || entry.key.endsWith(WAC_MANIFEST)) {
      byPath.set(entry.path, entry);
    }
  }

  const unique = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));

  const wacs = await Promise.all(unique.map(async (entry) => {
    const object = await bucket.get(entry.key);
    let meta = null;
    if (object) {
      try {
        meta = await object.json();
      } catch {
        meta = null;
      }
    }

    return {
      path: entry.path,
      url: `/${org}/${site}/${entry.path}/`,
      author: meta?.author ?? null,
      created: meta?.created ?? meta?.uploadedAt ?? (entry.uploaded ? new Date(entry.uploaded).toISOString() : null),
      lastModified: meta?.lastModified ?? meta?.uploadedAt ?? (entry.uploaded ? new Date(entry.uploaded).toISOString() : null),
      default: meta?.default ?? null,
      hasIndex: meta?.hasIndex ?? null,
      fileCount: meta?.fileCount ?? meta?.files?.length ?? null,
      files: meta?.files ?? null,
    };
  }));

  return {
    org,
    site,
    count: wacs.length,
    wacs,
  };
}

/**
 * Delete every object under prefix/
 * @param {R2Bucket} bucket
 * @param {string} prefix
 */
export async function deletePrefix(bucket, prefix) {
  const normalized = prefix.replace(/\/+$/, '');
  let truncated = true;
  let cursor;
  let deleted = 0;

  while (truncated) {
    // eslint-disable-next-line no-await-in-loop
    const listed = await bucket.list({
      prefix: `${normalized}/`,
      cursor,
      limit: 1000,
    });

    if (listed.objects.length > 0) {
      const keys = listed.objects.map((o) => o.key);
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(keys.map((key) => bucket.delete(key)));
      deleted += keys.length;
    }

    truncated = listed.truncated;
    cursor = listed.truncated ? listed.cursor : undefined;
  }

  return deleted;
}

/**
 * @param {string} key
 */
function cacheControlFor(key) {
  const lower = key.toLowerCase();
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    return 'public, max-age=60';
  }
  return 'public, max-age=86400';
}
