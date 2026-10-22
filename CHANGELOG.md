# Changelog

## v1.0.0 — 2026-10-23

First public release.

- Guided 4-step workflow: sources → capability boundary → build → export.
- Deterministic skill package generator: `SKILL.md`, scripts, references, tests, `studio.json`.
- Real contract validation: frontmatter, sections, `node --check`, secret scan, catalog overlap, test spec.
- Zero-dependency HTTP server and browser UI.
- Native macOS app (Swift + WKWebView) that boots the local server and opens a real window.
- Import existing skill packages, auto-draft a blueprint from source files, one-click ZIP export.
- Responsive UI (desktop / tablet / mobile) with preview drawer.
- 8 core tests (`node --test test/*.test.js`).
