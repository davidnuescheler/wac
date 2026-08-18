/**
 * Unzip an uploaded archive into an R2 prefix.
 */

import { unzipSync } from 'fflate';
import { contentTypeFor } from './mime.js';

/**
 * @param {Uint8Array} zipBytes
 * @returns {{ entries: Record<string, Uint8Array>, files: string[], skipped: string[] }}
 */
export function analyzeZip(zipBytes) {
  let raw;
  try {
    raw = unzipSync(zipBytes, {
      filter(file) {
        if (file.name.endsWith('/')) return false;
        if (file.name.startsWith('__MACOSX/')) return false;
        if (file.name.split('/').pop() === '.DS_Store') return false;
        return true;
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid_zip: ${message}`);
  }

  const names = Object.keys(raw);
  if (names.length === 0) {
    throw new Error('empty_zip');
  }

  const rootPrefix = commonRootDirectory(names);
  /** @type {Record<string, Uint8Array>} */
  const entries = {};
  const files = [];
  const skipped = [];

  for (const name of names) {
    let relative = name;
    if (rootPrefix && relative.startsWith(rootPrefix)) {
      relative = relative.slice(rootPrefix.length);
    }
    relative = relative.replace(/^\/+/, '');

    if (!relative || relative.endsWith('/')) {
      skipped.push(name);
      continue;
    }

    const parts = relative.split('/');
    if (parts.some((p) => p === '' || p === '.' || p === '..')) {
      skipped.push(name);
      continue;
    }

    if (parts[0] === '.wac') {
      skipped.push(name);
      continue;
    }

    const path = parts.join('/');
    entries[path] = raw[name];
    files.push(path);
  }

  if (files.length === 0) {
    throw new Error('empty_zip');
  }

  return { entries, files, skipped };
}

/**
 * @param {R2Bucket} bucket
 * @param {string} prefix  e.g. acme/docs/widget
 * @param {Uint8Array} zipBytes
 * @returns {Promise<{ files: string[], skipped: string[] }>}
 */
export async function extractZipToPrefix(bucket, prefix, zipBytes) {
  const { entries, files, skipped } = analyzeZip(zipBytes);
  const puts = Object.entries(entries).map(([path, data]) => {
    const key = `${prefix}/${path}`;
    return bucket.put(key, data, {
      httpMetadata: {
        contentType: contentTypeFor(key),
      },
      customMetadata: {
        source: 'wac-upload',
      },
    });
  });

  const concurrency = 8;
  for (let i = 0; i < puts.length; i += concurrency) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(puts.slice(i, i + concurrency));
  }

  return { files, skipped };
}

/**
 * @param {string[]} names
 */
function commonRootDirectory(names) {
  if (names.length === 0) return '';
  const first = names[0].split('/')[0];
  if (!first) return '';
  const prefix = `${first}/`;
  if (names.every((n) => n.startsWith(prefix))) return prefix;
  return '';
}
