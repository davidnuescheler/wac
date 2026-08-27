/**
 * Web Asset Container (WAC) Worker
 *
 * Upload:  POST /<org>/<site>/<wac-path>.wac   (auth required, CORS)
 * Delete:  DELETE /<org>/<site>/<wac-path>.wac (auth required, CORS)
 * List:    GET  /<org>/<site>/index.json       (auth required, CORS)
 * Serve:   GET  /<org>/<site>/<wac-path>/...   (X-Forwarded-Host required, CORS)
 */

import { handleOptions, withCors } from './cors.js';
import { authorizeUpload } from './auth.js';
import { authorizeAssetDelivery } from './xfh.js';
import { parseAuthor } from './author.js';
import { parseUploadTarget, parseServeTarget, parseSiteIndexTarget } from './paths.js';
import { extractZipToPrefix, analyzeZip } from './unzip.js';
import {
  serveFromR2,
  deletePrefix,
  writeWacManifest,
  readWacManifest,
  listWacs,
} from './r2.js';

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (request.method === 'OPTIONS') {
        return handleOptions(request);
      }

      if (url.pathname === '/' || url.pathname === '') {
        return withCors(json({
          service: 'wac',
          usage: {
            upload: 'POST /<org>/<site>/<wac-path>.wac  (Authorization: Bearer <key>, optional X-WAC-Author, body: zip)',
            delete: 'DELETE /<org>/<site>/<wac-path>.wac  (Authorization: Bearer <key>)',
            list: 'GET /<org>/<site>/index.json  (Authorization: Bearer <key>)',
            serve: 'GET /<org>/<site>/<wac-path>/[...path]  (requires X-Forwarded-Host: <branch>--<site>--<org>.aem.network)',
          },
        }), request);
      }

      if (request.method === 'POST' || request.method === 'DELETE') {
        return withCors(await handleMutate(request, env, url), request);
      }

      if (request.method === 'GET' || request.method === 'HEAD') {
        const siteIndex = parseSiteIndexTarget(url.pathname);
        if (siteIndex) {
          return withCors(await handleSiteIndex(request, env, siteIndex), request);
        }
        return withCors(await handleServe(request, env, url), request);
      }

      return withCors(json({ error: 'method_not_allowed' }, 405), request);
    } catch (err) {
      console.error(err);
      return withCors(json({
        error: 'internal_error',
        message: err instanceof Error ? err.message : String(err),
      }, 500), request);
    }
  },
};

