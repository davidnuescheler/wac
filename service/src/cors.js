/**
 * CORS helpers — uploads and public consumption are both cross-origin friendly.
 */

const ALLOW_HEADERS = 'Authorization, Content-Type, X-WAC-Key, X-WAC-Author, X-WAC-Default';
const ALLOW_METHODS = 'GET, HEAD, POST, DELETE, OPTIONS';

/**
 * @param {Request} request
 */
export function handleOptions(request) {
  const headers = corsHeaders(request);
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(null, { status: 204, headers });
}

/**
 * @param {Response} response
 * @param {Request} request
 */
export function withCors(response, request) {
  const headers = new Headers(response.headers);
  const cors = corsHeaders(request);
  cors.forEach((value, key) => headers.set(key, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * @param {Request} request
 */
function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return new Headers({
    'Access-Control-Allow-Origin': origin === 'null' ? '*' : origin,
    'Access-Control-Allow-Methods': ALLOW_METHODS,
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Expose-Headers': 'Content-Type, Content-Length, ETag',
    Vary: 'Origin',
  });
}
