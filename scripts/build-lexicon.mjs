#!/usr/bin/env node
/**
 * Builds the bundled German-Turkish lexicon from the vendored sources in
 * scripts/lexicon/ (see SOURCES.md there).
 *
 * Two sources are merged because neither is enough alone: FreeDict carries
 * Turkish but thins out above B2, while the German Wiktionary carries IPA,
 * gender, inflection and a German definition for nearly every word but has
 * Turkish for only ~14% of them.
 *
 * Output is sharded by the first two letters of the looked-up form so the app
 * parses ~40 KB on a tap instead of a 15 MB blob, and needs no native module:
 * src/data/lexiconShards.ts is a generated require map, the same trick
 * src/data/leseverstehenImages.ts uses for the hero images.
 *
 * Run with: npm run lexicon:build   (verify with: npm run lexicon:check)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'scripts', 'lexicon');
const FREEDICT = join(SRC, 'freedict-deu-tur.tsv');
const WIKTIONARY = join(SRC, 'wiktionary-de.jsonl');
const OVERRIDES = join(SRC, 'turkish-overrides.json');
const MISSING = join(SRC, 'missing-turkish.txt');
const DATASET = join(ROOT, 'assets', 'data', 'booklets.json');

const SHARD_DIR = join(ROOT, 'assets', 'data', 'lexicon');
const META = join(ROOT, 'assets', 'data', 'lexiconMeta.json');
const REGISTRY = join(ROOT, 'src', 'data', 'lexiconShards.ts');

/**
 * A shard is parsed whole on the first tap of a word with that prefix, so it
 * has to stay small enough not to be felt. Prefixes grow a letter at a time
 * until every shard is under this, which keeps "ver…" from becoming a 660 KB
 * stall while leaving the sparse letters as single files.
 */
const MAX_SHARD_BYTES = 120 * 1024;
const MAX_PREFIX = 5;

/** Two part-of-speech readings per form: "arm" is both poor and an Arm. */
const MAX_SENSES = 2;
const MAX_TURKISH = 5;
const MISSING_REPORT_LIMIT = 4000;

/**
 * Which reading leads when a form has several: the one a reader most likely
 * meant. Proper names and abbreviations sink to the bottom — otherwise tapping
 * "Waren" offers a town in Mecklenburg and "Seine" a river in France.
 */
const POS_RANK = {
  noun: 0,
  verb: 1,
  adj: 2,
  adv: 3,
  prep: 4,
  conj: 5,
  pron: 6,
  article: 7,
  particle: 8,
  num: 9,
  intj: 10,
  contraction: 11,
  abbrev: 20,
  name: 21,
  character: 22,
  prefix: 30,
  suffix: 31,
};

/** Bound morphemes ("de-", "-heit") are never what a reader taps in a text. */
const AFFIX_RE = /(^-)|(-$)/;

const GENDERS = new Set(['m', 'f', 'n']);

/**
 * A form-of page says which headword it belongs to in prose: "Nominativ Plural
 * des Substantivs Schicht". Pulling the lemma out turns those pages from junk
 * definitions into exactly what they are — inflection pointers.
 */
const FORM_OF_RE =
  /(?:des|der)\s+(?:Substantivs|Verbs|Adjektivs|Adverbs|Wortes)\s+([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß-]*)/;

function formOfTarget(record) {
  for (const gloss of record.d ?? []) {
    const match = FORM_OF_RE.exec(gloss);
    if (match) return normalizeWord(match[1]);
  }
  return undefined;
}

/**
 * True when every gloss the page carries is an inflection statement. Only about
 * half of the real entries are filed under "Grundformeintrag", so the category
 * cannot be used for this — but a page whose only sentences are "Genitiv Plural
 * des Substantivs Schicht" is unambiguously a pointer.
 */
function isPointerOnly(record) {
  const glosses = record.d ?? [];
  return glosses.length > 0 && glosses.every((gloss) => FORM_OF_RE.test(gloss));
}

class LexiconError extends Error {}

function normalizeWord(raw) {
  return raw
    .normalize('NFC')
    .toLowerCase()
    .replace(/^[^a-zäöüß]+/, '')
    .replace(/[^a-zäöüß]+$/, '');
}

