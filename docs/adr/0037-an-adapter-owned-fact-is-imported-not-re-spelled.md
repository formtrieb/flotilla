# An adapter-owned canonical fact is imported, not re-spelled — even against the layering grain, and the edge is call-time-only

`host-pr.ts` carried zero imports until the create-credentials preflight check (issue #468, PR #474) needed Bitbucket's credential rule — the variable name `BITBUCKET_EMAIL_VAR` and the email-is-required rule `bitbucketCreateCreds` encodes. Importing them from `adapters/bitbucket/bitbucket-api` created the engine's first true module cycle (the adapter already imports `AutoMergeUnavailableError` and `DEFAULT_MERGE_METHOD` back), pointing against the direction three placement comments cite as the reason a thing lives where it lives. The instance was verified by two independent parties — the Reviewer drove the adapter-first load order the suite never exercises, and both edges resolved — and was accepted at a G3 gate with the precedent explicitly deferred to issue #475. This ADR settles the rule.

## Decision

**An engine module may import an adapter-owned canonical fact when the alternative is re-spelling it. The edge must be call-time-only, in both directions. The rule is engine-wide.**

- **The qualification carries the whole weight.** The import must be the canonical spelling of a fact the adapter owns — a variable NAME, a credential RULE — where a second copy could silently disagree with the verb it predicts (the parallel-rule drift class this repo closes systematically; `credential-probe-cli`'s import of `BITBUCKET_TOKEN_VAR` is the same figure, minus the cycle). Convenience imports do not qualify; cycle avoidance stays the default, and the three placement comments remain correct on their merits.
- **Call-time-only is the safety condition, and it is load-bearing.** Nothing may read a crossing binding at module evaluation: a top-level read across a cycle edge resolves to `undefined` under whichever load order arrives first — a silent failure with a plausible wrong result. That is ADR-0034's promotion class, so the invariant is owed a structural guard, not a comment: a load-order drift-spec that loads both orders and asserts the crossing bindings — the Reviewer's manual adapter-first probe, promoted into the suite.
- **The extraction trigger is named, not left to taste.** One call-time-only cycle is accepted and guarded. The second cycle — another adapter whose owned fact the engine must grade — is the moment a shared leaf module (`landing-contract.ts` or kin) earns itself, and both cycles are dissolved into it. Structure is earned at recurrence, not paid in advance (ADR-0034's figure, applied to modules).

## Considered Options

- **Re-spell the name or rule inside the engine** (rejected) — reproduces the drift class the originating row forbade; a preflight check that can silently disagree with the verb it grades is worse than no check.
- **Build the check at the CLI layer** (rejected) — splits ownership of the posture report's `ok` and `checks` between engine and CLI; a barrel consumer calling `preflightHost` directly would get a different report than the CLI verb prints.
- **Extract the shared shape now** (rejected as premature → the named trigger) — dissolves the cycle but not the direction (the forward edge is the point of the rule), moves `host-pr`-owned vocabulary away from its home for exactly one instance, and pays module churn on a landed, twice-verified state.

## Consequences

- Enforcement tiers (ADR-0034): the rule lives at reference-doc tier (this ADR) plus the placement comments; the call-time-only invariant moves to the structural tier via the load-order drift-spec; the extraction trigger stays prose here until it fires.
- `host-pr.ts`'s cycle comment cites this ADR, the spec, and the trigger. The three avoidance comments (`cli.ts`, `wave-md-rw.ts`, `cli-store.ts`) each gain one line marking avoidance as the default and this ADR as the narrow exception — their absolute phrasing must not teach the exception away. (`wave-md-rw.ts`'s edge is engine-internal, outside this rule's boundary; its pointer names the doctrine without flipping that instance.)
- The drift-spec and the four comment edits land through a reviewed wave row that closes issue #475 (ADR-0033); this ADR itself closes no issue and lands Coordinator-direct.
