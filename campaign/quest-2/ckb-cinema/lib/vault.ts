/**
 * Browser-side storage for the demo, split the way a real deployment would be:
 *  - `cdn`:    PUBLIC. The film release (metadata + fingerprints) and the
 *              encrypted file. Anyone may download it; it is useless without a key.
 *  - `studio`: SELLER ONLY. The film's content key, kept by the studio so it can
 *              issue a new license for every purchase.
 * In this single-page demo both live in the same browser profile. In production
 * the studio store would sit on the seller's server and the CDN would be any
 * static host. Buyer code only ever reads the `cdn` store.
 */
import { encryptFilm, sha256Hex, toHex, fromHex } from './crypto';
import { filmAad, maxFilmBytes, parseRelease, type FilmRelease } from './catalog';

const dbName = 'ckb-cinema-v1';
type CdnRecord = { filmId: string; release: FilmRelease; ciphertext: ArrayBuffer };
type StudioRecord = { filmId: string; contentKey: `0x${string}`; licenses: string[] };

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('cdn', { keyPath: 'filmId' });
      request.result.createObjectStore('studio', { keyPath: 'filmId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open browser storage.'));
  });
}

async function tx<T>(store: 'cdn' | 'studio', mode: IDBTransactionMode, action: (s: IDBObjectStore) => IDBRequest<T>) {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      const request = action(transaction.objectStore(store));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error ?? new Error('Browser storage failed.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Browser storage was aborted.'));
    });
  } finally {
    db.close();
  }
}

// ----- Studio (seller) -----

/** Encrypt a master file once and publish its release + ciphertext to the CDN. */
export async function publishFilm(filmId: string, title: string, master: Uint8Array, mime: string) {
  if (master.length === 0 || master.length > maxFilmBytes) throw new Error(`Films must be between 1 byte and ${maxFilmBytes / 1024 / 1024} MB.`);
  const film = { filmId, title, mime, size: master.length, filmSha256: await sha256Hex(master) };
  const encrypted = await encryptFilm(master, filmAad(film));
  const release = parseRelease({
    version: 1,
    film,
    contentIv: encrypted.iv,
    ciphertextSha256: await sha256Hex(encrypted.ciphertext),
    ciphertextSize: encrypted.ciphertext.length,
  });
  const ciphertext = encrypted.ciphertext.buffer.slice(0) as ArrayBuffer;
  await tx('studio', 'readwrite', (s) => s.put({ filmId, contentKey: toHex(encrypted.contentKey), licenses: [] } satisfies StudioRecord));
  await tx('cdn', 'readwrite', (s) => s.put({ filmId, release, ciphertext } satisfies CdnRecord));
  return release;
}

export async function studioContentKey(filmId: string) {
  const record = await tx<StudioRecord | undefined>('studio', 'readonly', (s) => s.get(filmId));
  if (!record) throw new Error('The studio has no key for this film. Publish it again.');
  return fromHex(record.contentKey);
}

/** Record an issued license (public payment hash only) so the UI can show "encrypted once, licensed N times". */
export async function recordLicense(filmId: string, paymentHash: string) {
  const record = await tx<StudioRecord | undefined>('studio', 'readonly', (s) => s.get(filmId));
  if (!record) return [];
  const licenses = record.licenses.includes(paymentHash) ? record.licenses : [...record.licenses, paymentHash];
  await tx('studio', 'readwrite', (s) => s.put({ ...record, licenses }));
  return licenses;
}

export async function studioLicenses(filmId: string) {
  return (await tx<StudioRecord | undefined>('studio', 'readonly', (s) => s.get(filmId)))?.licenses ?? [];
}

// ----- CDN (public) -----

export async function listReleases() {
  const records = await tx<CdnRecord[]>('cdn', 'readonly', (s) => s.getAll());
  return records.map((record) => parseRelease(record.release));
}

/** Buyer: download the encrypted film and check it against the published fingerprint. */
export async function downloadCiphertext(release: FilmRelease) {
  const record = await tx<CdnRecord | undefined>('cdn', 'readonly', (s) => s.get(release.film.filmId));
  if (!record) throw new Error('The encrypted film is not on the CDN.');
  const ciphertext = new Uint8Array(record.ciphertext);
  if (ciphertext.length !== release.ciphertextSize
    || (await sha256Hex(ciphertext)).toLowerCase() !== release.ciphertextSha256.toLowerCase()) {
    throw new Error('The downloaded file does not match the published fingerprint.');
  }
  return ciphertext;
}
