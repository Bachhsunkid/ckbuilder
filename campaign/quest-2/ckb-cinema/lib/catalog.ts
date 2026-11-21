/** Public film metadata. Nothing in this file is secret. */
export type FilmInfo = {
  filmId: string;
  title: string;
  year: number;
  genre: string;
  runtime: string;
  synopsis: string;
  priceCkb: number;
  poster: string;
  /** Wide still from the film, used for the feature hero and the screen. */
  backdrop: string;
  trailer: string;
  /**
   * SHA-256 of the studio's master file (in samples/films, never served by the app).
   * The studio checks the file it loads against it, and viewers check the release against it.
   */
  masterSha256: `0x${string}`;
};

/** What the seller publishes once per film, next to the encrypted file on the CDN. */
export type FilmRelease = {
  version: 1;
  film: {
    filmId: string;
    title: string;
    mime: string;
    size: number;
    filmSha256: `0x${string}`;
  };
  contentIv: `0x${string}`;
  ciphertextSha256: `0x${string}`;
  ciphertextSize: number;
};

export const prices = [1, 2, 3, 5] as const;
export const maxFilmBytes = 40 * 1024 * 1024;
const gcmTagBytes = 16;

export const sampleFilms: FilmInfo[] = [
  {
    filmId: 'paper-lanterns', title: 'Paper Lanterns', year: 2026, genre: 'Drama', runtime: '24-second short',
    synopsis: 'A village keeps one promise a year. This year, Mai sends two lanterns into the night sky.',
    priceCkb: 1, poster: '/films/paper-lanterns-poster.png', backdrop: '/films/paper-lanterns-backdrop.jpg', trailer: '/films/paper-lanterns-trailer.webm',
    masterSha256: '0xd7d15543393d33d0dac29c1359781a5ff74f1f5c6c5ad6e591a5019d7e66dd25',
  },
  {
    filmId: 'neon-tide', title: 'Neon Tide', year: 2026, genre: 'Sci-fi', runtime: '24-second short',
    synopsis: 'In 2089 the sea glows at midnight, and Kai surfs the light until the tide begins to turn.',
    priceCkb: 2, poster: '/films/neon-tide-poster.png', backdrop: '/films/neon-tide-backdrop.jpg', trailer: '/films/neon-tide-trailer.webm',
    masterSha256: '0x083abf02ebbdb0f5e69536d5b140d5f631f4dde08a81f7a63c49551cf42c4d03',
  },
  {
    filmId: 'orbit-nine', title: 'Orbit Nine', year: 2026, genre: 'Space thriller', runtime: '24-second short',
    synopsis: 'The last station before the dark picks up a signal. One pilot decides to answer it.',
    priceCkb: 3, poster: '/films/orbit-nine-poster.png', backdrop: '/films/orbit-nine-backdrop.jpg', trailer: '/films/orbit-nine-trailer.webm',
    masterSha256: '0x96353d294c4277cc643dd1d38ac97a884008ae8aed8f6c1b3e21ca3865c487a5',
  },
];

export const ckbToShannons = (ckb: number) => BigInt(Math.round(ckb * 100)) * 1_000_000n;

/** Canonical additional data that binds the public film description to its ciphertext. */
export function filmAad(film: FilmRelease['film']) {
  return JSON.stringify(['ckb-cinema/film/v1', film.filmId, film.title, film.mime, film.size, film.filmSha256.toLowerCase()]);
}

/** Additional data for a license: the wrapped key only opens for this film, price and invoice. */
export function licenseAad(filmId: string, filmSha256: string, priceCkb: number, paymentHash: string) {
  return JSON.stringify(['ckb-cinema/license/v1', filmId, filmSha256.toLowerCase(), priceCkb, paymentHash.toLowerCase()]);
}

const hex32 = /^0x[0-9a-f]{64}$/i;
const hex12 = /^0x[0-9a-f]{24}$/i;
const filmIdPattern = /^[a-z0-9-]{1,48}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} is missing or too long.`);
  return value.trim();
}

function hex(value: unknown, pattern: RegExp, label: string) {
  if (typeof value !== 'string' || !pattern.test(value.trim())) throw new Error(`${label} is malformed.`);
  return value.trim().toLowerCase() as `0x${string}`;
}

function size(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > maxFilmBytes + gcmTagBytes) {
    throw new Error(`${label} must be a positive size within ${maxFilmBytes / 1024 / 1024} MB.`);
  }
  return value;
}

/** Strictly parse a release; unknown fields are dropped. */
export function parseRelease(value: unknown): FilmRelease {
  if (!isObject(value) || value.version !== 1 || !isObject(value.film)) throw new Error('Unsupported film release.');
  const film = value.film;
  const filmId = text(film.filmId, 'Film id', 48);
  if (!filmIdPattern.test(filmId)) throw new Error('Film id is malformed.');
  const mime = text(film.mime, 'Film type', 64);
  if (!/^video\/[a-z0-9.+-]+$/i.test(mime)) throw new Error('Only video files can be released.');
  const release: FilmRelease = {
    version: 1,
    film: { filmId, title: text(film.title, 'Title', 80), mime, size: size(film.size, 'Film size'), filmSha256: hex(film.filmSha256, hex32, 'Film fingerprint') },
    contentIv: hex(value.contentIv, hex12, 'Content IV'),
    ciphertextSha256: hex(value.ciphertextSha256, hex32, 'Ciphertext fingerprint'),
    ciphertextSize: size(value.ciphertextSize, 'Ciphertext size'),
  };
  if (release.ciphertextSize !== release.film.size + gcmTagBytes) throw new Error('Ciphertext size does not match the film size.');
  return release;
}

export function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}
