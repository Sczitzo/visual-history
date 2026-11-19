export const IMAGE_LIMIT = 8 * 1024;
export const CACHE_LIMIT = 1024 * 1024;
export const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const STORE = 'previews';
const AGE = 'ageAndSize';
let database;

function openDatabase() {
  if (!database) {
    database = new Promise((resolve, reject) => {
      const open = indexedDB.open('visual-history', 1);
      open.onupgradeneeded = () => {
        const store = open.result.createObjectStore(STORE, {keyPath: 'url'});
        store.createIndex(AGE, ['capturedAt', 'bytes']);
      };
      open.onsuccess = () => {
        const db = open.result;
        db.onversionchange = () => {
          db.close();
          database = undefined;
        };
        resolve(db);
      };
      open.onerror = () => reject(open.error);
    }).catch(error => {
      database = undefined;
      throw error;
    });
  }
  return database;
}

function result(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function useCache(work, signal) {
  const db = await openDatabase();
  signal?.throwIfAborted();
  const transaction = db.transaction(STORE, 'readwrite');
  const finished = new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error || new DOMException('Cache update canceled', 'AbortError'));
  });
  function abort() {
    try {
      transaction.abort();
    } catch (error) {
      if (error.name !== 'InvalidStateError') throw error;
    }
  }
  signal?.addEventListener('abort', abort, {once: true});
  try {
    const operation = work(transaction.objectStore(STORE));
    const [value] = await Promise.all([operation, finished]);
    return value;
  } catch (error) {
    abort();
    await finished.catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

function scanKeys(store, range, visit) {
  return new Promise((resolve, reject) => {
    const request = store.index(AGE).openKeyCursor(range);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      try {
        visit(cursor.primaryKey, cursor.key);
        cursor.continue();
      } catch (error) {
        reject(error);
      }
    };
  });
}

function expire(store) {
  const range = IDBKeyRange.upperBound([Date.now() - MAX_AGE, Number.MAX_SAFE_INTEGER]);
  return scanKeys(store, range, url => store.delete(url));
}

export function readPreview(url) {
  return useCache(async store => {
    await expire(store);
    return result(store.get(url));
  });
}

export function clearPreviews() {
  return useCache(store => result(store.clear()));
}

export function removeExcluded(isAllowed) {
  return useCache(async store => {
    await expire(store);
    await scanKeys(store, null, url => {
      if (!isAllowed(url)) store.delete(url);
    });
  });
}

export function cacheUsage() {
  return useCache(async store => {
    await expire(store);
    const usage = {count: 0, bytes: 0};
    await scanKeys(store, null, (_url, [_time, bytes]) => {
      usage.count += 1;
      usage.bytes += bytes;
    });
    return usage;
  });
}

export function savePreview({url, visitId, capturedAt, blob}, signal) {
  if (blob.type !== 'image/webp' || !blob.size || blob.size > IMAGE_LIMIT) return Promise.resolve(false);
  return useCache(async store => {
    await expire(store);
    const records = [];
    let total = blob.size;
    await scanKeys(store, null, (key, [time, bytes]) => {
      if (key === url) return;
      total += bytes;
      records.push({url: key, time, bytes});
    });
    signal?.throwIfAborted();
    const evictions = [];
    for (const old of records) {
      if (total <= CACHE_LIMIT) break;
      // The index is age-ordered. If the system clock moved back, the new image can be oldest.
      if (old.time > capturedAt) return false;
      evictions.push(old.url);
      total -= old.bytes;
    }
    for (const url of evictions) store.delete(url);
    await result(store.put({url, visitId, capturedAt, bytes: blob.size, blob}));
    return true;
  }, signal);
}

export async function compressPreview(dataUrl, signal) {
  const prefix = 'data:image/jpeg;base64,';
  if (!dataUrl.startsWith(prefix)) return null;
  const bytes = Uint8Array.fromBase64(dataUrl.slice(prefix.length));
  const bitmap = await createImageBitmap(new Blob([bytes], {type: 'image/jpeg'}));
  try {
    for (const [maxWidth, maxHeight, quality] of [[320, 180, 0.72], [216, 122, 0.48]]) {
      signal?.throwIfAborted();
      const scale = Math.min(1, maxWidth / bitmap.width, maxHeight / bitmap.height);
      const canvas = new OffscreenCanvas(Math.max(1, Math.floor(bitmap.width * scale)),
        Math.max(1, Math.floor(bitmap.height * scale)));
      canvas.getContext('2d', {alpha: false}).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await canvas.convertToBlob({type: 'image/webp', quality});
      if (blob.type === 'image/webp' && blob.size <= IMAGE_LIMIT) return blob;
    }
    return null;
  } finally {
    bitmap.close();
  }
}
