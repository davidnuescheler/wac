/**
 * Proxy /tools/* to the AEM EDS origin using the BYO Cloudflare worker logic.
 * Source: https://github.com/adobe/aem-cloudflare-prod-worker/blob/main/src/index.mjs
 */

const DEFAULT_ORIGIN_HOSTNAME = 'main--wac--davidnuescheler.aem.live';

/**
 * @param {string} pathname
 */
export function isToolsPath(pathname) {
  return pathname === '/tools' || pathname.startsWith('/tools/');
}

/**
 * @param {string} path
 */
function getExtension(path) {
  const basename = path.split('/').pop();
  const pos = basename.lastIndexOf('.');
  return (basename === '' || pos < 1) ? '' : basename.slice(pos + 1);
}

/**
 * @param {URL} url
 */
function isMediaRequest(url) {
  return /\/media_[0-9a-f]{40,}[/a-zA-Z0-9_-]*\.[0-9a-z]+$/.test(url.pathname);
}

/**
 * @param {Request} request
 * @param {Env} env
 */
export async function proxyToAemLive(request, env) {
  const url = new URL(request.url);
  const extension = getExtension(url.pathname);

  // remember original search params
  const savedSearch = url.search;

  // sanitize search params
  const { searchParams } = url;
  if (isMediaRequest(url)) {
    for (const [key] of searchParams.entries()) {
      if (!['format', 'height', 'optimize', 'width'].includes(key)) {
        searchParams.delete(key);
      }
    }
  } else if (extension === 'json') {
    for (const [key] of searchParams.entries()) {
      if (!['limit', 'offset', 'sheet'].includes(key)) {
        searchParams.delete(key);
      }
    }
  } else {
    // neither media nor json request: strip search params
    url.search = '';
  }
  searchParams.sort();

  url.protocol = 'https:';
  url.port = '';
  url.hostname = env.ORIGIN_HOSTNAME || DEFAULT_ORIGIN_HOSTNAME;
  if (!url.origin.match(/^https:\/\/main--.*--.*\.(?:aem|hlx)\.live$/)) {
    return new Response('Invalid ORIGIN_HOSTNAME', { status: 500 });
  }

  const forwardedHost = request.headers.get('host');
  const req = new Request(url, request);
  req.headers.delete('host');
  if (forwardedHost) {
    req.headers.set('x-forwarded-host', forwardedHost);
  }
  req.headers.set('x-byo-cdn-type', 'cloudflare');
  if (env.PUSH_INVALIDATION !== 'disabled') {
    req.headers.set('x-push-invalidation', 'enabled');
  }
  if (env.ORIGIN_AUTHENTICATION) {
    req.headers.set('authorization', `token ${env.ORIGIN_AUTHENTICATION}`);
  }

  let resp = await fetch(req, {
    method: req.method,
    cf: {
      // cf doesn't cache html by default: need to override the default behavior
      cacheEverything: true,
    },
  });
  resp = new Response(resp.body, resp);
  if (resp.status === 301 && savedSearch) {
    const location = resp.headers.get('location');
    if (location && !location.match(/\?.*$/)) {
      resp.headers.set('location', `${location}${savedSearch}`);
    }
  }
  if (resp.status === 304) {
    // 304 Not Modified - remove CSP header
    resp.headers.delete('Content-Security-Policy');
  }
  resp.headers.delete('age');
  resp.headers.delete('x-robots-tag');
  return resp;
}

/**
 * @typedef {{
 *   ORIGIN_HOSTNAME?: string,
 *   PUSH_INVALIDATION?: string,
 *   ORIGIN_AUTHENTICATION?: string,
 * }} Env
 */
