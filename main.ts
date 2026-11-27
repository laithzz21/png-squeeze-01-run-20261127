// png-squeeze entry: read every screenshot under the input directory and
// write its squeezed PNG under the output directory, one per instance id.
//
//   node main.ts
//   MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
//
// The input holds /input/<id>/image.png and the output is written as
// /output/<id>/image.png, the directory created when it is missing. The
// squeeze itself lives in solve.js; this file only drives it.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compressPng, readPng } from './solve.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const entry of readdirSync(INPUT_DIR, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
  if (!entry.isDirectory()) continue;
  const id = entry.name;
  let source;
  try {
    source = readFileSync(join(INPUT_DIR, id, 'image.png'));
  } catch {
    // No readable image for this instance: nothing to answer with, and
    // one missing instance must not abort the other seven.
    process.stderr.write(`${id}: no readable image.png, skipping\n`);
    continue;
  }
  // The squeeze must never lose the other instances: if anything about
  // this one fails, answer with its stored PNG as it arrived (a valid,
  // exact PNG, worth no points) instead of aborting the whole run.
  let squeezed = source;
  try {
    const image = readPng(new Uint8Array(source));
    squeezed = compressPng(image.rgba, image.width, image.height);
    // Self-check: the squeezed file must decode back to the same pixels.
    // If it does not, the stored original is the safe answer.
    const check = readPng(new Uint8Array(squeezed));
    if (
      check.width !== image.width ||
      check.height !== image.height ||
      check.rgba.length !== image.rgba.length ||
      !check.rgba.every((v, i) => v === image.rgba[i])
    ) {
      throw new Error('squeezed PNG does not decode to the same pixels');
    }
  } catch (err) {
    process.stderr.write(`${id}: squeeze failed (${err.message}), answering with the stored PNG\n`);
    squeezed = source;
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), squeezed);
}