/**
 * Both sources leak German into the Turkish column: FreeDict carries truncated
 * fragments ("Kraut → of", "notfalls → im") and the Wiktionary Ü-templates
 * append German qualifiers ("tatlı (wenn süß)", "hudut (veraltend)"). Strip the
 * parentheticals, split comma-joined lists so one bad item cannot sink the
 * rest, then refuse any part that still uses a letter Turkish does not
 * ("límit", "ß") or is a bare German/English function word.
 */
const NON_TURKISH_RE = /[^a-zA-Z0-9çÇğĞıİöÖşŞüÜâÂîÎûÛ\s.,;:!?'’…/-]/;
const FRAGMENT_STOPLIST = new Set([
  'of', 'the', 'to', 'im', 'und', 'der', 'die', 'das', 'den', 'dem', 'des',
  'ein', 'eine', 'mit', 'für', 'auf', 'bei', 'von', 'zum', 'zur',
]);

function cleanTurkish(raw) {
  const parts = [];
  for (const piece of raw.replace(/\s*\([^)]*\)/g, '').split(/[,;]/)) {
    const part = piece.replace(/\s+/g, ' ').trim();
    if (!part) continue;
    if (NON_TURKISH_RE.test(part)) continue;
    if (FRAGMENT_STOPLIST.has(part.toLowerCase())) continue;
    if (!parts.includes(part)) parts.push(part);
  }
  return parts;
}

/**
 * Shard file name for a lookup key at a given prefix length. Keys keep their
 * inner punctuation and spaces ("ab und zu" is a real FreeDict headword), so
 * anything outside a-z collapses to a single bucket rather than an illegal
 * path. Mirrored exactly by shardName() in src/data/lexicon.ts — change one,
 * change the other.
 */

/**
 * Windows refuses to open a file named after a legacy device, so a prefix that
 * lands on one (aux from auxiliar…) gets a trailing underscore. Mirrored on
 * both sides of the pipeline.
 */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com0', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt0', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

function shardName(key, length) {
  const name = key
    .slice(0, length)
    .padEnd(length, '_')
    .replace(/ä/g, 'a2')
    .replace(/ö/g, 'o2')
    .replace(/ü/g, 'u2')
    .replace(/ß/g, 's2')
    .replace(/[^a-z0-9]/g, '_');
  return RESERVED_NAMES.has(name) ? name + '_' : name;
}

/* ------------------------------------------------------------------ sources */

/**
 * FreeDict: `German<TAB>Turkish<TAB>tags`, several rows per headword. Rows are
 * kept apart by the headword's case — German capitalises its nouns, so when
 * "Wirtschaften" (pub, plural) and "wirtschaften" (to manage) case-fold onto
 * one key, the merge can still hand each reading its own translations.
 */
