import { unzipSync } from 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js';

const STORAGE_KEY = 'wac-manager-v2';
const LEGACY_SESSION_KEY = 'wac-manager-session-v1';
const DEFAULT_ENDPOINT = 'https://wac.david8603.workers.dev';
const ADD_NEW = '__add_new__';

const ui = {
  signin: document.getElementById('signin'),
  signinForm: document.getElementById('signin-form'),
  signinError: document.getElementById('signin-error'),
  email: document.getElementById('email'),
  token: document.getElementById('token'),
  siteSelect: document.getElementById('site-select'),
  siteSelectLabel: document.getElementById('site-select-label'),
  newSiteFields: document.getElementById('new-site-fields'),
  org: document.getElementById('org'),
  site: document.getElementById('site'),
  app: document.getElementById('app'),
  sessionLabel: document.getElementById('session-label'),
  tree: document.getElementById('tree'),
  listStatus: document.getElementById('list-status'),
  preview: document.getElementById('preview'),
  previewEmpty: document.getElementById('preview-empty'),
  previewPath: document.getElementById('preview-path'),
  btnOpen: document.getElementById('btn-open'),
  contentText: document.getElementById('content-text'),
  contentStatus: document.getElementById('content-status'),
  btnCopyBlock: document.getElementById('btn-copy-block'),
  btnRefresh: document.getElementById('btn-refresh'),
  btnUpload: document.getElementById('btn-upload'),
  btnReplace: document.getElementById('btn-replace'),
  btnDelete: document.getElementById('btn-delete'),
  btnSwitchSite: document.getElementById('btn-switch-site'),
  btnSignout: document.getElementById('btn-signout'),
  modal: document.getElementById('upload-modal'),
  uploadForm: document.getElementById('upload-form'),
  uploadTitle: document.getElementById('upload-title'),
  uploadIntent: document.getElementById('upload-intent'),
  wacPath: document.getElementById('wac-path'),
  dropzone: document.getElementById('dropzone'),
  dropzoneTitle: document.getElementById('dropzone-title'),
  dropzoneSub: document.getElementById('dropzone-sub'),
  dropzoneFile: document.getElementById('dropzone-file'),
  zipFile: document.getElementById('zip-file'),
  zipDetails: document.getElementById('zip-details'),
  zipSummary: document.getElementById('zip-summary'),
  defaultPicker: document.getElementById('default-picker'),
  defaultAsset: document.getElementById('default-asset'),
  fileList: document.getElementById('file-list'),
  uploadStatus: document.getElementById('upload-status'),
  uploadCancel: document.getElementById('upload-cancel'),
  uploadSubmit: document.getElementById('upload-submit'),
  pageDrop: document.getElementById('page-drop'),
  pageDropTitle: document.getElementById('page-drop-title'),
  pageDropSub: document.getElementById('page-drop-sub'),
};

/** @type {{ endpoint: string, org: string, site: string, email: string, token: string } | null} */
let session = null;
/** @type {Array<any>} */
let wacs = [];
/** @type {string | null} */
let selectedPath = null;
/** @type {string | null} */
let previewBaseUrl = null;
/** @type {{ files: string[], hasIndex: boolean, bytes: Uint8Array, name?: string } | null} */
let pendingZip = null;
let replaceMode = false;
let dragDepth = 0;
let contentLoadToken = 0;
let contentReloadTimer = 0;

/**
 * @returns {{
 *   email: string,
 *   token: string,
 *   lastOrg: string,
 *   lastSite: string,
 *   sites: Array<{ org: string, site: string, lastUsed: string }>
 * }}
 */
