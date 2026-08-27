/**
 * Gate WAC asset delivery on X-Forwarded-Host.
 *
 * Expected host shape (AEM-style):
 *   <branch>--<site>--<org>.aem.network
 *
 * branch may contain "--" segments; site and org are the last two "--" parts.
 * org/site from the host must match the serve path /<org>/<site>/...
 */

const AEM_NETWORK_SUFFIX = '.aem.network';

/**
 * @param {Request} request
 * @param {{ org: string, site: string }} target
 * @returns {{ ok: true, host: string, branch: string }
 *   | { ok: false, error: string, status: number }}
 */
export function authorizeAssetDelivery(request, target) {
  const raw = (request.headers.get('x-forwarded-host') || '').trim();
  if (!raw) {
    return {
      ok: false,
      status: 403,
      error: 'missing_forwarded_host',
    };
  }

  // XFH can be a comma-separated list; use the first (original client-facing) host.
  const hostHeader = raw.split(',')[0].trim().toLowerCase();
  // Strip optional port.
  const host = hostHeader.replace(/:\d+$/, '');
  const parsed = parseAemNetworkHost(host);
  if (!parsed) {
    return {
      ok: false,
      status: 403,
      error: 'invalid_forwarded_host',
    };
  }

  if (parsed.org !== target.org.toLowerCase()
    || parsed.site !== target.site.toLowerCase()) {
    return {
      ok: false,
      status: 403,
      error: 'forwarded_host_mismatch',
    };
  }

  return {
    ok: true,
    host,
    branch: parsed.branch,
  };
}

/**
 * @param {string} host lowercase hostname without port
 * @returns {{ branch: string, site: string, org: string } | null}
 */
export function parseAemNetworkHost(host) {
  if (!host.endsWith(AEM_NETWORK_SUFFIX)) return null;
  const withoutDomain = host.slice(0, -AEM_NETWORK_SUFFIX.length);
  if (!withoutDomain || withoutDomain.includes('/')) return null;

  const parts = withoutDomain.split('--');
  if (parts.length < 3) return null;
  if (parts.some((p) => !p)) return null;

  const org = parts[parts.length - 1];
  const site = parts[parts.length - 2];
  const branch = parts.slice(0, -2).join('--');
  if (!branch || !site || !org) return null;

  return { branch, site, org };
}
