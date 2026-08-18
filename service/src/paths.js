/**
 * Path parsing for WAC URL shapes.
 *
 * Upload / delete: /<org>/<site>/<wac-path>.wac
 * Serve:           /<org>/<site>/<wac-path>[/<asset...>]
 *
 * R2 object keys mirror the URL path (no leading slash):
 *   org/site/wac-path/index.html
 */

const SEGMENT = '[^/]+';

/**
 * @param {string} pathname
 * @returns {{ org: string, site: string, wacPath: string, prefix: string } | null}
 */
export function parseUploadTarget(pathname) {
  const path = stripTrailingSlash(collapseSlashes(pathname));
  const match = path.match(new RegExp(`^/(${SEGMENT})/(${SEGMENT})/(.+)\\.wac$`, 'i'));
  if (!match) return null;

  const org = decodeSegment(match[1]);
  const site = decodeSegment(match[2]);
  const wacPath = decodePath(match[3]);
  if (!isSafeSegment(org) || !isSafeSegment(site) || !isSafePath(wacPath)) return null;

  return {
    org,
    site,
    wacPath,
    prefix: `${org}/${site}/${wacPath}`,
  };
}

/**
 * Site listing: /<org>/<site>/index.json
 * @param {string} pathname
 * @returns {{ org: string, site: string } | null}
 */
export function parseSiteIndexTarget(pathname) {
  const path = stripTrailingSlash(collapseSlashes(pathname));
  const match = path.match(new RegExp(`^/(${SEGMENT})/(${SEGMENT})/index\\.json$`, 'i'));
  if (!match) return null;

  const org = decodeSegment(match[1]);
  const site = decodeSegment(match[2]);
  if (!isSafeSegment(org) || !isSafeSegment(site)) return null;

  return { org, site };
}

/**
 * @param {string} pathname
 * @returns {{ org: string, site: string, key: string, wantsIndex: boolean } | null}
 */
export function parseServeTarget(pathname) {
  const raw = collapseSlashes(pathname);
  const wantsIndex = raw.endsWith('/');
  const path = stripTrailingSlash(raw);
  const match = path.match(new RegExp(`^/(${SEGMENT})/(${SEGMENT})/(.+)$`));
  if (!match) return null;

  const org = decodeSegment(match[1]);
  const site = decodeSegment(match[2]);
  const rest = decodePath(match[3]);
  if (!isSafeSegment(org) || !isSafeSegment(site) || !isSafePath(rest)) return null;

  return {
    org,
    site,
    key: `${org}/${site}/${rest}`,
    wantsIndex,
  };
}

/**
 * @param {string} pathname
 */
function collapseSlashes(pathname) {
  const withSlash = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return withSlash.replace(/\/+/g, '/');
}

/**
 * @param {string} pathname
 */
function stripTrailingSlash(pathname) {
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }
  return pathname || '/';
}

/**
 * @param {string} segment
 */
function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return '';
  }
}

/**
 * @param {string} path
 */
function decodePath(path) {
  return path.split('/').map(decodeSegment).filter((p) => p.length > 0).join('/');
}

/**
 * @param {string} segment
 */
function isSafeSegment(segment) {
  return Boolean(segment) && segment !== '.' && segment !== '..';
}

/**
 * @param {string} path
 */
function isSafePath(path) {
  if (!path) return false;
  return path.split('/').every(isSafeSegment);
}