function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        email: parsed.email || '',
        token: parsed.token || '',
        lastOrg: parsed.lastOrg || '',
        lastSite: parsed.lastSite || '',
        sites: Array.isArray(parsed.sites) ? parsed.sites : [],
      };
    }
  } catch {
    // fall through to legacy
  }

  // Migrate short-lived sessionStorage if present
  try {
    const legacy = sessionStorage.getItem(LEGACY_SESSION_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy);
      const migrated = {
        email: parsed.email || '',
        token: parsed.token || '',
        lastOrg: parsed.org || '',
        lastSite: parsed.site || '',
        sites: (parsed.org && parsed.site)
          ? [{ org: parsed.org, site: parsed.site, lastUsed: new Date().toISOString() }]
          : [],
      };
      saveStore(migrated);
      sessionStorage.removeItem(LEGACY_SESSION_KEY);
      return migrated;
    }
  } catch {
    // ignore
  }

  return { email: '', token: '', lastOrg: '', lastSite: '', sites: [] };
}

function saveStore(store) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function rememberAuthAndSite({ email, token, org, site }) {
  const store = loadStore();
  store.email = email;
  store.token = token;
  store.lastOrg = org;
  store.lastSite = site;
  const key = `${org}/${site}`;
  store.sites = [
    { org, site, lastUsed: new Date().toISOString() },
    ...store.sites.filter((s) => `${s.org}/${s.site}` !== key),
  ].slice(0, 20);
  saveStore(store);
}

function clearAuth() {
  const store = loadStore();
  store.email = '';
  store.token = '';
  // keep site recents
  saveStore(store);
}

function siteKey(org, site) {
  return `${org}/${site}`;
}

function renderSiteSelect(preferred = '') {
  const store = loadStore();
  const sites = [...store.sites].sort((a, b) => (b.lastUsed || '').localeCompare(a.lastUsed || ''));
  const options = [];

  if (sites.length) {
    options.push(...sites.map((s) => {
      const value = siteKey(s.org, s.site);
      return `<option value="${escapeAttr(value)}">/${escapeHtml(value)}</option>`;
    }));
  }
  options.push(`<option value="${ADD_NEW}">Add new site…</option>`);

  ui.siteSelect.innerHTML = options.join('');

  let selected = preferred;
  if (!selected && store.lastOrg && store.lastSite) {
    selected = siteKey(store.lastOrg, store.lastSite);
  }
  if (selected && [...ui.siteSelect.options].some((o) => o.value === selected)) {
    ui.siteSelect.value = selected;
  } else if (sites.length) {
    ui.siteSelect.value = siteKey(sites[0].org, sites[0].site);
  } else {
    ui.siteSelect.value = ADD_NEW;
  }

  syncNewSiteFields();
}

function syncNewSiteFields() {
  const adding = ui.siteSelect.value === ADD_NEW || !ui.siteSelect.value;
  ui.newSiteFields.classList.toggle('hidden', !adding);
  ui.org.required = adding;
  ui.site.required = adding;
  if (adding) {
    ui.org.focus();
  }
}

function resolveOrgSite() {
  if (ui.siteSelect.value === ADD_NEW || !ui.siteSelect.value) {
    return {
      org: ui.org.value.trim(),
      site: ui.site.value.trim(),
    };
  }
  const [org, ...rest] = ui.siteSelect.value.split('/');
  return { org, site: rest.join('/') };
}

function fillSigninForm() {
  const store = loadStore();
  ui.email.value = store.email || '';
  ui.token.value = store.token || '';
  ui.org.value = '';
  ui.site.value = '';
  renderSiteSelect(
    store.lastOrg && store.lastSite ? siteKey(store.lastOrg, store.lastSite) : '',
  );
}

function apiBase() {
  return session.endpoint.replace(/\/+$/, '');
}

function authHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${session.token}`,
    'X-WAC-Author': session.email,
    ...extra,
  };
}

async function api(path, options = {}) {
  const res = await fetch(`${apiBase()}${path}`, {
    ...options,
    headers: {
      ...authHeaders(options.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data?.message || data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function showApp() {
  ui.signin.classList.add('hidden');
  ui.app.classList.remove('hidden');
  ui.sessionLabel.textContent = `${session.email} · /${session.org}/${session.site}`;
}

function showSignin({ clearCredentials = false } = {}) {
  ui.app.classList.add('hidden');
  ui.signin.classList.remove('hidden');
  session = null;
  wacs = [];
  selectedPath = null;
  ui.signinError.textContent = '';
  if (clearCredentials) clearAuth();
  fillSigninForm();
}

async function signInWith({ email, token, org, site }) {
  if (!email || !token || !org || !site) {
    throw new Error('Email, token, org, and site are required');
  }
  session = {
    endpoint: DEFAULT_ENDPOINT,
    email,
    token,
    org,
    site,
  };
  await api(`/${session.org}/${session.site}/index.json`);
  rememberAuthAndSite({ email, token, org, site });
  showApp();
  await refreshList();
}

function buildTree(items) {
  const root = { name: '', children: new Map(), wac: null };
  for (const wac of items) {
    const parts = wac.path.split('/');
    let node = root;
    parts.forEach((part, i) => {
      if (!node.children.has(part)) {
        node.children.set(part, { name: part, children: new Map(), wac: null });
      }
      node = node.children.get(part);
      if (i === parts.length - 1) node.wac = wac;
    });
  }
  return root;
}

function renderTree() {
  ui.tree.innerHTML = '';
  if (!wacs.length) {
        ui.tree.innerHTML = '<div class="tree-empty">No Web Asset Containers yet. Upload a zip to create one.</div>';
    return;
  }

  const root = buildTree(wacs);

  function renderNode(node, container) {
    const entries = [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [, child] of entries) {
      if (child.wac && child.children.size === 0) {
        container.appendChild(wacButton(child.wac));
        continue;
      }
      const details = document.createElement('details');
      details.open = true;
      const summary = document.createElement('summary');
      summary.textContent = child.name;
      details.appendChild(summary);
      if (child.wac) details.appendChild(wacButton(child.wac));
      const nested = document.createElement('div');
      renderNode(child, nested);
      details.appendChild(nested);
      container.appendChild(details);
    }
  }

  renderNode(root, ui.tree);
}

function wacButton(wac) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `wac-item${selectedPath === wac.path ? ' active' : ''}`;
  btn.dataset.path = wac.path;
  const label = document.createElement('span');
  label.textContent = wac.path.split('/').pop();
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = Number.isFinite(wac.zipSize) ? formatBytes(wac.zipSize) : '';
  btn.append(label, meta);
  btn.addEventListener('click', () => selectWac(wac.path));
  return btn;
}

function selectWac(path) {
  selectedPath = path;
  const wac = wacs.find((w) => w.path === path);
  ui.btnReplace.disabled = !wac;
  ui.btnDelete.disabled = !wac;
  ui.btnOpen.disabled = !wac;
  ui.btnCopyBlock.disabled = true;
  ui.btnCopyBlock.textContent = 'Copy block';
  renderTree();
  window.clearTimeout(contentReloadTimer);
  contentLoadToken += 1;
  const token = contentLoadToken;

  if (!wac) {
    previewBaseUrl = null;
    ui.preview.classList.add('hidden');
    ui.previewEmpty.classList.remove('hidden');
    ui.previewPath.textContent = 'Select a container to preview';
    ui.preview.removeAttribute('src');
    ui.contentText.value = '';
    ui.contentText.disabled = true;
    ui.contentStatus.textContent = '';
    return;
  }

  const url = `${apiBase()}${wac.url}`;
  previewBaseUrl = url;
  ui.previewPath.textContent = url;
  ui.previewEmpty.classList.add('hidden');
  ui.preview.classList.remove('hidden');
  ui.contentText.disabled = true;
  ui.contentText.value = '';
  ui.contentStatus.textContent = 'Loading…';
  ui.contentStatus.className = 'status';
  ui.preview.src = url;

  loadWacContentText(wac).then((text) => {
    if (token !== contentLoadToken) return;
    ui.contentText.value = text;
    ui.contentText.disabled = false;
    ui.btnCopyBlock.disabled = false;
    ui.contentStatus.textContent = '';
  }).catch((err) => {
    if (token !== contentLoadToken) return;
    ui.contentText.value = '';
    ui.contentText.disabled = false;
    ui.btnCopyBlock.disabled = false;
    ui.contentStatus.textContent = 'Load failed';
    ui.contentStatus.className = 'status bad';
    console.error(err);
  });
}

/**
 * @param {string} text
 */
function applyContentPreview(text) {
  if (!previewBaseUrl) return;
  const trimmed = String(text || '');
  if (!trimmed.trim()) {
    ui.preview.src = previewBaseUrl;
    return;
  }
  const next = new URL(previewBaseUrl);
  next.searchParams.set('content', trimmed);
  ui.preview.src = next.href;
}

function scheduleContentPreview() {
  window.clearTimeout(contentReloadTimer);
  contentReloadTimer = window.setTimeout(() => {
    applyContentPreview(ui.contentText.value);
  }, 350);
}

async function refreshList() {
  ui.listStatus.textContent = 'Loading…';
  try {
    const data = await api(`/${session.org}/${session.site}/index.json`);
    wacs = data.wacs || [];
    ui.listStatus.textContent = `${data.count || 0} container${(data.count || 0) === 1 ? '' : 's'}`;
    if (selectedPath && !wacs.some((w) => w.path === selectedPath)) {
      selectedPath = null;
      selectWac(null);
    }
    renderTree();
    if (selectedPath) selectWac(selectedPath);
  } catch (err) {
    ui.listStatus.textContent = 'Failed';
    ui.listStatus.classList.add('bad');
    throw err;
  }
}

function siteRoot() {
  return `/${session.org}/${session.site}`;
}

function updateIntent() {
  const path = ui.wacPath.value.trim().replace(/^\/+|\/+$/g, '');
  if (replaceMode) {
    ui.uploadIntent.className = 'intent replace';
    ui.uploadIntent.classList.remove('hidden');
    ui.uploadIntent.innerHTML = `Replace <code>${escapeHtml(`${siteRoot()}/${path || selectedPath || '…'}/`)}</code>`;
    ui.uploadSubmit.textContent = 'Replace';
    ui.uploadTitle.textContent = 'Replace';
  } else {
    ui.uploadIntent.className = 'intent hidden';
    ui.uploadIntent.textContent = '';
    ui.uploadSubmit.textContent = 'Upload';
    ui.uploadTitle.textContent = 'Upload';
  }
}

function resetDropzone() {
  ui.dropzone.classList.remove('has-file', 'dragover');
  ui.dropzoneTitle.textContent = 'Drop a .zip here';
  ui.dropzoneSub.textContent = 'or click to choose';
  ui.dropzoneFile.classList.add('hidden');
  ui.dropzoneFile.textContent = '';
}

function showPageDrop(visible) {
  ui.pageDrop.classList.toggle('visible', visible);
  ui.pageDrop.setAttribute('aria-hidden', visible ? 'false' : 'true');
  if (!visible || !session) return;
  ui.pageDropTitle.textContent = 'Drop to upload';
  ui.pageDropSub.textContent = `${siteRoot()}/drafts/${draftUserFromEmail(session.email)}/<zip-name>/`;
}

function isZipFile(file) {
  if (!file) return false;
  const name = (file.name || '').toLowerCase();
  return name.endsWith('.zip')
    || file.type === 'application/zip'
    || file.type === 'application/x-zip-compressed';
}

function kebabFromZipName(filename) {
  const base = String(filename || '')
    .replace(/\.zip$/i, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'container';
}

function draftUserFromEmail(email) {
  const local = String(email || '')
    .split('@')[0]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return local || 'user';
}

function defaultUploadPath(zipFilename) {
  return `drafts/${draftUserFromEmail(session?.email)}/${kebabFromZipName(zipFilename)}`;
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function openUploadModal({ replace = false, file = null } = {}) {
  replaceMode = replace;
  pendingZip = null;
  ui.uploadForm.reset();
  ui.zipDetails.classList.add('hidden');
  ui.zipDetails.open = false;
  ui.zipSummary.textContent = '';
  ui.fileList.textContent = '';
  ui.defaultPicker.classList.add('hidden');
  ui.defaultAsset.innerHTML = '';
  ui.uploadStatus.textContent = '';
  ui.uploadStatus.className = 'status';
  resetDropzone();
  if (replace && selectedPath) {
    ui.wacPath.value = selectedPath;
    ui.wacPath.readOnly = true;
  } else {
    ui.wacPath.readOnly = false;
    ui.wacPath.value = '';
  }
  updateIntent();
  ui.modal.classList.remove('hidden');
  if (file) {
    acceptZipFile(file);
  } else {
    ui.dropzone.focus();
  }
}

function closeUploadModal() {
  ui.modal.classList.add('hidden');
  pendingZip = null;
  resetDropzone();
  showPageDrop(false);
  dragDepth = 0;
}

async function acceptZipFile(file) {
  pendingZip = null;
  ui.defaultPicker.classList.add('hidden');
  ui.zipDetails.classList.add('hidden');
  ui.zipDetails.open = false;
  ui.fileList.textContent = '';
  ui.uploadStatus.textContent = '';
  ui.uploadStatus.className = 'status';

  if (!isZipFile(file)) {
    resetDropzone();
    ui.uploadStatus.textContent = 'Not a zip file';
    ui.uploadStatus.className = 'status bad';
    return;
  }

  try {
    const inspected = await inspectZip(file);
    pendingZip = { ...inspected, name: file.name };
    ui.dropzone.classList.add('has-file');
    ui.dropzoneTitle.textContent = file.name;
    ui.dropzoneSub.textContent = '';
    ui.dropzoneFile.classList.add('hidden');

    if (!replaceMode && !ui.wacPath.readOnly) {
      ui.wacPath.value = defaultUploadPath(file.name);
      updateIntent();
    }

    const n = inspected.files.length;
    ui.zipSummary.textContent = `${n} file${n === 1 ? '' : 's'} · ${formatBytes(inspected.extractedBytes)}`;
    ui.fileList.textContent = inspected.files.join('\n');
    ui.zipDetails.classList.remove('hidden');

    if (!inspected.hasIndex) {
      populateDefaultPicker(inspected.files);
    }
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      ui.zipFile.files = dt.files;
    } catch {
      // pendingZip is enough when FileList assignment is blocked
    }
  } catch (err) {
    resetDropzone();
    ui.uploadStatus.textContent = err.message || 'Invalid zip';
    ui.uploadStatus.className = 'status bad';
  }
}

function commonRoot(files) {
  if (!files.length) return '';
  const first = files[0].split('/')[0];
  if (!first) return '';
  const prefix = `${first}/`;
  return files.every((f) => f.startsWith(prefix)) ? prefix : '';
}

async function inspectZip(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const entries = unzipSync(buf, {
    filter(fileInfo) {
      return !fileInfo.name.endsWith('/')
        && !fileInfo.name.startsWith('__MACOSX/')
        && fileInfo.name.split('/').pop() !== '.DS_Store';
    },
  });

  const rootPrefix = commonRoot(Object.keys(entries).map((n) => n.replace(/^\/+/, '')));
  const files = [];
  let extractedBytes = 0;

  for (const name of Object.keys(entries)) {
    let relative = name.replace(/^\/+/, '');
    if (rootPrefix && relative.startsWith(rootPrefix)) {
      relative = relative.slice(rootPrefix.length);
    }
    if (!relative || relative.split('/').includes('.wac')) continue;
    if (relative.split('/').some((p) => p === '' || p === '.' || p === '..')) continue;
    files.push(relative);
    extractedBytes += entries[name]?.byteLength || 0;
  }

  files.sort((a, b) => a.localeCompare(b));
  if (!files.length) throw new Error('Zip has no usable files');

  const hasIndex = files.some((f) => {
    const lower = f.toLowerCase();
    return lower === 'index.html' || lower === 'index.htm';
  });
  return { files, hasIndex, bytes: buf, extractedBytes };
}

function populateDefaultPicker(files) {
  const htmlFiles = files.filter((f) => /\.html?$/i.test(f));
  if (!htmlFiles.length) {
    ui.defaultPicker.classList.add('hidden');
    ui.defaultAsset.innerHTML = '';
    ui.uploadStatus.textContent = 'No index.html — zip needs at least one .html file for a default page';
    ui.uploadStatus.className = 'status bad';
    return;
  }
  ui.defaultAsset.innerHTML = htmlFiles.map((f) => `<option value="${escapeAttr(f)}">${escapeHtml(f)}</option>`).join('');
  ui.defaultPicker.classList.remove('hidden');
  ui.uploadStatus.textContent = '';
  ui.uploadStatus.className = 'status';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, '&#96;');
}

ui.signinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  ui.signinError.textContent = '';
  const { org, site } = resolveOrgSite();
  try {
    await signInWith({
      email: ui.email.value.trim().toLowerCase(),
      token: ui.token.value,
      org,
      site,
    });
  } catch (err) {
    session = null;
    ui.signinError.textContent = err.message || 'Sign-in failed';
  }
});

ui.siteSelect.addEventListener('change', syncNewSiteFields);

ui.btnSignout.addEventListener('click', () => {
  showSignin({ clearCredentials: true });
});

ui.btnSwitchSite.addEventListener('click', () => {
  showSignin({ clearCredentials: false });
});

ui.btnRefresh.addEventListener('click', () => {
  refreshList().catch((err) => {
    ui.listStatus.textContent = err.message;
  });
});

ui.btnUpload.addEventListener('click', () => openUploadModal({ replace: false }));
ui.btnReplace.addEventListener('click', () => openUploadModal({ replace: true }));
ui.uploadCancel.addEventListener('click', closeUploadModal);
ui.modal.addEventListener('click', (e) => {
  if (e.target === ui.modal) closeUploadModal();
});
ui.wacPath.addEventListener('input', updateIntent);

ui.zipFile.addEventListener('change', async () => {
  const file = ui.zipFile.files?.[0];
  if (!file) {
    pendingZip = null;
    resetDropzone();
    ui.zipDetails.classList.add('hidden');
    ui.defaultPicker.classList.add('hidden');
    return;
  }
  await acceptZipFile(file);
});

['dragenter', 'dragover'].forEach((type) => {
  ui.dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    e.stopPropagation();
    ui.dropzone.classList.add('dragover');
  });
});
ui.dropzone.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (!ui.dropzone.contains(e.relatedTarget)) {
    ui.dropzone.classList.remove('dragover');
  }
});
ui.dropzone.addEventListener('drop', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  ui.dropzone.classList.remove('dragover');
  const file = e.dataTransfer?.files?.[0];
  if (file) await acceptZipFile(file);
});

function hasFilePayload(e) {
  return [...(e.dataTransfer?.types || [])].includes('Files');
}

window.addEventListener('dragenter', (e) => {
  if (!session || ui.app.classList.contains('hidden') || !hasFilePayload(e)) return;
  e.preventDefault();
  dragDepth += 1;
  if (!ui.modal.classList.contains('hidden')) return;
  showPageDrop(true);
});
window.addEventListener('dragover', (e) => {
  if (!session || ui.app.classList.contains('hidden') || !hasFilePayload(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (!session || ui.app.classList.contains('hidden')) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) showPageDrop(false);
});
window.addEventListener('drop', async (e) => {
  if (!session || ui.app.classList.contains('hidden')) return;
  const inModal = !ui.modal.classList.contains('hidden');
  dragDepth = 0;
  showPageDrop(false);
  if (inModal) return; // modal dropzone handles it
  if (!hasFilePayload(e)) return;
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
      openUploadModal({
        replace: false,
        file,
      });
});

ui.btnOpen.addEventListener('click', () => {
  if (!previewBaseUrl) return;
  const text = ui.contentText.value;
  if (text.trim()) {
    const next = new URL(previewBaseUrl);
    next.searchParams.set('content', text);
    window.open(next.href, '_blank', 'noopener');
    return;
  }
  window.open(previewBaseUrl, '_blank', 'noopener');
});

ui.contentText.addEventListener('input', () => {
  if (!previewBaseUrl || ui.contentText.disabled) return;
  ui.contentStatus.textContent = '';
  ui.contentStatus.className = 'status';
  scheduleContentPreview();
});

ui.btnCopyBlock.addEventListener('click', async () => {
  if (!previewBaseUrl) return;
  ui.btnCopyBlock.disabled = true;
  ui.btnCopyBlock.textContent = 'Copying…';
  try {
    const { html, plain } = buildMagicBannerClipboard(ui.contentText.value, previewBaseUrl);
    await copyRichClipboard(html, plain);
    ui.btnCopyBlock.textContent = 'Copied';
    ui.contentStatus.textContent = '';
    ui.contentStatus.className = 'status';
    setTimeout(() => {
      ui.btnCopyBlock.textContent = 'Copy block';
      ui.btnCopyBlock.disabled = !previewBaseUrl;
    }, 1200);
  } catch (err) {
    ui.btnCopyBlock.textContent = 'Copy failed';
    ui.contentStatus.textContent = err.message || 'Copy failed';
    ui.contentStatus.className = 'status bad';
    ui.btnCopyBlock.disabled = !previewBaseUrl;
    setTimeout(() => {
      if (ui.btnCopyBlock.textContent === 'Copy failed') {
        ui.btnCopyBlock.textContent = 'Copy block';
      }
    }, 1500);
  }
});

const MAGIC_BANNER_BLOCK = 'magic-banner';

/**
 * Build DA / Google Docs paste payload: single-column block table.
 * @param {string} content
 * @param {string} url base WAC URL without ?content=
 */
function buildMagicBannerClipboard(content, url) {
  const bodyText = `${String(content || '').replace(/\s+$/g, '')}\n\n${url}`;
  const plain = `${MAGIC_BANNER_BLOCK}\n${bodyText}`;

  const linesHtml = String(content || '')
    .replace(/\s+$/g, '')
    .split(/\r\n|\r|\n/)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('');
  const link = `<p><a href="${escapeAttr(url)}">${escapeHtml(url)}</a></p>`;
  const cellHtml = `${linesHtml}${link}`;

  // text/html table pastes as a real table in Google Docs and DA.
  const html = `<table>
  <thead>
    <tr><th>${MAGIC_BANNER_BLOCK}</th></tr>
  </thead>
  <tbody>
    <tr><td>${cellHtml}</td></tr>
  </tbody>