function loadFreeDict() {
  const byWord = new Map();
  let pairs = 0;
  for (const line of readFileSync(FREEDICT, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [germanRaw, turkishRaw, tagsRaw] = line.split('\t');
    const key = normalizeWord(germanRaw ?? '');
    const turkish = cleanTurkish((turkishRaw ?? '').trim());
    if (!key || turkish.length === 0) continue;
    const tags = (tagsRaw ?? '').trim();
    pairs += 1;
    const entry = byWord.get(key) ?? { lower: [], capital: [], plural: [], gender: undefined };
    // "pl" rows repeat the singular's translation under the plural headword —
    // except when the plural IS the singular ("Sammler"), where the pl row is
    // the only row there is. Kept aside as a last resort.
    const bucket = /\bpl\b/.test(tags)
      ? entry.plural
      : /^[A-ZÄÖÜ]/.test((germanRaw ?? '').trim())
        ? entry.capital
        : entry.lower;
    for (const part of turkish) {
      if (!bucket.includes(part) && bucket.length < MAX_TURKISH) bucket.push(part);
    }
    if (!entry.gender) {
      const gender = tags.match(/^\s*([mfn])\b/)?.[1];
      if (gender) entry.gender = gender;
    }
    byWord.set(key, entry);
  }
  console.log(`FreeDict: ${byWord.size} headwords from ${pairs} pairs`);
  return byWord;
}

/** The distilled Wiktionary lines, grouped by normalized headword. */
function loadWiktionary() {
  if (!existsSync(WIKTIONARY)) {
    throw new LexiconError(
      'scripts/lexicon/wiktionary-de.jsonl is missing: run npm run lexicon:fetch',
    );
  }
  const byWord = new Map();
  let lines = 0;
  for (const line of readFileSync(WIKTIONARY, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    lines += 1;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new LexiconError(`wiktionary-de.jsonl line ${lines} is not valid JSON`);
    }
    const raw = String(record.w ?? '').trim();
    const key = normalizeWord(raw);
    // Digit-led headwords ("50er") would case-fold onto the word their letters
    // spell — and bury the pronoun "er" under the fifties.
    if (!key || AFFIX_RE.test(raw) || /^\d/.test(raw)) continue;
    const bucket = byWord.get(key) ?? [];
    bucket.push(record);
    byWord.set(key, bucket);
  }
  console.log(`Wiktionary: ${byWord.size} headwords from ${lines} entries`);
  return byWord;
}

/**
 * Hand-written entries. A plain list supplies only the Turkish; an object may
 * also replace the headword and its definition, which is how the closed class
 * of function words gets fixed — "sind" is a form of "sein", not a province in
 * Pakistan, and no amount of ranking heuristics will work that out.
 */
function loadOverrides() {
  if (!existsSync(OVERRIDES)) return new Map();
  const raw = JSON.parse(readFileSync(OVERRIDES, 'utf8'));
  const byWord = new Map();
  for (const [word, value] of Object.entries(raw)) {
    const key = normalizeWord(word);
    const turkish = Array.isArray(value) ? value : value?.tr;
    if (!key || !Array.isArray(turkish) || turkish.length === 0) {
      throw new LexiconError(`turkish-overrides.json: "${word}" must map to a non-empty list`);
    }
    byWord.set(key, {
      turkish: turkish.slice(0, MAX_TURKISH).map((t) => String(t).trim()),
      lemma: Array.isArray(value) ? undefined : value.lemma,
      pos: Array.isArray(value) ? undefined : value.pos,
      genus: Array.isArray(value) ? undefined : value.genus,
      plural: Array.isArray(value) ? undefined : value.plural,
      definitions: Array.isArray(value) ? undefined : value.de,
    });
  }
  console.log(`overrides: ${byWord.size} hand-written entries`);
  return byWord;
}

/* -------------------------------------------------------------------- merge */

/** Ranks the readings of one headword; a real entry beats a form-of page. */
function rankRecord(record) {
  return [
    record.b ? 0 : 1,
    POS_RANK[record.p] ?? 9,
    -(record.d?.length ?? 0),
    -(record.t?.length ?? 0),
  ];
}

function betterFirst(a, b) {
  const ra = rankRecord(a);
  const rb = rankRecord(b);
  for (let i = 0; i < ra.length; i += 1) {
    if (ra[i] !== rb[i]) return ra[i] - rb[i];
  }
  return 0;
}

function buildEntries(freedict, wiktionary, overrides, pointerOnly) {
  const entries = new Map();
  const keys = new Set([...freedict.keys(), ...wiktionary.keys(), ...overrides.keys()]);

  for (const key of keys) {
    const all = (wiktionary.get(key) ?? []).slice().sort(betterFirst);
    // Pages that only document an inflected form contribute a pointer, never a
    // definition: "Nominativ Plural des Substantivs Schicht" is not a meaning.
    const records = all.filter((record) => !isPointerOnly(record));
    const pointers = all.filter(isPointerOnly);
    const senses = [];
    for (const record of records) {
      if (senses.length >= MAX_SENSES) break;
      // A second reading only earns its bytes when it is a different word class.
      if (senses.some((s) => s.p === record.p)) continue;
      const sense = { l: record.w };
      if (record.p) sense.p = record.p;
      if (record.g && GENDERS.has(record.g)) sense.g = record.g;
      if (record.pl) sense.pl = record.pl;
      if (record.d?.length) sense.d = record.d;
      senses.push(sense);
    }

    // A hand-written entry replaces the reading outright when it names one.
    const override = overrides.get(key);
    if (override?.lemma) {
      senses.length = 0;
      const sense = { l: override.lemma };
      if (override.pos) sense.p = override.pos;
      if (override.genus) sense.g = override.genus;
      if (override.plural) sense.pl = override.plural;
      if (override.definitions?.length) sense.d = override.definitions;
      senses.push(sense);
    }

    // Turkish, best source first: hand-written, then FreeDict, then Wiktionary.
    let turkish = override?.turkish;
    let source = 'auth';
    if (!turkish) {
      const fd = freedict.get(key);
      if (fd) {
        // The rows whose casing matches the winning reading: a verb takes the
        // lowercase rows, a noun the capitalised ones — otherwise the noun
        // "Wirtschaften" hands its restaurant to the verb "wirtschaften".
        const pos = senses[0]?.p;
        let list;
        if (pos === 'noun') list = fd.capital.length > 0 ? fd.capital : fd.lower;
        else if (pos) list = fd.lower.length > 0 ? fd.lower : fd.capital;
        else list = [...new Set([...fd.capital, ...fd.lower])];
        // The pl-row fallback ("Sammler") may flesh out a real entry but must
        // never turn a bare inflection pointer into a card of its own.
        if (list.length === 0 && senses.length > 0) list = fd.plural;
        if (list.length > 0) {
          turkish = list.slice(0, MAX_TURKISH);
          source = 'fd';
        }
      }
    }
    if (!turkish) {
      const merged = [];
      for (const record of records) {
        for (const word of record.t ?? []) {
          for (const cleaned of cleanTurkish(word)) {
            if (!merged.includes(cleaned) && merged.length < MAX_TURKISH) merged.push(cleaned);
          }
        }
      }
      turkish = merged.length > 0 ? merged : undefined;
      source = 'wt';
    }

    // Nothing but inflection pointers and no translation: the form index below
    // already reaches the real headword, so this would be an empty card.
    if (senses.length === 0 && !turkish && pointers.length === 0) continue;
    if (senses.length === 0 && !turkish) {
      const target = pointers.map(formOfTarget).find(Boolean);
      if (target) {
        pointerOnly.set(key, target);
        continue;
      }
      continue;
    }

    // A FreeDict-only headword still deserves a card, with what little is known.
    if (senses.length === 0) senses.push({ l: key });

    const entry = { s: senses };
    const ipa = all.find((record) => record.i)?.i;
    if (ipa) entry.i = ipa;
    // "schichten" is both a verb in its own right and the plural of "Schicht";
    // German tells them apart by capitalisation, so keep the other reading
    // reachable and let the runtime pick by how the reader saw the word.
    // Among several pointer targets, prefer the reading this entry lacks:
    // "neue" (a nominalised noun) should point at the adjective "neu", not at
    // the sibling nominalisation "neues".
    const targets = [];
    for (const pointer of pointers) {
      const target = formOfTarget(pointer);
      if (target && target !== key && !targets.includes(target)) targets.push(target);
    }
    if (targets.length > 0) {
      const nounHere = entry.s.some((sense) => sense.p === 'noun');
      const realRecords = (target) =>
        (wiktionary.get(target) ?? []).filter((record) => !isPointerOnly(record));
      entry.of =
        targets.find((target) =>
          realRecords(target).some((record) =>
            nounHere ? record.p !== 'noun' : record.p === 'noun',
          ),
        ) ??
        targets.find((target) => realRecords(target).length > 0) ??
        targets[0];
    }
    // A FreeDict gender tag describes a noun row; it must not stick a "das" on
    // the verb "können" just because "das Können" case-folds onto the same key.
    if (
      !entry.s[0].g &&
      (entry.s[0].p === undefined || entry.s[0].p === 'noun') &&
      freedict.get(key)?.gender
    ) {
      entry.s[0].g = freedict.get(key).gender;
    }
    if (turkish) {
      entry.t = turkish;
      entry.src = source;
    }
    entries.set(key, entry);
  }

  console.log(`merged: ${entries.size} lexicon entries`);
  return entries;
}

/** Inflected form -> lemma key, for forms that are not headwords themselves. */
function buildFormIndex(wiktionary, entries, pointerOnly) {
  const forms = new Map();
  // Pages that were nothing but an inflection pointer become index rows.
  for (const [form, lemma] of pointerOnly) {
    if (!entries.has(form) && entries.has(lemma)) forms.set(form, lemma);
  }
  for (const [key, records] of wiktionary) {
    if (!entries.has(key)) continue;
    for (const record of records) {
      for (const form of record.f ?? []) {
        if (form === key || entries.has(form) || forms.has(form)) continue;
        forms.set(form, key);
      }
    }
  }
  // A pointer page carries its own declension too: "Arbeiterin" lists
  // "Arbeiterinnen", and both belong to the lemma the pointer names — without
  // this the female plurals fall through to the suffix heuristics.
  for (const [key, records] of wiktionary) {
    const lemma = pointerOnly.get(key);
    if (!lemma || !entries.has(lemma)) continue;
    for (const record of records) {
      for (const form of record.f ?? []) {
        if (form === lemma || entries.has(form) || forms.has(form)) continue;
        forms.set(form, lemma);
      }
    }
  }
  console.log(`forms: ${forms.size} inflected forms mapped to a lemma`);
  return forms;
}

/* ------------------------------------------------------------------ emitting */

const shardBytes = (shard) => JSON.stringify(shard).length + 1;

/**
 * Buckets every key by prefix, lengthening the prefix wherever a bucket grows
 * past MAX_SHARD_BYTES. A key shorter than the longer prefix settles at that
 * level under its underscore-padded name ("er" -> er_.json during the 3-letter
 * split); the runtime rebuilds the same names by probing every length from
 * MAX_PREFIX down, padding the same way.
 */
function buildShards(entries, forms) {
  // Start with everything in one bucket per first letter, then split.
  let level = 1;
  let buckets = new Map();
  const place = (map, key, put) => {
    const name = shardName(key, level);
    let shard = map.get(name);
    if (!shard) {
      shard = { e: {}, f: {} };
      map.set(name, shard);
    }
    put(shard);
  };
  for (const [key, entry] of entries) place(buckets, key, (s) => (s.e[key] = entry));
  // Indexed under the form's own prefix: that is what the runtime looks up.
  for (const [form, lemma] of forms) place(buckets, form, (s) => (s.f[form] = lemma));

  const done = new Map();
  /**
   * Files a finished shard, merging when one of that name is already there.
   *
   * A short key settles into `done` under its padded name ("an" -> an_), and a
   * longer key whose prefix has punctuation in it collapses to the same name
   * one level later ("an sich" -> "an " -> an_). Assigning instead of merging
   * dropped whichever arrived first, silently: nine entries and one form,
   * every one of them a short high-frequency word — an, aus, ab, be, st, ko,
   * g, l, r. The build counted them, the shard files never held them, and
   * `lexicon:check` compares against the in-memory build, so nothing noticed.
   */
  const file = (name, shard) => {
    const existing = done.get(name);
    if (!existing) {
      done.set(name, shard);
      return;
    }
    Object.assign(existing.e, shard.e);
    Object.assign(existing.f, shard.f);
  };

  while (level < MAX_PREFIX) {
    const oversized = new Map();
    for (const [name, shard] of buckets) {
      if (shardBytes(shard) <= MAX_SHARD_BYTES) file(name, shard);
      else oversized.set(name, shard);
    }
    if (oversized.size === 0) break;
    level += 1;
    const next = new Map();
    for (const shard of oversized.values()) {
      for (const [key, entry] of Object.entries(shard.e)) {
        // Too short to reach the longer prefix: it settles here for good,
        // under its padded name for this level.
        const target = key.length >= level ? next : done;
        place(target, key, (s) => (s.e[key] = entry));
      }
      for (const [form, lemma] of Object.entries(shard.f)) {
        const target = form.length >= level ? next : done;
        place(target, form, (s) => (s.f[form] = lemma));
      }
    }
    buckets = next;
  }
  for (const [name, shard] of buckets) file(name, shard);

  // The shards are what ships; the maps above are only how they were computed.
  // Counting one and trusting the other is exactly how the collision above went
  // unnoticed for as long as it did.
  let placedEntries = 0;
  let placedForms = 0;
  for (const shard of done.values()) {
    placedEntries += Object.keys(shard.e).length;
    placedForms += Object.keys(shard.f).length;
  }
  if (placedEntries !== entries.size || placedForms !== forms.size) {
    throw new LexiconError(
      `sharding lost data: ${entries.size - placedEntries} entr(ies) and ` +
        `${forms.size - placedForms} form(s) never reached a shard`,
    );
  }
  return done;
}

function serializeRegistry(names) {
  const lines = [
    '// Generated by scripts/build-lexicon.mjs — do not edit by hand.',
    '// Run `npm run lexicon:build` after changing anything in scripts/lexicon/.',
    '',
    '/** One shard of the bundled lexicon: entries and inflected forms by prefix. */',
    'export type LexiconShard = {',
    '  e: Record<string, unknown>;',
    '  f: Record<string, string>;',
    '};',
    '',
    '/**',
    ' * Prefix -> loader. The requires are lazy on purpose: Metro inlines them, so',
    ' * a shard is parsed the first time a word with that prefix is tapped and',
    ' * never at startup.',
    ' */',
    'export const LEXICON_SHARDS: Record<string, () => LexiconShard> = {',
  ];
  for (const name of names) {
    lines.push(
      `  ${JSON.stringify(name)}: () => require('../../assets/data/lexicon/${name}.json'),`,
    );
  }
  lines.push('};', '');
  return lines.join('\n');
}

/* -------------------------------------------------------------- measurement */

/** What share of the corpus a reader can now tap and get an entry for. */
function measureCoverage(entries, forms) {
  // Mirrors SUFFIXES in src/data/germanForms.ts, restore lists included.
  const SUFFIXES = [
    ['erinnen', ['er', 'erin']], ['ungen', ['ung']], ['innen', ['in']],
    ['keiten', ['keit']], ['heiten', ['heit']], ['sten', []], ['eren', []],
    ['erem', []], ['eres', []], ['ten', []], ['tet', []], ['est', []],
    ['ere', []], ['em', []], ['en', []], ['er', []], ['es', []], ['st', []],
    ['te', []], ['e', []], ['n', []], ['s', []], ['t', []],
  ];
  const candidates = (word) => {
    const list = [word];
    for (const [suffix, restore] of SUFFIXES) {
      if (word.length - suffix.length < 3 || !word.endsWith(suffix)) continue;
      const stem = word.slice(0, -suffix.length);
      for (const ending of restore) list.push(`${stem}${ending}`);
      list.push(stem, `${stem}en`, `${stem}e`);
    }
    if (word.startsWith('ge') && word.length >= 5) {
      const stem = word.slice(2);
      if (stem.endsWith('t')) list.push(`${stem.slice(0, -1)}en`);
      if (stem.endsWith('en')) list.push(stem);
    }
    return list;
  };
  const resolves = (word) =>
    candidates(word).some((c) => entries.has(c) || forms.has(c)) ||
    (() => {
      for (let i = 3; i <= word.length - 4; i += 1) {
        const tail = word.slice(i);
        if (entries.has(tail) || forms.has(tail)) return true;
      }
      return false;
    })();

  let tokens = 0;
  let hits = 0;
  let turkish = 0;
  const missing = new Map();
  for (const booklet of JSON.parse(readFileSync(DATASET, 'utf8'))) {
    for (const section of booklet.sections) {
      const german = section.parts?.['Almanca (orijinal)'];
      if (!german) continue;
      for (const raw of german.match(/[A-Za-zÄÖÜäöüß]{2,}/g) ?? []) {
        const word = normalizeWord(raw);
        if (!word) continue;
        tokens += 1;
        if (!resolves(word)) continue;
        hits += 1;
        const lemma = candidates(word).find((c) => entries.has(c) || forms.has(c));
        let key = entries.has(lemma) ? lemma : forms.get(lemma);
        let entry = entries.get(key);
        // The runtime follows `of` to the word's other reading; grade — and
        // attribute the missing report — the same way, or "neue" gets billed
        // to the nominalised "Neue" instead of the adjective "neu".
        if (entry && !entry.t && entry.of && entries.has(entry.of)) {
          key = entry.of;
          entry = entries.get(key);
        }
        if (entry?.t) turkish += 1;
        else if (entry) missing.set(key, (missing.get(key) ?? 0) + 1);
      }
    }
  }
  return { tokens, hits, turkish, missing };
}

/* ------------------------------------------------------------------ compare */

function writeIfChanged(path, content, check, changed) {
  if (check) {
    if (!existsSync(path)) throw new LexiconError(`${path} is missing: run npm run lexicon:build`);
    if (readFileSync(path, 'utf8') !== content) {
      throw new LexiconError(`${path} is stale: run npm run lexicon:build`);
    }
    return;
  }
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return;
  writeFileSync(path, content, { encoding: 'utf8' });
  changed.count += 1;
}

/* --------------------------------------------------------------------- main */

const check = process.argv.includes('--check');

try {
  const freedict = loadFreeDict();
  const wiktionary = loadWiktionary();
  const overrides = loadOverrides();

  const pointerOnly = new Map();
  const entries = buildEntries(freedict, wiktionary, overrides, pointerOnly);
  if (entries.size < 28000) {
    throw new LexiconError(`only ${entries.size} entries merged; expected at least 28000`);
  }
  const forms = buildFormIndex(wiktionary, entries, pointerOnly);
  const shards = buildShards(entries, forms);
  const names = [...shards.keys()].sort();

  const changed = { count: 0 };
  if (!check) {
    mkdirSync(SHARD_DIR, { recursive: true });
    for (const stale of readdirSync(SHARD_DIR)) {
      if (stale.endsWith('.json') && !shards.has(stale.replace(/\.json$/, ''))) {
        rmSync(join(SHARD_DIR, stale));
      }
    }
  }

  let bytes = 0;
  let largest = { name: '', size: 0 };
  for (const name of names) {
    const content = `${JSON.stringify(shards.get(name))}\n`;
    bytes += content.length;
    if (content.length > largest.size) largest = { name, size: content.length };
    writeIfChanged(join(SHARD_DIR, `${name}.json`), content, check, changed);
  }

  // The corpus only grades the result; it never shapes a shard. The public
  // lexicon repository builds without it, and the shards come out identical.
  const coverage = existsSync(DATASET) ? measureCoverage(entries, forms) : null;
  const meta = {
    version: 1,
    generated: 'scripts/build-lexicon.mjs — do not edit by hand',
    entries: entries.size,
    forms: forms.size,
    shards: names.length,
    withTurkish: [...entries.values()].filter((e) => e.t).length,
    sources: [
      'FreeDict deu-tur (GNU GPL) — Erdal Ronahi u.a.',
      'Wiktionary, German edition (CC BY-SA / GFDL), extracted with wiktextract',
    ],
  };
  writeIfChanged(META, `${JSON.stringify(meta, null, 2)}\n`, check, changed);
  writeIfChanged(REGISTRY, serializeRegistry(names), check, changed);

  if (!check && coverage) {
    const report = [...coverage.missing.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MISSING_REPORT_LIMIT)
      .map(([word, count]) => {
        const gloss = entries.get(word)?.s?.[0]?.d?.[0] ?? '';
        return `${count}\t${entries.get(word)?.s?.[0]?.l ?? word}\t${gloss}`;
      });
    writeFileSync(
      MISSING,
      `# Corpus words with no Turkish yet, most frequent first.\n` +
        `# count<TAB>headword<TAB>German definition — fill these into turkish-overrides.json.\n` +
        `${report.join('\n')}\n`,
      { encoding: 'utf8' },
    );
  }

  console.log(
    `${check ? 'validated' : 'wrote'} lexicon: ${entries.size} entries + ${forms.size} forms ` +
      `in ${names.length} shards (${(bytes / 1e6).toFixed(1)} MB, largest ` +
      `${largest.name}=${(largest.size / 1024).toFixed(0)} KB)`,
  );
  if (coverage) {
    console.log(
      `corpus coverage: ${((100 * coverage.hits) / coverage.tokens).toFixed(1)}% of tokens ` +
        `resolve (${((100 * coverage.turkish) / coverage.tokens).toFixed(1)}% with Turkish), ` +
        `${coverage.missing.size} distinct words still need Turkish`,
    );
  } else {
    console.log('corpus coverage: skipped (assets/data/booklets.json is not present)');
  }
} catch (error) {
  if (error instanceof LexiconError || error instanceof SyntaxError) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
