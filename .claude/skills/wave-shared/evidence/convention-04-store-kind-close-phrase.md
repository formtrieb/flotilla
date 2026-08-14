## Convention 4 — evidence sidecar: the mention-footgun, live occurrences

Moved out of `reference/convention-04-store-kind-close-phrase.md` per ADR-0034's Amendment (2026-08-13): `reference/` is loaded whole by every execution skill on every wave, and this history is not needed for that load. Reachable on demand via the ADR-0040 sibling-path read; the rule itself, and its one-line why, stay in the reference/ file.

Two live occurrences are the evidence this is a real footgun, not a hypothetical:

- **w2 (2026-07-16):** `FOR-13` resolved to `Done` mid-session with the trigger unconfirmed at the time — PR #9's title/body named "FOR-13" though FOR-13 was not the row that PR landed (docs/retros/2026-07-16-hardening-w2.md).
- **2026-07-19:** a docs-only PR (#29) whose **title** mentioned `FOR-6` and `FOR-33` — no Convention-4 close phrase anywhere in the body — was squash-merged, and the Linear GitHub integration moved both issues to `Done` before either had even been dispatched in the wave that was about to build them. Recovery required an out-of-band state reset (raw-GraphQL reopen) before the wave could run.
