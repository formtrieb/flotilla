# The engine CLI surface is the third semver contract

1.0.0 froze two surfaces by name — the package-root export surface and the `wave.config.json` schema — and left the engine CLI projection un-enumerated. Issue #400 exposed the gap from the consumer side: a wire-shape change to the CLI JSON (normalizing the `blockedBy` sentinel union to an empty array) was documented as safe-to-live-with rather than taken, and nobody could say whether taking it would have been a 1.x change or a 2.0 one. Meanwhile the seam's reality is unambiguous: ADR-0032 makes `engine.cli` the *only* binding a consumer holds, the plugin skills parse the JSON outputs and read the exit codes as gate inputs ("read the exit code, not the prose"), and plugin and engine version independently against a `>=1.0.0` floor — the CLI surface is the one interface every consumer actually uses.

## Decision

**The engine CLI surface — verbs, flags, exit-code meanings, and JSON output shapes — is a semver contract, the third alongside the package root and the config schema.**

- **Additive evolution is minor:** a new verb, a new optional flag, a new JSON key. A consumer parsing 1.x output must tolerate unknown keys — that tolerance is part of the contract's reading side.
- **Removal, reshape, or re-meaning is major:** dropping or renaming a verb/flag/key, changing an exit code's meaning, or changing the type/vocabulary of an existing JSON value.
- **The ruling that convened this:** the `blockedBy` sentinel union (`'none' | ref[]`) in the CLI projection is frozen 1.x shape. Normalizing it to `[]` at the wire is major-class — and it is **rejected, not wishlisted**: the landed documentation fix (the union named at the read site, the narrowing idiom prescribed where the wrong form gets typed) makes the current shape safe to live with, and a 2.0 wishlist would do nothing but accrue pressure toward a major bump nobody needs. If a 2.0 ever happens for its own reasons, the normalization may ride along; it justifies nothing.

## Considered Options

- **Declare the projection explicitly not-frozen (best-effort, consumers pin)** (rejected) — it contradicts the plugin's own `>=1.0.0` floor: the skills are the projection's biggest consumer and need exactly the 1.x stability this option would disclaim, on exactly the surface ADR-0032 routes everything through.
- **Rule on the sentinel alone, no general contract** (rejected) — the next wire-shape question re-derives the whole frame; #400 was filed precisely because the question kept being answerable only ad hoc.

## Consequences

- Issue #400 closes citing this ADR.
- The CHANGELOG names the third contract at the next release cut, alongside the two 1.0.0 named.
- The ported CLI spec files remain the contract's regression net; a wire-shape change that passes them but violates this ADR is a review finding, not a green light.
- No engine change. This ADR closes no issue by merge phrase and lands Coordinator-direct (ADR-0033).
