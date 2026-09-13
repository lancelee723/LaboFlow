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
