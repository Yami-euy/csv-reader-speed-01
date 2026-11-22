# csv-reader-speed-01 — a faster csv-reader 1.0.0

[![make.fun bounty](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![make.fun rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/Yami-euy/csv-reader-speed-01/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![make.fun reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/Yami-euy/csv-reader-speed-01/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A drop-in replacement for csv-reader 1.0.0: `run(input)` returns exactly
csv-reader's `{columns, rows, errors}` for every `{text, header}`, but
faster. `main.ts` reads every case from `/input/cases.json`, answers each
with `run`, and writes `/output/answers.json`.

## Approach

The reference reads one character at a time and builds every field a
character at a time. This parser instead jumps and slices:

- Unquoted fields: one forward `charCodeAt` scan to the next comma, LF or
  CR, then a single `slice` for the whole field. A stray CR splits the
  field into pieces that are joined once at the end.
- Quoted fields: `indexOf('"')` jumps to the next quote; `""` is one
  quote; content between quotes is sliced whole, with CR/CRLF inside it
  read as LF and newlines counted for the line number.
- No regex, no split, no per-character loop on the hot path, no
  allocation per field in the common case.

## Results (practice set, 6 cases, 10.2 MB)

- Exactness: 6/6 identical to csv-reader's reference answers, plus 172
  hand-written edge cases, 600 random fuzz inputs and 400 structured
  fuzz inputs — all identical to csv-reader 1.0.0.
- Speed (median of 7 cold single executions of the whole driver, the
  way the contest times it): this entry 1,274 ms vs the house baseline
  2,699 ms — 2.12x faster. On `run()` alone once warm: ~270 ms vs
  ~1,300 ms — about 4.8x faster.
- The remaining time is mostly fixed work every entry pays: parsing the
  10.2 MB cases.json and stringifying the 11.6 MB answers.
- Determinism: two runs of `main.ts` produce byte-identical answers.
