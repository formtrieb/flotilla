# Credential lookup-command first-read — the two measured environments

Evidence class — moved out of [reference/setup-mechanics.md](../reference/setup-mechanics.md#credential-lookup-command-scaffold-adr-0029) (issue #1030, 2026-09-27, the third wave-setup residual-form diet pass) so the credential lookup-command scaffold keeps only the residual rule ("treat both as live possibilities, let the live-gate settle it"); this file is the dated measurement and the live occurrence behind that rule.

## The two measured environments

The **first** value-read (`-w`) of a freshly created keychain item is the part that is environment-conditional, not a fixed fact, and this scaffold's rule text has been measured against two different environments rather than argued from one:

- **The interactive environment.** On the machine this note was originally written against, the first value-read prompted the operator once, interactively, for authorization — clicking **Always Allow** on that prompt is what made *every later* read promptless. Run value-free (output redirected away), this shape was originally observed as a failing exit with nothing on stdout — lookup-exit 161, twice — which is the correct signal that the item isn't yet authorized for value-reads, not a broken scaffold or a wrong service name. Re-running the same command is how to make the dialog reappear if it was dismissed without a click.
- **The non-interactive environment.** A 2026-08-14 determination against current macOS (ADR-0029's dated amendment, filed against issue #544) found the identical sequence resolve with **no prompt at all** on its first read — the value-free run exits 0 with the secret already on stdout (redirected away), and there is no dialog to click; the live-gate skips straight to `store-preflight`.

An attribute-only read (`find-generic-password` without `-w`) never triggers this prompt on either environment, so it cannot stand in as a check that the value-read path is promptless.

## The bare-terminal false failure live occurrence

Step 3 of the live-gate (re-running `store-preflight` to prove `<VAR>_CMD` resolves) has to run through the harness, not a bare terminal, because `<VAR>_CMD` lives only in the tracked settings `env` block. Run in the operator's own bare terminal instead, it fails with a real, correctly-worded "not configured" error (e.g. `LINEAR_API_KEY is required … and neither source is configured`) — accurate about *that terminal's* environment, and easy to misread as a broken scaffold. Live occurrence: an operator followed this step literally in a bare terminal, hit exactly this false failure, and only found the true state (`credential-probe --all` → `resolved: true` for every configured credential) by re-running inside the harness — the diagnostic round-trip the residual note in setup-mechanics.md exists to close.
