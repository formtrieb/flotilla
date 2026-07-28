## Convention 6 — the sanctioned amend path (Worker discloses, Coordinator amends)

When a Worker discovers mid-slice that an issue's **authored content** needs correcting — most often a **deferral that re-scopes an already-open issue** (the W4-F5 case: FOR-23's Worker found a gap belonging to FOR-20) — the fix goes through the engine's **Amend facet** (ADR-0025), never raw tracker GraphQL and never a tracker CLI.

- **The Worker discloses; it does NOT write.** A Worker has no store access from its isolated worktree (W4-F4) — its `wave.config.json` is gitignored and absent there. It records the needed change in its `WorkerReport` (`judgmentCalls` / `reviewerFocusItems`), and the **Coordinator** performs the amend from the wave root, where the store is configured.
- **The verb.** `issue-store amend <id> --patch <json-file>` — the patch is `{ title?, sections? }`, whole-patch-validated before any write (an empty patch is a usage error, exit 2; a reserved-heading collision or unknown id is a domain failure, exit 1). `sections` is **upsert-by-heading**: an existing `## <heading>` prose section is replaced (no shadow duplicate), an absent one appended.

  ```bash
  {{wave-cli}} issue-store amend <id> --patch /path/to/amend-patch.json --config <path>
  ```

- **`amend` cannot touch Files / Acceptance criteria / Blocked by.** Those are the wave Header-Block, and they have exactly one owner: `annotate` (decorate, ADR-0010). The `AmendPatch` type has **no such field**, and a `sections` heading of `Files` / `Blocked by` / `Unblocks` / `Acceptance criteria` throws, naming `annotate`. So an amend can never clobber acceptance criteria — structurally.
- **A full re-scope is two deliberate calls:** `amend` for the new title + prose, then `annotate` for the new Files / ACs (under the existing decorate rule — `to-issues` remains the sole governor of AC replacement). New title + a re-written brief go through `amend`; the modeled Header-Block goes through `annotate`.

This is the exact path W4-F5 lacked, where the only way to re-scope FOR-20 was raw Linear `issueUpdate` — bypassing the very seam flotilla is built around.
