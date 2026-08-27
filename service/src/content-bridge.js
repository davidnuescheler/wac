/**
 * Inject a client script into HTML responses that applies ?content= overlays.
 * Inverse of the manager content panel: newline-separated plain text lines
 * replace WAC leaf text slots in document order.
 *
 * For Design Component pages, also seeds window.__resources so DC skips its
 * pristine-source refetch of location.href (which would wipe the overlay).
 *
 * Applied once, synchronously when possible, before page scripts so animations
 * see the overlaid text as the initial DOM; defers to DOMContentLoaded when
 * injected in <head> before <body> exists.
 */

/** Keep in sync with manager htmlToPlainLines / content export. */
const BLOCK_SELECTOR = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'li', 'dt', 'dd', 'blockquote', 'pre', 'figcaption',
  'th', 'td', 'caption', 'summary', 'address',
  'span', 'div', 'a', 'label', 'button',
].join(',');

/**
 * Browser script. Avoid raw "</..." sequences in source so HTML embedding is safe.
 * Do NOT blanket-escape "<" — that breaks comparisons like `i < n`.
 */
const CONTENT_BRIDGE_SCRIPT = `(function(){
  try {
    var params = new URLSearchParams(location.search);
    if (!params.has('content')) return;
    var raw = params.get('content');
    if (raw == null || raw === '') return;

    // Design Component runtime re-fetches location.href for a pristine
    // x-dc template and would wipe DOM overlays. A truthy __resources map
    // is its bundled/offline signal to skip that refetch. Keep any real map.
    // Do not write an x-dc start tag in this file — parseDcText matches the
    // first one in the fetched HTML and would hit a comment here first.
    if (!window.__resources) window.__resources = {};

    var BLOCK = '${BLOCK_SELECTOR}';
    var applied = false;

    function ownText(el) {
      var clone = el.cloneNode(true);
      clone.querySelectorAll(BLOCK).forEach(function(nested) {
        if (nested !== clone) nested.remove();
      });
      return (clone.textContent || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
    }

    function setOwnText(el, text) {
      // Only touch direct text nodes. Keep element children (svg chevrons, etc.).
      // Prefer the *last* non-whitespace text node so leading whitespace before
      // an <svg> is not turned into the label — that would put text before the
      // icon and break page scripts that replace el.lastChild (lastNode spin).
      var textNodes = [];
      var node = el.firstChild;
      while (node) {
        var next = node.nextSibling;
        if (node.nodeType === 8) el.removeChild(node);
        else if (node.nodeType === 3) textNodes.push(node);
        node = next;
      }
      if (!textNodes.length) {
        el.appendChild(document.createTextNode(text || ''));
        return;
      }
      var target = null;
      for (var i = textNodes.length - 1; i >= 0; i--) {
        if (String(textNodes[i].nodeValue || '').replace(/\\u00a0/g, ' ').trim()) {
          target = textNodes[i];
          break;
        }
      }
      if (!target) target = textNodes[textNodes.length - 1];
      target.nodeValue = text || '';
      for (var j = 0; j < textNodes.length; j++) {
        if (textNodes[j] !== target) el.removeChild(textNodes[j]);
      }
    }

    function slots(root) {
      var out = [];
      root.querySelectorAll(BLOCK).forEach(function(el) {
        if (el.querySelector(BLOCK)) return;
        if (ownText(el)) out.push(el);
      });
      return out;
    }

    function linesFromContent(text) {
      // Same shape as manager "Copy to block": LF-separated plain lines.
      // URLSearchParams already decodes %0A to newlines and + to spaces.
      return String(text || '')
        .replace(/\\u00a0/g, ' ')
        .split(/\\r?\\n/)
        .map(function(l) { return l.replace(/\\s+/g, ' ').trim(); })
        .filter(Boolean);
    }

    function applyOverlay() {
      if (applied) return;
      var root = document.body || document.documentElement;
      if (!root) return;

      var lines = linesFromContent(raw);
      if (!lines.length) return;

      var targets = slots(root);
      // Injected before a <head> script: body is not parsed yet. Wait for it.
      if (!targets.length && document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyOverlay);
        return;
      }

      applied = true;
      var n = Math.min(lines.length, targets.length);
      for (var i = 0; i < n; i++) setOwnText(targets[i], lines[i]);
      document.documentElement.setAttribute('data-wac-content-applied', String(n));
    }

    if (document.body) applyOverlay();
    else if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', applyOverlay);
    } else {
      applyOverlay();
    }
  } catch (e) {
    try { console.error('[wac-content-bridge]', e); } catch (err) {}
  }
})();`;

/**
 * @param {Response} response
 * @param {string} matchedKey
 */
export function maybeInjectContentBridge(response, matchedKey) {
  const type = (response.headers.get('content-type') || '').toLowerCase();
  const isHtml = type.includes('text/html')
    || /\.html?$/i.test(matchedKey);
  if (!isHtml) return response;

  const tag = `<script data-wac-content-bridge="1">${CONTENT_BRIDGE_SCRIPT}</script>`;
  let injected = false;

  return new HTMLRewriter()
    // Run before the first page script so the initial DOM is already overlaid
    // when page JS reads text / starts animations.
    .on('script', {
      element(element) {
        if (injected) return;
        if (element.getAttribute('data-wac-content-bridge')) return;
        injected = true;
        element.before(tag, { html: true });
      },
    })
    // Fallback for HTML with no scripts.
    .on('body', {
      element(element) {
        element.onEndTag((end) => {
          if (injected) return;
          injected = true;
          end.before(tag, { html: true });
        });
      },
    })
    .transform(response);
}
