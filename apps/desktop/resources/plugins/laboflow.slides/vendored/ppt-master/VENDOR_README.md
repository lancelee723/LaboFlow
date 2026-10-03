# Vendored: PPT-Master (LaboFlow L2 slide engine)

- Upstream: https://github.com/hugohe3/ppt-master — MIT License (see LICENSE)
- Pinned: commit aee33e5 (post v6.3.2, cloned 2026-09-12). See VENDOR_VERSION.
- Pruned vs upstream: references/ai-image-comparison (AI-image route disabled),
  templates/sounds (narration route disabled), sponsor docs (SPONSORS.md/CN KEPT — upstream attribution guard fails closed without them).
- LaboFlow additions: requirements-laboflow.txt (PyMuPDF/pandoc REMOVED —
  AGPL/GPL guard), VENDOR_README.md.
- Integration contract: LaboFlow drives this skill through its script
  boundaries only (scripts/*.py); the SKILL.md corpus guides the agent. Do not
  modify vendored files; upgrades replace this directory and rerun the
  adapter tests (apps/desktop/test/ppt-master-runtime.test.mjs + test/bundled-plugins.test.mjs (Slides section)).

## Upstream drift audit (2026-10-03)

Pin aee33e5 (v6.3.2 post) audited against upstream origin/main and tags
v6.5.0/v6.6.0: the pin sits 92 commits behind v6.6.0 (8 via local checkout
cf1c2eb9 + 84 more). Verdict: **no forced re-vendor**.

- requirements.txt: zero drift — no new AGPL/GPL exposure.
- Whitelisted CLI surface: svg_quality_checker.py / finalize_svg.py /
  project_manager.py unchanged; total_md_split.py (21), text_measure.py
  (278) and svg_to_pptx cli.py (444) drifted, but every flag our argspec
  pins (project_path, -o, -s, -f, --quick-generate,
  --native-charts-and-tables) still exists at v6.6.0. The argspec snapshot
  tests must be re-baselined on the next re-vendor.
- The 92 commits are quality work (text-measure font advances for
  Segoe/Cambria/etc., Indic/Thai/mixed-run fixes, Morph planning,
  edit-native hardening, --kiosk) — pure gains, none of them fixes or
  breaks a LaboFlow integration point.

Re-vendor recipe (when scheduled): copy skills/ppt-master@v6.6.0 → prune
ai-image-comparison + templates/sounds → keep SPONSORS/LICENSE (attribution
guard) → refresh requirements-laboflow.txt against the new upstream list →
rerun ppt-script-whitelist argspec snapshots + bundled + PPT_IT.
