// Bundles the Qloo fixtures into one TypeScript module so the demo works anywhere the server runs,
// including a Cloudflare Worker, which has no filesystem to read JSON from at runtime.
//
// Input:  fixtures/qloo/index.json          public, hand-authored placeholders   { "<canonical url>": "<file>.json" }
//         private/qloo/index.json           live captures (optional, gitignored)  same shape, same canonical keys
// Output: src/demo/fixtures.generated.ts    one static JSON import per file, plus a lookup table keyed
//                                           by canonical URL (see src/canonical.ts). A BUILD ARTIFACT:
//                                           gitignored, rebuilt by `npm run prepare:data`.
//
// Data rule: live Qloo responses must never be committed or shipped in the public static mirror. The
// public set is always bundled; when private/qloo exists (scripts/record.mjs wrote captures there), its
// entries overlay the public ones key by key. A fresh checkout (GitHub Actions, a judge's clone) has
// no private/ so it bundles placeholders only. Only the wrapper flags of each fixture (_handAuthored,
// _captured) are read here, never the responses, so the bundle can be regenerated while fixture
// responses are still being filled in.
//
//   node scripts/bundle-fixtures.mjs          (or: npm run prepare:data, which scaffolds first)

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT_PATH = path.join(ROOT, "src", "demo", "fixtures.generated.ts");

// Import specifiers from src/demo/ to each fixture folder (always forward slashes, they are module paths).
const SOURCES = [
  { name: "public", dir: path.join(ROOT, "fixtures", "qloo"), importPrefix: "../../fixtures/qloo/" },
  { name: "private", dir: path.join(ROOT, "private", "qloo"), importPrefix: "../../private/qloo/" },
];

const rel = (file) => path.relative(ROOT, file);

function readIndex(source) {
  const indexPath = path.join(source.dir, "index.json");
  if (!fs.existsSync(indexPath)) return undefined;
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const entries = Object.entries(index);
  const missing = [];
  for (const [, file] of entries) {
    if (typeof file !== "string" || !file || file.includes("/") || file.includes("\\")) {
      console.error(`${rel(indexPath)}: invalid file name ${JSON.stringify(file)}`);
      process.exit(1);
    }
    if (!fs.existsSync(path.join(source.dir, file))) missing.push(file);
  }
  if (missing.length) {
    // A missing file would be a compile error in the generated module, so stop here with a clear list.
    console.error(`${rel(indexPath)} lists ${missing.length} file(s) that do not exist in ${rel(source.dir)}:\n  ${missing.join("\n  ")}`);
    process.exit(1);
  }
  return entries;
}

// Provenance flags from the file wrapper. The response is not inspected.
function flagsOf(source, file) {
  try {
    const f = JSON.parse(fs.readFileSync(path.join(source.dir, file), "utf8"));
    return { handAuthored: f._handAuthored !== false, captured: typeof f._captured === "string" && f._captured ? f._captured : null };
  } catch (err) {
    console.error(`${rel(path.join(source.dir, file))} is not valid JSON: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

const publicEntries = readIndex(SOURCES[0]);
if (!publicEntries) {
  console.error(`No fixture index at ${rel(path.join(SOURCES[0].dir, "index.json"))}. Run scripts/scaffold-fixtures.mjs first.`);
  process.exit(1);
}
const privateEntries = readIndex(SOURCES[1]) ?? [];

// canonical URL -> { source, file }, public first, private overlaying the same keys (and adding any new ones).
const chosen = new Map();
for (const [canonical, file] of publicEntries) chosen.set(canonical, { source: SOURCES[0], file });
let overlaid = 0;
for (const [canonical, file] of privateEntries) {
  if (chosen.has(canonical)) overlaid++;
  chosen.set(canonical, { source: SOURCES[1], file });
}

// Turn "rooms-asheville-nc.json" into the identifier "rooms_asheville_nc" so the generated table
// reads naturally. Identifiers must be unique and must not start with a digit.
const taken = new Set();
function identifierFor(prefix, file, i) {
  let id = (prefix + file.replace(/\.json$/i, "")).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/^[A-Za-z_]/.test(id)) id = "f_" + id;
  if (taken.has(id) || id === "") id = `${id || "f"}_${i}`;
  taken.add(id);
  return id;
}

const imports = [];
const rows = [];
const provenanceRows = [];
let handAuthoredCount = 0;
let capturedCount = 0;
let i = 0;
for (const [canonical, { source, file }] of chosen) {
  const id = identifierFor(source.name === "private" ? "private_" : "", file, i++);
  const flags = flagsOf(source, file);
  if (flags.handAuthored) handAuthoredCount++;
  if (flags.captured) capturedCount++;
  imports.push(`import ${id} from ${JSON.stringify(source.importPrefix + file)} with { type: "json" };`);
  rows.push(`  ${JSON.stringify(canonical)}: ${id},`);
  provenanceRows.push(`  ${JSON.stringify(canonical)}: ${JSON.stringify({ file, source: source.name, handAuthored: flags.handAuthored, captured: flags.captured })},`);
}

const generatedAt = new Date().toISOString();
const source = `// GENERATED FILE. Do not edit by hand; run \`npm run prepare:data\` instead. Gitignored build artifact.
//
// Produced by scripts/bundle-fixtures.mjs from fixtures/qloo/index.json (public placeholders) with
// private/qloo/index.json overlaid when present (live captures, never committed). Each Qloo response
// is imported statically so the Worker bundle carries the whole demo with it. The keys are canonical
// request URLs (src/canonical.ts), which is also how src/demo/resolver.ts looks a request up.

import type { FixtureFile } from "./resolver.ts";

${imports.join("\n")}

// When this module was last generated (ISO 8601).
export const generatedAt = ${JSON.stringify(generatedAt)};

// Number of fixtures bundled (public plus private overlay, one per canonical URL).
export const fixtureCount = ${chosen.size};

// How many of them came from private/qloo (live captures) rather than the public placeholder set.
export const privateCount = ${privateEntries.length};

// Where each fixture came from and its provenance flags, keyed by canonical request URL.
export const provenance: Record<string, { file: string; source: "public" | "private"; handAuthored: boolean; captured: string | null }> = {
${provenanceRows.join("\n")}
};

// Every fixture, keyed by canonical request URL.
export const fixtures: Record<string, FixtureFile> = {
${rows.join("\n")}
};
`;

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, source);
console.log(
  `${chosen.size} fixtures bundled into ${rel(OUT_PATH)}: ${publicEntries.length} public${privateEntries.length ? `, ${privateEntries.length} private (${overlaid} overlaying public keys)` : ", no private/qloo overlay"}; ${handAuthoredCount} hand-authored, ${capturedCount} captured`,
);
if (privateEntries.length) console.log(`  private/ holds live Qloo data: never commit it and never build the public mirror from it.`);
