# Instructions for agents

## Documentation

- The README exists in several languages: `README.md` (English) and `README.es.md` (Spanish).
  **Any change to one must be made to all of them in the same commit**, with the same content and
  structure. If you add a new language, name it `README.<lang>.md` and add it to the language links
  at the top of every README.
- Keep the language links line (`**English** · [Español](README.es.md)`) at the top of each README.

## Tests

- Run `make test` before committing; CI runs the same tests and won't publish images if they fail.
- Every change comes with tests for what it changes: `api/test/*.test.js` (node:test; integration
  tests start the real API with `startServer()` from `test/helpers.mjs`) and `vision/tests/`
  (pytest; the `api` fixture starts the real Node API so cookies and keys are the real ones).
- Never put real recordings or anyone's images in tests or fixtures: the repo is public. Use
  synthetic data.

## Project conventions

- The app's UI text and code comments are in Spanish; keep new UI strings and comments in Spanish.
- Models in `vision/models/` are stored in git LFS and baked into the vision image. After
  retraining, commit `vision/models/zones.joblib`; CI publishes new images to ghcr.io.
- Dockerfiles copy source files by glob (`COPY *.js`, `COPY *.py`), not by name, so new modules
  are not left out of the images.
- Common tasks are in the `Makefile` (`make` lists them).