</table>`;

  return { html, plain };
}

/**
 * Put HTML + plain text on the clipboard so Docs/DA keep the table.
 * @param {string} html
 * @param {string} plain
 */
async function copyRichClipboard(html, plain) {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    const item = new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([plain], { type: 'text/plain' }),
    });
    await navigator.clipboard.write([item]);
    return;
  }

  // Fallback for environments without ClipboardItem write support.
  const host = document.createElement('div');
  host.setAttribute('contenteditable', 'true');
  host.style.cssText = 'position:fixed;left:-9999px;top:0;';
  host.innerHTML = html;
  document.body.appendChild(host);
  const range = document.createRange();
  range.selectNodeContents(host);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const ok = document.execCommand('copy');
  sel.removeAllRanges();
  host.remove();
  if (!ok) throw new Error('Clipboard unavailable');
}

/**
 * Fetch HTML from a WAC and flatten visible text into plain lines for the content panel.
 * @param {{ url: string, files?: string[] | null, default?: string | null }} wac
 */
async function loadWacContentText(wac) {
  const htmlPaths = [];
  const listed = Array.isArray(wac.files) ? wac.files : [];
  for (const file of listed) {
    if (/\.html?$/i.test(file)) htmlPaths.push(file);
  }
  if (!htmlPaths.length) {
    const rootHtml = await fetchHtml(`${apiBase()}${wac.url}`);
    return htmlToPlainLines(rootHtml).join('\n');
  }

  htmlPaths.sort((a, b) => {
    const rank = (p) => {
      const lower = p.toLowerCase();
      if (lower === 'index.html' || lower === 'index.htm') return 0;
      if (wac.default && p === wac.default) return 1;
      return 2;
    };
    const d = rank(a) - rank(b);
    return d !== 0 ? d : a.localeCompare(b);
  });

  const lineSets = [];
  for (const path of htmlPaths) {
    // eslint-disable-next-line no-await-in-loop
    const html = await fetchHtml(`${apiBase()}${wac.url}${path}`);
    const lines = htmlToPlainLines(html);
    if (lines.length) lineSets.push(lines);
  }
  return lineSets.map((lines) => lines.join('\n')).join('\n\n');
}

async function fetchHtml(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Failed to fetch ${url} (${res.status})`);
  return res.text();
}

