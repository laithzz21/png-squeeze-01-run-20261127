// png-squeeze: a lossless PNG re-encoder that squeezes 1280x720 RGBA screenshots
// into the smallest PNG it can, in pure Node (built-in zlib only).
//
// How it works, per image:
//   1. Survey the pixels: are they all opaque, all grey, and how many distinct
//      colours are there (up to 256)?
//   2. Build every lossless form that could hold the image: a palette form
//      (colour type 3, ordered by frequency and, separately, by brightness)
//      when there are at most 256 colours, and a channel form (grey / grey+alpha
//      / RGB / RGBA, with a tRNS key when every see-through pixel shares one
//      colour no opaque pixel uses).
//   3. For each form, filter every row several ways: each of the five PNG
//      filters fixed across the whole image, then per-row by the minimum-sum
//      rule (the row filter whose bytes have the smallest sum of absolute
//      values), then per-row by brute force (each filter actually deflated at
//      level 4 against the 32 KiB written before it, the smallest kept). Each
//      filtered form is weighed by a level-6 deflate, PLTE/tRNS overhead
//      included, and the smallest wins. A fixed filter can win outright:
//      on large flat areas unfiltered rows hold long runs of identical bytes
//      that the deflater matches across rows.
//   4. The winner is re-deflated at level 9 under two zlib strategies and the
//      smaller stream is written out as a single IDAT.
//
// Everything is deterministic: fixed work per image, no clock, no randomness,
// so two runs write identical bytes.

import { deflateSync, inflateSync, constants as zlibConstants } from 'node:zlib';

/* ------------------------------------------------------------------ */
/* PNG container: signature, CRC-32, chunk assembly                    */
/* ------------------------------------------------------------------ */

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes, from, to) {
  let c = -1;
  for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const asciiBytes = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

/** Assemble a PNG file from [type, data] chunk pairs. */
function assemblePng(chunks) {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(asciiBytes(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

/** The 13-byte IHDR payload: width, height, 8-bit samples, colour type. */
function headerBytes(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

/* ------------------------------------------------------------------ */
/* Reading a PNG back into RGBA                                        */
/* ------------------------------------------------------------------ */

const SAMPLES_PER_PIXEL = Object.freeze({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 });

/** The Paeth predictor: which of left/above/above-left the value is closest to. */
function paethGuess(left, above, aboveLeft) {
  const guess = left + above - aboveLeft;
  const dLeft = Math.abs(guess - left);
  const dAbove = Math.abs(guess - above);
  const dCorner = Math.abs(guess - aboveLeft);
  if (dLeft <= dAbove && dLeft <= dCorner) return left;
  if (dAbove <= dCorner) return above;
  return aboveLeft;
}

/** Undo one row's filter, writing the restored samples into `out`. */
function unfilterRow(kind, row, prev, bpp, out) {
  const n = row.length;
  if (kind === 0) {
    out.set(row);
  } else if (kind === 1) {
    for (let i = 0; i < n; i++) out[i] = row[i] + (i >= bpp ? out[i - bpp] : 0);
  } else if (kind === 2) {
    for (let i = 0; i < n; i++) out[i] = row[i] + (prev === null ? 0 : prev[i]);
  } else if (kind === 3) {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? out[i - bpp] : 0;
      const above = prev === null ? 0 : prev[i];
      out[i] = row[i] + ((left + above) >> 1);
    }
  } else if (kind === 4) {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? out[i - bpp] : 0;
      const above = prev === null ? 0 : prev[i];
      const corner = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = row[i] + paethGuess(left, above, corner);
    }
  } else {
    throw new Error(`row filter ${kind} is not a PNG filter`);
  }
}

/**
 * Decode a PNG file's bytes into { width, height, rgba }. Only the chunk
 * types the contest reads are accepted, and only colour types 0, 2, 4 and 6
 * (the screenshots the contest hands out are stored RGBA, type 6).
 */
export function readPng(bytes) {
  if (bytes.length < SIGNATURE.length || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new Error('not a PNG file');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = SIGNATURE.length;
  let header = null;
  let palette = null;
  let trns = null;
  const idatParts = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    if (at + 12 > bytes.length) throw new Error('a chunk is cut short');
    const len = view.getUint32(at);
    if (at + 12 + len > bytes.length) throw new Error('a chunk overruns the file');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) {
      throw new Error(`${type} chunk fails its CRC`);
    }
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      if (header !== null) throw new Error('two IHDR chunks');
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = {
        width: dv.getUint32(0),
        height: dv.getUint32(4),
        depth: data[8],
        colourType: data[9],
        interlace: data[12],
      };
      if (header.depth !== 8) throw new Error(`bit depth ${header.depth}, not 8`);
      if (!Object.hasOwn(SAMPLES_PER_PIXEL, header.colourType)) {
        throw new Error(`colour type ${header.colourType} is not supported`);
      }
      if (header.interlace !== 0) throw new Error('interlaced PNG');
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      ended = true;
    } else {
      throw new Error(`unexpected ${type} chunk`);
    }
  }
  if (!ended || idatParts.length === 0) throw new Error('no IEND or no IDAT');
  const { width, height, colourType } = header;
  const bpp = SAMPLES_PER_PIXEL[colourType];
  const stride = width * bpp;
  const raw = inflateSync(idatParts.length === 1 ? idatParts[0] : Buffer.concat(idatParts));
  if (raw.length !== height * (stride + 1)) throw new Error('IDAT inflates to the wrong size');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const kind = raw[y * (stride + 1)];
    const from = y * (stride + 1) + 1;
    const out = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    unfilterRow(kind, raw.subarray(from, from + stride), prev, bpp, out);
  }
  const pixels = width * height;
  const rgba = new Uint8Array(pixels * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < pixels; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < pixels; i++, d += 4) {
      const g = samples[i];
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < pixels; i++, s += 2, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s];
      rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    if (palette === null) throw new Error('palette image without PLTE');
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < pixels; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) throw new Error(`palette index ${e} past the palette`);
      rgba[d] = palette[e * 3];
      rgba[d + 1] = palette[e * 3 + 1];
      rgba[d + 2] = palette[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { width, height, rgba };
}

