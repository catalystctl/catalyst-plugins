// Minimal JSON file store with atomic writes. Synchronous is fine for an example.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function emptyStore() {
  return { keys: {} };
}

export function loadStore(dataFile) {
  let raw;
  try {
    raw = readFileSync(dataFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return emptyStore();
    throw err;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.keys !== 'object' || parsed.keys === null) {
    throw new Error(`corrupt data file: ${dataFile}`);
  }
  return parsed;
}

// Write to dataFile.tmp, then rename over the target: readers never see a torn file.
export function saveStore(dataFile, store) {
  mkdirSync(dirname(dataFile), { recursive: true });
  const tmp = `${dataFile}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, dataFile);
}

// Load, let fn mutate the store in place, save it back.
export function withStore(dataFile, fn) {
  const store = loadStore(dataFile);
  const result = fn(store);
  saveStore(dataFile, store);
  return result;
}