function htmlToPlainLines(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, noscript, template, svg').forEach((el) => el.remove());
  const root = doc.body || doc.documentElement;
  if (!root) return [];

  // Keep in sync with service/src/content-bridge.js BLOCK_SELECTOR
  const blockSelector = [
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'li', 'dt', 'dd', 'blockquote', 'pre', 'figcaption',
    'th', 'td', 'caption', 'summary', 'address',
    'span', 'div', 'a', 'label', 'button',
  ].join(',');

  const lines = [];
  const blocks = root.querySelectorAll(blockSelector);
  blocks.forEach((el) => {
    // Leaf slots only (same rule as content-bridge.js)
    if (el.querySelector(blockSelector)) return;
    const clone = el.cloneNode(true);
    clone.querySelectorAll(blockSelector).forEach((nested) => {
      if (nested !== clone) nested.remove();
    });
    const text = (clone.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) lines.push(text);
  });

  if (!lines.length) {
    return (root.textContent || '')
      .replace(/\u00a0/g, ' ')
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }
  return lines;
}

ui.btnDelete.addEventListener('click', async () => {
  if (!selectedPath) return;
  if (!confirm(`Delete /${session.org}/${session.site}/${selectedPath}/ ?`)) return;
  try {
    await api(`/${session.org}/${session.site}/${selectedPath}.wac`, { method: 'DELETE' });
    selectedPath = null;
    selectWac(null);
    await refreshList();
  } catch (err) {
    alert(err.message || 'Delete failed');
  }
});