/* ------------------------------------------------------------------ */
/* Surveying the image                                                 */
/* ------------------------------------------------------------------ */

/** One number per colour: ((((r * 256) + g) * 256) + b) * 256 + a. */
const colourKey = (r, g, b, a) => ((r * 256 + g) * 256 + b) * 256 + a;

/**
 * What the image holds: whether every pixel is opaque, whether every pixel
 * is grey (r == g == b), and a count of each colour when there are at most
 * 256 of them (null otherwise).
 */
function surveyImage(rgba) {
  const pixels = rgba.length >>> 2;
  let allOpaque = true;
  let allGrey = true;
  const tally = new Map();
  let overflow = false;
  for (let i = 0, d = 0; i < pixels; i++, d += 4) {
    const r = rgba[d];
    const g = rgba[d + 1];
    const b = rgba[d + 2];
    const a = rgba[d + 3];
    if (a !== 255) allOpaque = false;
    if (r !== g || g !== b) allGrey = false;
    if (!overflow) {
      const key = colourKey(r, g, b, a);
      const seen = tally.get(key);
      if (seen === undefined) {
        if (tally.size === 256) overflow = true;
        else tally.set(key, 1);
      } else {
        tally.set(key, seen + 1);
      }
    }
  }
  return { allOpaque, allGrey, tally: overflow ? null : tally };
}

/**
 * The one see-through colour the image can name with a tRNS key instead of
 * an alpha channel: every non-opaque pixel is fully transparent and shares
 * that colour, and no opaque pixel uses it. Null when there is no such colour.
 */
function clearColourKey(rgba, grey) {
  let key = null;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === null) key = v;
    else if (key !== v) return null;
  }
  if (key === null) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

