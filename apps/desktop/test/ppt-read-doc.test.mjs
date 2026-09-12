import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listDocDir,
  MAX_DOC_BYTES,
  normalizeRelPath,
  resolveDocEntry,
} from "../resources/plugins/laboflow.slides/lib/ppt-read-doc.js";

/** Build a miniature vendored-ppt-master corpus fixture. */
function makeCorpus() {
  const root = mkdtempSync(join(tmpdir(), "ppt-corpus-"));
  for (const dir of ["workflows/stages", "references", "scripts/docs", "templates/brands", "scripts/svg_to_pptx"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, "SKILL.md"), "# PPT Master Skill\n");
  writeFileSync(join(root, "workflows", "routing.md"), "# Routing\n");
  writeFileSync(join(root, "workflows", "stages", "topic-research.md"), "# Topic research\n");
  writeFileSync(join(root, "references", "strategist.md"), "# Strategist\n");
  writeFileSync(join(root, "scripts", "docs", "confirm_ui.md"), "# Confirm UI\n");
  writeFileSync(join(root, "templates", "brands", "_index.json"), "[]");
  writeFileSync(join(root, "templates", "brands", "design_spec.md"), "# Brand spec\n");
  writeFileSync(join(root, "templates", "brands", "logo.svg"), "<svg/>");
  writeFileSync(join(root, "templates", "brands", "deep.json"), "{}");
  writeFileSync(join(root, "scripts", "svg_to_pptx.py"), "print('nope')");
  return root;
}

test("normalizeRelPath rejects traversal, absolute and NUL paths", () => {
  assert.equal(normalizeRelPath("../etc/passwd"), null);
  assert.equal(normalizeRelPath("workflows/../../etc"), null);
  assert.equal(normalizeRelPath("/etc/passwd"), null);
  assert.equal(normalizeRelPath("a\0b"), null);
  assert.equal(normalizeRelPath(""), null);
  assert.equal(normalizeRelPath("./workflows/routing.md"), "workflows/routing.md");
  assert.equal(normalizeRelPath("workflows/routing.md"), "workflows/routing.md");
});

test("whitelisted corpus docs resolve; everything else is refused", () => {
  const root = makeCorpus();
  for (const rel of [
    "SKILL.md",
    "workflows/routing.md",
    "workflows/stages/topic-research.md",
    "references/strategist.md",
    "scripts/docs/confirm_ui.md",
  ]) {
    const entry = resolveDocEntry(root, rel);
    assert.equal(entry.ok, true, `${rel} must be readable`);
    assert.equal(entry.kind, "file");
  }
  for (const rel of [
    "scripts/svg_to_pptx.py",
    "scripts/laboflow_guard.py",
    "requirements-laboflow.txt",
    "templates/brands/logo.svg",
    "templates/brands/deep.json",
    "templates/brands/nope/deep.json",
    "VENDOR_VERSION",
  ]) {
    const entry = resolveDocEntry(root, rel);
    assert.equal(entry.ok, false, `${rel} must be refused`);
  }
});

test("template indexes and template markdown are readable, two levels only", () => {
  const root = makeCorpus();
  assert.equal(resolveDocEntry(root, "templates/brands").ok, true, "category dir lists");
  assert.equal(resolveDocEntry(root, "templates/brands/_index.json").ok, true);
  assert.equal(resolveDocEntry(root, "templates/brands/design_spec.md").ok, true);
  assert.equal(resolveDocEntry(root, "templates/brands/sub/x.md").ok, false, "three levels rejected");
});

test("symlink escapes are refused", () => {
  const root = makeCorpus();
  const outside = mkdtempSync(join(tmpdir(), "ppt-outside-"));
  const secret = join(outside, "secret.md");
  writeFileSync(secret, "top secret");
  try {
    symlinkSync(secret, join(root, "references", "leak.md"));
  } catch {
    return; // filesystem without symlink support — skip
  }
  const entry = resolveDocEntry(root, "references/leak.md");
  assert.equal(entry.ok, false, "symlink pointing outside the corpus must be refused");
});

test("directories resolve to listings with doc hints", () => {
  const root = makeCorpus();
  const entry = resolveDocEntry(root, "workflows");
  assert.equal(entry.ok, true);
  assert.equal(entry.kind, "dir");
  const listing = listDocDir(root, entry.absPath, "workflows");
  assert.ok(listing.entries.includes("routing.md"));
  assert.ok(listing.entries.includes("stages/"));
  assert.match(listing.hint, /ppt_read_doc/);
});

test("doc listings refuse non-whitelisted directories", () => {
  const root = makeCorpus();
  assert.equal(resolveDocEntry(root, "scripts").ok, false, "scripts/ itself is not listable");
  assert.equal(resolveDocEntry(root, "scripts/svg_to_pptx").ok, false);
});

test("oversized docs are reported for truncation at the 1 MiB cap", async () => {
  const root = makeCorpus();
  const big = "x".repeat(MAX_DOC_BYTES + 4096);
  writeFileSync(join(root, "workflows", "big.md"), big);
  const entry = resolveDocEntry(root, "workflows/big.md");
  assert.equal(entry.ok, true);
  const { readFile } = await import("node:fs/promises");
  const buffer = await readFile(entry.absPath);
  assert.equal(buffer.length > MAX_DOC_BYTES, true, "fixture must exceed the cap");
  assert.equal(buffer.subarray(0, MAX_DOC_BYTES).length, MAX_DOC_BYTES);
});
