// Bundles the recorded Qloo fixtures into one TypeScript module so the demo works anywhere the
// server runs, including a Cloudflare Worker, which has no filesystem to read JSON from at runtime.
//
// Input:  fixtures/qloo/index.json          { "<canonical url>": "<file>.json", ... }
// Output: src/demo/fixtures.generated.ts    one static JSON import per file, plus a lookup table
//                                           keyed by canonical URL (see src/canonical.ts)
//
// Only the index (keys and file names) is read. Fixture *contents* are never parsed here, so the
// bundle can be regenerated while fixture responses are still being filled in. The generated module
// is what src/demo/resolver.ts answers from when QLOO_API_KEY is absent.
//
//   node scripts/bundle-fixtures.mjs          (or: npm run fixtures, which scaffolds first)

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const FIXTURE_DIR = path.join(ROOT, "fixtures", "qloo");
const INDEX_PATH = path.join(FIXTURE_DIR, "index.json");
const OUT_PATH = path.join(ROOT, "src", "demo", "fixtures.generated.ts");

// Import specifier from src/demo/ to the fixture folder (always forward slashes, it is a module path).
const IMPORT_PREFIX = "../../fixtures/qloo/";

if (!fs.existsSync(INDEX_PATH)) {
  console.error(`No fixture index at ${path.relative(ROOT, INDEX_PATH)}. Run scripts/scaffold-fixtures.mjs first.`);
  process.exit(1);
}

/** @type {Record<string, string>} canonical URL -> file name, in index order */
const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
const entries = Object.entries(index);

// Turn "rooms-asheville-nc.json" into the identifier "rooms_asheville_nc" so the generated table
// reads naturally. Identifiers must be unique and must not start with a digit.
const taken = new Set();
function identifierFor(file, i) {
  let id = file.replace(/\.json$/i, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/^[A-Za-z_]/.test(id)) id = "f_" + id;
  if (taken.has(id) || id === "") id = `${id || "f"}_${i}`;
  taken.add(id);
  return id;
}

const missing = [];
const imports = [];
const rows = [];
entries.forEach(([canonical, file], i) => {
  if (typeof file !== "string" || !file || file.includes("/") || file.includes("\\")) {
    console.error(`index.json: entry ${i} has an invalid file name: ${JSON.stringify(file)}`);
    process.exit(1);
  }
  if (!fs.existsSync(path.join(FIXTURE_DIR, file))) missing.push(file);
  const id = identifierFor(file, i);
  imports.push(`import ${id} from ${JSON.stringify(IMPORT_PREFIX + file)} with { type: "json" };`);
  rows.push(`  ${JSON.stringify(canonical)}: ${id},`);
});

if (missing.length) {
  // A missing file would be a compile error in the generated module, so stop here with a clear list.
  console.error(`index.json lists ${missing.length} file(s) that do not exist in fixtures/qloo:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

const generatedAt = new Date().toISOString();
const source = `// GENERATED FILE. Do not edit by hand; run \`npm run fixtures\` instead.
//
// Produced by scripts/bundle-fixtures.mjs from fixtures/qloo/index.json. Each recorded Qloo response
// is imported statically so the Worker bundle carries the whole demo with it. The keys are canonical
// request URLs (src/canonical.ts), which is also how src/demo/resolver.ts looks a request up.

import type { FixtureFile } from "./resolver.ts";

${imports.join("\n")}

// When this module was last generated (ISO 8601).
export const generatedAt = ${JSON.stringify(generatedAt)};

// Number of fixtures bundled.
export const fixtureCount = ${entries.length};

// Every recorded fixture, keyed by canonical request URL.
export const fixtures: Record<string, FixtureFile> = {
${rows.join("\n")}
};
`;

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, source);
console.log(`${entries.length} fixtures bundled into ${path.relative(ROOT, OUT_PATH)}`);
