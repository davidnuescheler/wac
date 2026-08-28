/**
 * Inject a client script into HTML responses that:
 *  1. Applies ?content= overlays (newline-separated plain text → leaf slots)
 *  2. Posts intrinsic document height to the parent frame via postMessage
 *
 * For Design Component pages with ?content=, also seeds window.__resources so
 * DC skips its pristine-source refetch of location.href (which would wipe the
 * overlay). Do not put an x-dc start tag in comments — parseDcText would match it.
 *
 * Height reporting runs even without ?content=, whenever this document is framed.
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
    var raw = params.has('content') ? params.get('content') : null;
    var hasContent = raw != null && raw !== '';

    if (hasContent && !window.__resources) {
      // Bundled/offline signal for DC runtime: skip pristine-source refetch.
      window.__resources = {};
    }

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
      return String(text || '')
        .replace(/\\u00a0/g, ' ')
        .split(/\\r?\\n/)
        .map(function(l) { return l.replace(/\\s+/g, ' ').trim(); })
        .filter(Boolean);
    }

    function applyOverlay() {
      if (!hasContent || applied) return;
      var root = document.body || document.documentElement;
      if (!root) return;

      var lines = linesFromContent(raw);
      if (!lines.length) return;

      var targets = slots(root);
      if (!targets.length && document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyOverlay);
        return;
      }

      applied = true;
      var n = Math.min(lines.length, targets.length);
      for (var i = 0; i < n; i++) setOwnText(targets[i], lines[i]);
      document.documentElement.setAttribute('data-wac-content-applied', String(n));
      emitHeight();
    }

    function measureHeight() {
      var doc = document.documentElement;
      var body = document.body;
      var h = 0;
      if (doc) {
        h = Math.max(h, doc.scrollHeight || 0, doc.offsetHeight || 0);
      }
      if (body) {
        h = Math.max(h, body.scrollHeight || 0, body.offsetHeight || 0);
      }
      return h;
    }

    var lastHeight = -1;
    var heightTimer = 0;

    function emitHeight() {
      if (!window.parent || window.parent === window) return;
      var height = measureHeight();
      if (!height || height === lastHeight) return;
      lastHeight = height;
      try {
        window.parent.postMessage({
          source: 'wac',
          type: 'intrinsic-height',
          height: height,
          href: String(location.href),
        }, '*');
      } catch (err) {}
    }

    function scheduleEmitHeight() {
      if (heightTimer) clearTimeout(heightTimer);
      heightTimer = setTimeout(function() {
        heightTimer = 0;
        emitHeight();
      }, 50);
    }

    function startHeightReporter() {
      if (!window.parent || window.parent === window) return;
      emitHeight();
      if (typeof ResizeObserver === 'function') {
        var ro = new ResizeObserver(scheduleEmitHeight);
        if (document.documentElement) ro.observe(document.documentElement);
        if (document.body) ro.observe(document.body);
      }
      window.addEventListener('load', scheduleEmitHeight);
      window.addEventListener('resize', scheduleEmitHeight);
      if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
        document.fonts.ready.then(scheduleEmitHeight).catch(function() {});
      }
      // Late layout from framed runtimes (e.g. DC React boot).
      setTimeout(scheduleEmitHeight, 0);
      setTimeout(scheduleEmitHeight, 250);
      setTimeout(scheduleEmitHeight, 1000);
    }

    if (hasContent) {
      if (document.body) applyOverlay();
      else if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyOverlay);
      } else {
        applyOverlay();
      }
    }

    if (document.body) startHeightReporter();
    else if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startHeightReporter);
    } else {
      startHeightReporter();
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
