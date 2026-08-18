/**
 * Lightweight email check for client-supplied author.
 * @param {string} value
 */
export function isEmail(value) {
  if (!value || value.length > 254) return false;
  // Practical RFC 5322-ish check; rejects spaces and require local@domain.tld
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Read author from X-WAC-Author header or ?author= query.
 * @param {Request} request
 * @param {URL} url
 * @returns {{ author: string | null } | { error: string }}
 */
export function parseAuthor(request, url) {
  const fromHeader = (request.headers.get('X-WAC-Author') || '').trim();
  const fromQuery = (url.searchParams.get('author') || '').trim();
  const raw = fromHeader || fromQuery;

  if (!raw) {
    return { author: null };
  }

  const author = raw.toLowerCase();
  if (!isEmail(author)) {
    return { error: 'invalid_author' };
  }

  return { author };
}
