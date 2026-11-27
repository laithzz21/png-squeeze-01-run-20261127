# Squeeze screenshots into the smallest PNG

[![make.fun bounty](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/laithzz21/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/laithzz21/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

Entry for the [make.fun](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127) bounty **"Squeeze screenshots into the smallest PNG, 27 November 2026"**: one program losslessly re-encodes each 1280x720 RGBA screenshot as the smallest PNG it can.

## What this does

`solve.js` (Node 22, built-in `zlib` only, deterministic — no network, clock, or randomness) squeezes each screenshot:

- surveys the pixels (opaque? grey? how many distinct colours?),
- tries every lossless form that fits — a palette (colour type 3, ordered by frequency and by brightness) when there are at most 256 colours, otherwise grey / grey+alpha / RGB / RGBA with a `tRNS` key when every see-through pixel shares one colour,
- filters every row two ways — the minimum-sum rule and brute force (each of the five PNG filters actually deflated at level 4 against the 32 KiB before it) — weighs each form by a level-6 deflate including its PLTE/tRNS overhead,
- writes the winner at zlib level 9 under the better of the default and filtered strategies, as a single IDAT.

`main.ts` drives it: it reads `/input/<id>/image.png` for each instance and writes `/output/<id>/image.png`, creating the output directory when it is missing.

## How to run

```sh
node main.ts
# reads /input, writes /output
```

Or against the kit's practice set:

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## License

MIT — see [LICENSE](LICENSE).

---

Built for [make.fun](https://make.fun/?ref=5kda0hwb&utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127) — enter bounties, win rewards.