/**
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 */
async function handleMutate(request, env, url) {
  const target = parseUploadTarget(url.pathname);
  if (!target) {
    return json({
      error: 'bad_path',
      message: 'Upload path must be /<org>/<site>/<wac-path>.wac',
    }, 400);
  }

  const auth = await authorizeUpload(request, env, target);
  if (!auth.ok) {
    return json({ error: auth.error }, auth.status);
  }

  const { prefix } = target;

  if (request.method === 'DELETE') {
    const deleted = await deletePrefix(env.WAC_BUCKET, prefix);
    return json({ ok: true, prefix, deleted });
  }

  const contentType = request.headers.get('content-type') || '';
  if (!request.body) {
    return json({ error: 'empty_body', message: 'POST a zip file as the request body' }, 400);
  }

  const maxBytes = Number(env.MAX_ZIP_BYTES || 52_428_800);
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > maxBytes) {
    return json({
      error: 'zip_too_large',
      message: `Zip must be <= ${maxBytes} bytes`,
      maxBytes,
    }, 413);
  }

  const zipBytes = new Uint8Array(await request.arrayBuffer());
  if (zipBytes.byteLength === 0) {
    return json({ error: 'empty_body' }, 400);
  }
  if (zipBytes.byteLength > maxBytes) {
    return json({
      error: 'zip_too_large',
      message: `Zip must be <= ${maxBytes} bytes`,
      maxBytes,
    }, 413);
  }

  // Soft check — clients may send application/zip, octet-stream, or multipart.
  if (contentType.includes('multipart/form-data')) {
    return json({
      error: 'unsupported_content_type',
      message: 'Send the raw zip bytes as the body (Content-Type: application/zip), not multipart form data',
    }, 415);
  }

  const authorResult = parseAuthor(request, url);
  if ('error' in authorResult) {
    return json({
      error: authorResult.error,
      message: 'Author must be a valid email (X-WAC-Author header or ?author=)',
    }, 400);
  }

  const defaultAsset = (request.headers.get('X-WAC-Default') || url.searchParams.get('default') || '')
    .trim()
    .replace(/^\/+/, '') || null;

  let analyzed;
  try {
    analyzed = analyzeZip(zipBytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('invalid_zip') || message === 'empty_zip') {
      return json({ error: message }, 400);
    }
    throw err;
  }

  const hasIndex = analyzed.files.some((f) => {
    const lower = f.toLowerCase();
    return lower === 'index.html' || lower === 'index.htm';
  });

  const previous = await readWacManifest(env.WAC_BUCKET, prefix);
  const effectiveDefault = defaultAsset || (!hasIndex ? previous?.default : null) || null;

  if (!hasIndex) {
    if (!effectiveDefault) {
      return json({
        error: 'default_required',
        message: 'Zip has no index.html — send X-WAC-Default with a file path from the archive',
        files: analyzed.files,
      }, 400);
    }
    if (!analyzed.files.includes(effectiveDefault)) {
      return json({
        error: 'invalid_default',
        message: 'X-WAC-Default must reference a file inside the zip',
        files: analyzed.files,
      }, 400);
    }
  }

  await deletePrefix(env.WAC_BUCKET, prefix);

  let result;
  try {
    result = await extractZipToPrefix(env.WAC_BUCKET, prefix, zipBytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('invalid_zip') || message === 'empty_zip') {
      return json({ error: message }, 400);
    }
    throw err;
  }

  const manifest = await writeWacManifest(env.WAC_BUCKET, prefix, result, {
    author: authorResult.author,
    previous,
    defaultAsset: hasIndex ? null : effectiveDefault,
    zipSize: zipBytes.byteLength,
  });

  return json({
    ok: true,
    prefix,
    author: manifest.author,
    created: manifest.created,
    lastModified: manifest.lastModified,
    default: manifest.default,
    hasIndex: manifest.hasIndex,
    zipSize: manifest.zipSize,
    files: result.files,
    skipped: result.skipped,
    url: `/${prefix}/`,
  }, 201);
}

/**
 * @param {Request} request
 * @param {Env} env
 * @param {{ org: string, site: string }} site
 */
async function handleSiteIndex(request, env, site) {
  const auth = await authorizeUpload(request, env, site);
  if (!auth.ok) {
    return json({ error: auth.error }, auth.status);
  }

  if (request.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  const listing = await listWacs(env.WAC_BUCKET, site.org, site.site);
  return json(listing);
}

/**
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 */
async function handleServe(request, env, url) {
  const target = parseServeTarget(url.pathname);
  if (!target) {
    return json({
      error: 'bad_path',
      message: 'Serve path must be /<org>/<site>/<wac-path>/...',
    }, 400);
  }

  const xfh = authorizeAssetDelivery(request, target);
  if (!xfh.ok) {
    return json({
      error: xfh.error,
      message: 'Asset delivery requires X-Forwarded-Host: <branch>--<site>--<org>.aem.network matching the path',
    }, xfh.status);
  }

  return serveFromR2(env.WAC_BUCKET, target, request.method === 'HEAD', url);
}

/**
 * @param {unknown} body
 * @param {number} [status]
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * @typedef {{
 *   WAC_BUCKET: R2Bucket,
 *   WAC_KEYS?: KVNamespace,
 *   MAX_ZIP_BYTES?: string,
 * }} Env
 */