/** The image's samples in a channel colour type (0, 2 or 4; 6 is the RGBA itself). */
function extractSamples(rgba, colourType) {
  const pixels = rgba.length >>> 2;
  if (colourType === 6) return rgba;
  const per = colourType === 0 ? 1 : colourType === 4 ? 2 : 3;
  const out = new Uint8Array(pixels * per);
  for (let i = 0, d = 0, s = 0; i < pixels; i++, d += 4, s += per) {
    if (colourType === 0) {
      out[s] = rgba[d];
    } else if (colourType === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Palette forms                                                       */
/* ------------------------------------------------------------------ */

/**
 * A palette form from the image's colour tally: { plte, trns, indices }.
 * See-through entries come first (by alpha, so tRNS stays short), then the
 * rest by `order`: 'count' (most used first) or 'brightness' (darkest first).
 */
function buildPalette(rgba, tally, order) {
  const entries = [...tally.entries()].map(([key, count]) => ({
    r: (key >>> 24) & 255,
    g: (key >>> 16) & 255,
    b: (key >>> 8) & 255,
    a: key & 255,
    count,
    key,
  }));
  const brightness = (e) => 299 * e.r + 587 * e.g + 114 * e.b;
  entries.sort((x, y) => {
    const tx = x.a === 255 ? 1 : 0;
    const ty = y.a === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (tx === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'brightness') return brightness(x) - brightness(y) || x.key - y.key;
    return y.count - x.count || x.key - y.key;
  });
  const slot = new Map(entries.map((e, i) => [e.key, i]));
  const plte = new Uint8Array(entries.length * 3);
  let seeThrough = 0;
  entries.forEach((e, i) => {
    plte[i * 3] = e.r;
    plte[i * 3 + 1] = e.g;
    plte[i * 3 + 2] = e.b;
    if (e.a !== 255) seeThrough = i + 1;
  });
  const trns = seeThrough === 0 ? null : Uint8Array.from(entries.slice(0, seeThrough), (e) => e.a);
  const pixels = rgba.length >>> 2;
  const indices = new Uint8Array(pixels);
  for (let i = 0, d = 0; i < pixels; i++, d += 4) {
    indices[i] = slot.get(colourKey(rgba[d], rgba[d + 1], rgba[d + 2], rgba[d + 3]));
  }
  return { plte, trns, indices };
}

/* ------------------------------------------------------------------ */
/* Filtering rows                                                      */
/* ------------------------------------------------------------------ */

/** Filter one row of `cur` (against `prev`, null on the first row) into `out`. */
function filterOne(kind, cur, prev, bpp, out) {
  const n = cur.length;
  if (kind === 0) {
    out.set(cur);
  } else if (kind === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (kind === 2) {
    if (prev === null) {
      out.set(cur);
    } else {
      for (let i = 0; i < n; i++) out[i] = cur[i] - prev[i];
    }
  } else if (kind === 3) {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const above = prev === null ? 0 : prev[i];
      out[i] = cur[i] - ((left + above) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const above = prev === null ? 0 : prev[i];
      const corner = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paethGuess(left, above, corner);
    }
  }
}

/** The minimum-sum cost of a filtered row: its bytes read signed, absolute. */
function signedCost(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

/**
 * Filter a whole image's samples with one fixed filter on every row.
 * A single filter can beat per-row choices outright: on images with large
 * flat areas (a transparent background, say) unfiltered rows hold long runs
 * of identical bytes that the deflater matches across rows, where filtering
 * would break those runs apart.
 */
function filterFixed(samples, width, height, bpp, kind) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    raw[at] = kind;
    filterOne(kind, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
  }
  return raw;
}

/** How much filtered data brute force looks back at when weighing a row. */
const BRUTE_WINDOW = 32768;
/** The zlib level brute force weighs a row's filters at. */
const BRUTE_LEVEL = 4;

/**
 * Filter a whole image's samples, one filter byte per row. `mode` is
 * 'cheap' (each row the filter with the smallest signed cost) or 'brute'
 * (each row the filter whose level-4 deflate, against the 32 KiB written
 * before it, is smallest). The lower filter wins a tie.
 */
function filterAdaptive(samples, width, height, bpp, mode) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = [];
  for (let t = 0; t < 5; t++) {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    trial.push(row);
  }
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    let bestKind = 0;
    let bestCost = Infinity;
    for (let t = 0; t < 5; t++) {
      filterOne(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (mode === 'brute') {
        const context = raw.subarray(Math.max(0, at - BRUTE_WINDOW), at);
        cost = deflateSync(
          trial[t],
          context.length === 0
            ? { level: BRUTE_LEVEL, memLevel: 9 }
            : { level: BRUTE_LEVEL, memLevel: 9, dictionary: context },
        ).length;
      } else {
        cost = signedCost(trial[t].subarray(1));
      }
      if (cost < bestCost) {
        bestCost = cost;
        bestKind = t;
      }
    }
    raw.set(trial[bestKind], at);
  }
  return raw;
}

/* ------------------------------------------------------------------ */
/* The squeeze itself                                                  */
/* ------------------------------------------------------------------ */

/** The zlib setting every form is screened with. */
const SCREEN_OPTS = Object.freeze({ level: 6, memLevel: 8, strategy: zlibConstants.Z_DEFAULT_STRATEGY });

/** The bytes a form's PLTE and tRNS chunks add to its file. */
const overheadOf = (form) =>
  (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

/** Every lossless form an image can take: palette forms, then a channel form. */
function formsOf(rgba) {
  const { allOpaque, allGrey, tally } = surveyImage(rgba);
  const forms = [];
  if (tally !== null) {
    for (const order of ['count', 'brightness']) {
      const pal = buildPalette(rgba, tally, order);
      forms.push({ colourType: 3, bpp: 1, samples: pal.indices, plte: pal.plte, trns: pal.trns });
    }
    if (!allGrey) return forms;
  }
  const key = allOpaque ? null : clearColourKey(rgba, allGrey);
  let colourType;
  let trns = null;
  if (allGrey) {
    colourType = allOpaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    colourType = allOpaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[colourType];
  forms.push({ colourType, bpp, samples: extractSamples(rgba, colourType), plte: null, trns });
  return forms;
}

/**
 * Losslessly re-encode RGBA pixels (width x height) as the smallest PNG this
 * program can write: the winning form, brute-force filtered, deflated at
 * level 9 under the better of zlib's default and filtered strategies.
 */
export function compressPng(rgba, width, height) {
  let winner = null;
  const weigh = (form, data) => {
    const stream = deflateSync(data, SCREEN_OPTS);
    const total = stream.length + overheadOf(form);
    if (winner === null || total < winner.total) {
      winner = { form, data, total };
    }
  };
  for (const form of formsOf(rgba)) {
    // One fixed filter on every row: cheap to try, and sometimes the best
    // by a wide margin (flat areas compress as long runs when unfiltered).
    for (let kind = 0; kind < 5; kind++) {
      weigh(form, filterFixed(form.samples, width, height, form.bpp, kind));
    }
    // Per-row choices: the minimum-sum rule, then brute force.
    for (const mode of ['cheap', 'brute']) {
      weigh(form, filterAdaptive(form.samples, width, height, form.bpp, mode));
    }
  }
  let bestStream = null;
  for (const strategy of [zlibConstants.Z_DEFAULT_STRATEGY, zlibConstants.Z_FILTERED]) {
    const stream = deflateSync(winner.data, { level: 9, memLevel: 9, strategy });
    if (bestStream === null || stream.length < bestStream.length) bestStream = stream;
  }
  const chunks = [['IHDR', headerBytes(width, height, winner.form.colourType)]];
  if (winner.form.plte !== null) chunks.push(['PLTE', winner.form.plte]);
  if (winner.form.trns !== null) chunks.push(['tRNS', winner.form.trns]);
  chunks.push(['IDAT', new Uint8Array(bestStream)]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return assemblePng(chunks);
}