ui.uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const path = ui.wacPath.value.trim().replace(/^\/+|\/+$/g, '');
  if (!pendingZip) {
    ui.uploadStatus.textContent = 'Drop or choose a valid zip first';
    ui.uploadStatus.className = 'status bad';
    return;
  }
  if (!pendingZip.hasIndex && !ui.defaultAsset.value) {
    ui.uploadStatus.textContent = 'Pick a default page';
    ui.uploadStatus.className = 'status bad';
    return;
  }

  ui.uploadSubmit.disabled = true;
  ui.uploadStatus.textContent = replaceMode
    ? `Replacing ${siteRoot()}/${path}/…`
    : `Uploading to ${siteRoot()}/${path}/…`;
  ui.uploadStatus.className = 'status';
  try {
    const headers = {
      'Content-Type': 'application/zip',
    };
    if (!pendingZip.hasIndex) {
      headers['X-WAC-Default'] = ui.defaultAsset.value;
    }
    const data = await api(`/${session.org}/${session.site}/${path}.wac`, {
      method: 'POST',
      headers,
      body: pendingZip.bytes,
    });
    ui.uploadStatus.textContent = replaceMode
      ? `Replaced ${data.prefix}`
      : `Uploaded ${data.prefix}`;
    ui.uploadStatus.className = 'status ok';
    closeUploadModal();
    selectedPath = path;
    await refreshList();
    selectWac(path);
  } catch (err) {
    ui.uploadStatus.textContent = err.message || 'Upload failed';
    ui.uploadStatus.className = 'status bad';
  } finally {
    ui.uploadSubmit.disabled = false;
  }
});

// Boot
fillSigninForm();
const store = loadStore();
if (store.email && store.token && store.lastOrg && store.lastSite) {
  signInWith({
    email: store.email,
    token: store.token,
    org: store.lastOrg,
    site: store.lastSite,
  }).catch(() => {
    showSignin({ clearCredentials: false });
  });
}
