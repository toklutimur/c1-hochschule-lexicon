# C1 Hochschule Hazırlık — German–Turkish lexicon

This is the German–Turkish dictionary data bundled in the **C1 Hochschule Hazırlık**
study app for Android, along with the source files and the build script that produce
it. It's published so that the FreeDict material, which is GPL, can be had in source form
by anyone who receives the app.

## Contents

| Path | What it is | Licence |
|---|---|---|
| `scripts/lexicon/freedict-deu-tur.tsv` | FreeDict German→Turkish, upstream source format | GNU GPL |
| `scripts/lexicon/wiktionary-de.jsonl` | Selected entries from the German Wiktionary (wiktextract extraction) | CC BY-SA / GFDL |
| `scripts/lexicon/de_50k.txt` | German word-frequency list (OpenSubtitles 2018) | CC BY-SA 4.0 |
| `scripts/lexicon/turkish-overrides.json` | Hand-written corrections applied above both sources | GNU GPL (as part of this work) |
| `scripts/build-lexicon.mjs` | Merges the sources and writes the outputs below | GNU GPL |
| `assets/data/lexicon/*.json` | The generated shards, exactly as shipped in the app | GNU GPL, with the CC BY-SA / GFDL terms on the Wiktionary-derived parts |
| `assets/data/lexiconMeta.json`, `src/data/lexiconShards.ts` | Generated build metadata and the app's shard registry | as above |

## Rebuilding

The build needs Node.js 18 or later and nothing else.

```bash
node scripts/build-lexicon.mjs           # regenerate the outputs
node scripts/build-lexicon.mjs --check   # confirm the committed outputs match the sources
```

In the app's own repository, the build also measures how well the lexicon covers the
app's reading texts. Those texts aren't part of this dictionary and aren't published
here, so that step is skipped. It only produces statistics; the shards come out
byte-for-byte identical either way.

`wiktionary-de.jsonl` is a selection made from the full extraction at
<https://kaikki.org/dewiktionary/rawdata.html>. It keeps German entries with IPA,
article, inflected forms, German sense glosses and any Turkish translations.

## Sources and attribution

- **FreeDict German–Turkish.** Author: Erdal Ronahi and others.
  <https://github.com/freedict/fd-dictionaries/tree/master/deu-tur>
  (fetched 2026-08-22; upstream version dated 2004-11-23).
  Upstream says "Available under the terms of the GNU General Public License" but names
  no version. Under the GPL's own terms, any published version may then be chosen, and
  this repository distributes it under **GPL version 2**. The full text is in `COPYING`.
- **Wiktionary, German edition.** Extracted with wiktextract by Tatu Ylonen,
  <https://github.com/tatuylonen/wiktextract>. Licensed CC BY-SA and GFDL, inherited from
  Wiktionary.
- **FrequencyWords.** By Hermit Dave, <https://github.com/hermitdave/FrequencyWords>
  (`content/2018/de/de_50k.txt`). Licensed CC BY-SA 4.0.

## Not included

The app's code and its reading texts are separate works and aren't covered by this
repository.
