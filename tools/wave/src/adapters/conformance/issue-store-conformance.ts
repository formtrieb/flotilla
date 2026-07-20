/**
 * issue-store-conformance.ts — the shared contract every IssueStore must pass.
 *
 * The P2–P3 safety net: run against `MarkdownFsStore` now and
 * `GitHubIssuesStore` in P3. One rule keeps it tracker-agnostic —
 *
 *   ☞ the suite observes ONLY `IssueView` fields (id, status, closedBy,
 *     acceptanceCriteria[].checked, …). It NEVER inspects filesystem paths,
 *     directory location, label names, or any storage mechanism.
 *
 * so the markdown-only mechanisms (the `done/` dir, the `**Status:**` line,
 * git-mv) cannot leak into the contract and falsely fail GitHub. The one place
 * the targets genuinely diverge — how an issue becomes natively *closed* — is
 * reached through the adapter-supplied {@link IssueStoreConformanceHooks.simulateNativeClose}
 * seam, never as a direct post-condition of `close()`.
 */

import { describe, it, expect } from 'vitest';
import type { CoarseState } from '../../contract';
import type {
  IssueStore,
  IssueStoreConformanceHooks,
  CreateInput,
} from '../issue-store';

const COARSE_STATES: readonly CoarseState[] = [
  'available',
  'queued',
  'in-flight',
  'in-review',
  'done',
  'needs-attention',
];

export interface ConformanceHarness {
  /** A fresh, empty store whose eligibility OR-set makes created issues wave-ready. */
  makeStore(): Promise<IssueStore>;
  hooks: IssueStoreConformanceHooks;
  /** A minimal valid CreateInput; the suite overrides fields per case. */
  baseInput(overrides?: Partial<CreateInput>): CreateInput;
}

/**
 * Register the conformance suite for one IssueStore implementation.
 * @param label  shown in the test tree, e.g. "MarkdownFsStore"
 * @param makeHarness  produces a fresh harness (called once; makeStore() per test)
 */
export function runIssueStoreConformance(
  label: string,
  makeHarness: () => Promise<ConformanceHarness> | ConformanceHarness,
): void {
  describe(`IssueStore conformance — ${label}`, () => {
    async function fresh() {
      const h = await makeHarness();
      const store = await h.makeStore();
      return { h, store };
    }

    // ── create / read round-trip ──────────────────────────────────────────
    it('create() returns an id that read() round-trips to an equal IssueView', async () => {
      const { h, store } = await fresh();
      const input = h.baseInput({
        risk: 'mechanical',
        worker: 'background',
        files: ['src/a.ts', 'src/b.ts'],
        acceptanceCriteria: [
          { text: 'first criterion', checked: false },
          { text: 'second criterion', checked: false },
        ],
      });
      const id = await store.create(input);
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);

      const view = await store.read(id);
      expect(view.id).toBe(id);
      expect(view.risk).toBe('mechanical');
      expect(view.worker).toBe('background');
      expect(view.files).toEqual(['src/a.ts', 'src/b.ts']);
      expect(view.blockedBy).toBe('none');
      expect(view.acceptanceCriteria.map((a) => a.text)).toEqual([
        'first criterion',
        'second criterion',
      ]);
    });

    it('two creates yield distinct ids, both readable (id is opaque, not derived)', async () => {
      const { h, store } = await fresh();
      const a = await store.create(h.baseInput({ title: 'Alpha' }));
      const b = await store.create(h.baseInput({ title: 'Beta' }));
      expect(a).not.toBe(b);
      expect((await store.read(a)).id).toBe(a);
      expect((await store.read(b)).id).toBe(b);
    });

    it('a fresh issue reads back status "available" and appears in listOpen', async () => {
      const { h, store } = await fresh();
      const id = await store.create(h.baseInput());
      expect((await store.read(id)).status).toBe('available');
      const open = await store.listOpen('wave-ready');
      expect(open.map((v) => v.id)).toContain(id);
    });

    // FOR-31 / W4-F2: a legitimate blocked-by ref must survive the create→read
    // round-trip as a real dependency — never silently collapsed to `'none'`
    // (the codec's pre-FOR-31 fail-open, which read absence into a still-blocked
    // row). The `'none'` form is already proven above; this pins the populated
    // form on every adapter so the new fail-loud strictness is not weakened.
    it('a legitimate blocked-by ref round-trips as a non-empty dependency (never dropped to none)', async () => {
      const { h, store } = await fresh();
      const blocker = await store.create(h.baseInput({ title: 'the blocker' }));
      const blocked = await store.create(
        h.baseInput({ title: 'the blocked', blockedBy: [store.parseRef(blocker)] }),
      );
      const view = await store.read(blocked);
      expect(view.blockedBy).not.toBe('none');
      expect(Array.isArray(view.blockedBy)).toBe(true);
      expect((view.blockedBy as { issue: number }[]).length).toBeGreaterThanOrEqual(1);
    });

    it('acceptanceCriteria start unchecked', async () => {
      const { h, store } = await fresh();
      const id = await store.create(
        h.baseInput({
          acceptanceCriteria: [
            { text: 'a', checked: false },
            { text: 'b', checked: false },
          ],
        }),
      );
      const view = await store.read(id);
      expect(view.acceptanceCriteria.every((a) => a.checked === false)).toBe(true);
    });

    // ── annotate (ADR-0010 decorate write-path) ───────────────────────────
    it('annotate() lands risk/worker/files/AC and preserves unmodeled content', async () => {
      const { h, store } = await fresh();
      const id = await store.create(
        h.baseInput({
          title: 'Pre-existing title',
          risk: 'mechanical',
          worker: 'background',
          files: ['old/path.ts'],
          acceptanceCriteria: [{ text: 'original ac', checked: false }],
        }),
      );

      await store.annotate(id, {
        risk: 'isolated-refactor',
        worker: 'background-heavy',
        files: ['a/b.ts'],
        acceptanceCriteria: [{ text: 'x', checked: false }],
      });

      const view = await store.read(id);
      expect(view.risk).toBe('isolated-refactor');
      expect(view.worker).toBe('background-heavy');
      expect(view.files).toEqual(['a/b.ts']);
      expect(view.acceptanceCriteria.map((a) => a.text)).toEqual(['x']);
      // a field NOT in the patch (the title-derived id stays, blockedBy untouched)
      expect(view.id).toBe(id);
      expect(view.blockedBy).toBe('none');
    });

    it('annotate() is additive — omitted fields are left untouched', async () => {
      const { h, store } = await fresh();
      const id = await store.create(
        h.baseInput({
          risk: 'mechanical',
          worker: 'background',
          files: ['keep/me.ts'],
          acceptanceCriteria: [{ text: 'keep this ac', checked: false }],
        }),
      );

      // patch ONLY risk; files/worker/AC must survive unchanged.
      await store.annotate(id, { risk: 'isolated-refactor' });

      const view = await store.read(id);
      expect(view.risk).toBe('isolated-refactor');
      expect(view.worker).toBe('background');
      expect(view.files).toEqual(['keep/me.ts']);
      expect(view.acceptanceCriteria.map((a) => a.text)).toEqual(['keep this ac']);
    });

    it('annotate() does not touch the claim ledger or open/closed state', async () => {
      const { h, store } = await fresh();
      const id = await store.create(h.baseInput());
      await store.transition(id, 'in-flight');
      await store.annotate(id, { files: ['x/y.ts'] });
      const view = await store.read(id);
      expect(view.status).toBe('in-flight');
      expect(view.files).toEqual(['x/y.ts']);
    });

    it('annotate() decorates a triage-ready issue with its MISSING wave fields, preserving human AC', async () => {
      // The ADR-0010 decorate target: a filed, triage-ready issue whose Risk/
      // Worker/Files are NOT the focus (placeholders/defaults) and which already
      // carries human-authored AC + a `## What to build` body. Decorate adds the
      // computed wave fields WITHOUT supplying acceptanceCriteria — the existing
      // human AC must survive untouched (decorate must not overwrite it).
      const { h, store } = await fresh();
      const id = await store.create(
        h.baseInput({
          title: 'Triage-ready issue',
          bodySections: [
            { heading: 'What to build', markdown: 'the human-authored brief' },
          ],
          acceptanceCriteria: [
            { text: 'human-authored AC one', checked: false },
            { text: 'human-authored AC two', checked: false },
          ],
        }),
      );

      // decorate: add ONLY the wave fields — no acceptanceCriteria in the patch.
      await store.annotate(id, {
        risk: 'isolated-refactor',
        worker: 'background-heavy',
        files: ['src/decorated/a.ts', 'src/decorated/b.ts'],
      });

      const view = await store.read(id);
      expect(view.risk).toBe('isolated-refactor');
      expect(view.worker).toBe('background-heavy');
      expect(view.files).toEqual(['src/decorated/a.ts', 'src/decorated/b.ts']);
      // the pre-existing human AC survives unchanged (decorate omitted it).
      expect(view.acceptanceCriteria.map((a) => a.text)).toEqual([
        'human-authored AC one',
        'human-authored AC two',
      ]);
      expect(view.acceptanceCriteria.every((a) => a.checked === false)).toBe(true);
      // and the issue is still open + unclaimed (decorate touches no ledger).
      expect(view.status).toBe('available');
    });

    it('annotate() sets the Parent backlink (a PRD slice realized via decorate)', async () => {
      // ADR-0011/0012: a PRD is often realized through a MIX of newly-created
      // slices and already-filed issues that `to-issues` decorates. A decorate-
      // mode slice must be able to carry the `Parent` backlink too — otherwise a
      // PRD sliced entirely into decorate-targets would never derive as consumed.
      const { h, store } = await fresh();
      const id = await store.create(h.baseInput({ files: ['src/a.ts'] }));
      expect((await store.read(id)).parent).toBeUndefined();

      // parent is the PRD's opaque id STRING (ADR-0013), not an IssueRef.
      const parent = await store.publishDocument({
        title: 'PRD: source',
        filingHint: 'prd-source',
        bodySections: [{ heading: 'Problem Statement', markdown: 'the brief' }],
      });
      await store.annotate(id, {
        risk: 'isolated-refactor',
        files: ['src/a.ts'],
        parent,
      });

      expect((await store.read(id)).parent).toBe(parent);
    });

    it('annotate() throws on an unknown id', async () => {
      const { store } = await fresh();
      await expect(store.annotate('definitely#99', { risk: 'mechanical' })).rejects.toThrow();
    });

    // ── amend (ADR-0025 — the authored-content facet: title + free prose) ──
    //
    // The tracker-agnostic half of FOR-33. Read-back rides `readTriage()`'s
    // title+body (a contract facet), so the SAME cases assert identically on
    // MarkdownFs (H1 + file body), GitHub (issue title + body), and Linear
    // (issue title + description) — zero suite-shape concession (the ADR-0020
    // bar). The storage-aware sharpest test (unmodeled MarkdownFs header fields
    // + Files annotations surviving) lives in amend-facet.spec.ts.

    /** Count `## <heading>` heading LINES in a body — 1 means no shadow duplicate. */
    function countHeading(body: string, heading: string): number {
      const re = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
      return body.split('\n').filter((l) => re.test(l)).length;
    }

    it('amend() replaces the title; read() view is otherwise unchanged', async () => {
      const { h, store } = await fresh();
      const id = await store.create(
        h.baseInput({
          title: 'Original title',
          risk: 'mechanical',
          worker: 'background',
          files: ['keep/a.ts'],
          acceptanceCriteria: [{ text: 'keep this ac', checked: false }],
        }),
      );
      const before = await store.read(id);

      await store.amend(id, { title: 'Renamed title' });

      // the human-facing title round-trips through the Triage facet (IssueView
      // carries no title — ADR-0015 — so readTriage is the tracker-agnostic read).
      expect((await store.readTriage(id)).title).toBe('Renamed title');
      // everything else on the IssueView is untouched.
      const after = await store.read(id);
      expect(after.risk).toBe(before.risk);
      expect(after.worker).toBe(before.worker);
      expect(after.files).toEqual(before.files);
      expect(after.acceptanceCriteria).toEqual(before.acceptanceCriteria);
      expect(after.status).toBe(before.status);
      expect(after.blockedBy).toEqual(before.blockedBy);
    });

    it('amend() REPLACES an existing prose section — no shadow duplicate, managed fields survive', async () => {
      const { h, store } = await fresh();
      const blocker = await store.create(h.baseInput({ title: 'blocker' }));
      const id = await store.create(
        h.baseInput({
          files: ['src/keep.ts'],
          blockedBy: [store.parseRef(blocker)],
          acceptanceCriteria: [{ text: 'ac survives', checked: false }],
          bodySections: [{ heading: 'What to build', markdown: 'the ORIGINAL brief' }],
        }),
      );

      await store.amend(id, {
        sections: [{ heading: 'What to build', markdown: 'the AMENDED brief' }],
      });

      const body = (await store.readTriage(id)).body;
      expect(body).toContain('the AMENDED brief');
      expect(body).not.toContain('the ORIGINAL brief'); // replaced, not shadowed
      expect(countHeading(body, 'What to build')).toBe(1); // exactly one section
      // every modeled field the amend must not touch is intact.
      const view = await store.read(id);
      expect(view.files).toEqual(['src/keep.ts']);
      expect(view.blockedBy).not.toBe('none');
      expect(view.acceptanceCriteria.map((a) => a.text)).toEqual(['ac survives']);
    });

    it('amend() APPENDS an absent prose section, preserving managed fields', async () => {
      const { h, store } = await fresh();
      const id = await store.create(
        h.baseInput({
          files: ['src/keep.ts'],
          acceptanceCriteria: [{ text: 'ac survives', checked: false }],
          bodySections: [{ heading: 'What to build', markdown: 'the brief' }],
        }),
      );

      await store.amend(id, {
        sections: [{ heading: 'Deferral note', markdown: 'a disclosed deferral' }],
      });

      const body = (await store.readTriage(id)).body;
      expect(countHeading(body, 'Deferral note')).toBe(1);
      expect(body).toContain('a disclosed deferral');
      expect(body).toContain('the brief'); // the pre-existing section survives
      const view = await store.read(id);
      expect(view.files).toEqual(['src/keep.ts']);
      expect(view.acceptanceCriteria.map((a) => a.text)).toEqual(['ac survives']);
    });

    it('amend() throws on a reserved-heading section (naming annotate)', async () => {
      const { h, store } = await fresh();
      const id = await store.create(h.baseInput());
      for (const reserved of ['Files', 'Blocked by', 'Unblocks', 'Acceptance criteria']) {
        await expect(
          store.amend(id, { sections: [{ heading: reserved, markdown: 'x' }] }),
        ).rejects.toThrow(/annotate/i);
      }
    });

    it('amend() throws on an empty patch and an unknown id', async () => {
      const { h, store } = await fresh();
      const id = await store.create(h.baseInput());
      await expect(store.amend(id, {})).rejects.toThrow();
      await expect(store.amend(id, { sections: [] })).rejects.toThrow();
      await expect(store.amend('definitely#99', { title: 'x' })).rejects.toThrow();
    });

    it('amend() touches neither the claim rung, the triage state, nor Blocked by', async () => {
      const { h, store } = await fresh();
      const blocker = await store.create(h.baseInput({ title: 'blocker' }));
      const id = await store.create(
        h.baseInput({ blockedBy: [store.parseRef(blocker)] }),
      );
      await store.transition(id, 'in-flight');
      const triageBefore = await store.readTriage(id);

      await store.amend(id, {
        title: 'Amended while claimed',
        sections: [{ heading: 'Notes', markdown: 'n' }],
      });

      const view = await store.read(id);
      expect(view.status).toBe('in-flight'); // claim rung untouched
      expect(view.blockedBy).not.toBe('none'); // dependency structure untouched
      const triageAfter = await store.readTriage(id);
      expect(triageAfter.state).toBe(triageBefore.state); // triage dimension untouched
      expect(triageAfter.category).toBe(triageBefore.category);
    });

    it('read().status is always one of the six CoarseState values', async () => {
      const { h, store } = await fresh();
      const id = await store.create(h.baseInput());
      expect(COARSE_STATES).toContain((await store.read(id)).status);
    });

    it('read() throws on an unknown id', async () => {
      const { store } = await fresh();
      await expect(store.read('definitely#99')).rejects.toThrow();
    });

    // ── transition (the claim ledger) ─────────────────────────────────────
    it('transition() round-trips each of the three rungs', async () => {
      const { h, store } = await fresh();
      for (const rung of ['queued', 'in-flight', 'in-review'] as const) {
        const id = await store.create(h.baseInput());
        await store.transition(id, rung);
        expect((await store.read(id)).status).toBe(rung);
      }
    });

    it('transition() rejects the derived bookends available/done/needs-attention', async () => {
      const { h, store } = await fresh();
      const id = await store.create(h.baseInput());
      for (const bad of ['available', 'done', 'needs-attention']) {
        await expect(
          // deliberately bypass the compile-time union to test the runtime guard
          store.transition(id, bad as 'queued'),
        ).rejects.toThrow();
      }
    });

    it('transition() is idempotent', async () => {
      const { h, store } = await fresh();
      const id = await store.create(h.baseInput());
      await store.transition(id, 'in-flight');
      await store.transition(id, 'in-flight');
      expect((await store.read(id)).status).toBe('in-flight');
    });

    it('transition() rungs are mutually exclusive (in-flight clears queued)', async () => {
      const { h, store } = await fresh();
      const id = await store.create(h.baseInput());
      await store.transition(id, 'queued');
      await store.transition(id, 'in-flight');
      expect((await store.read(id)).status).toBe('in-flight');
    });

    it('a claimed issue drops out of listOpen', async () => {
      const { h, store } = await fresh();
      const id = await store.create(h.baseInput());
      await store.transition(id, 'queued');
      const open = await store.listOpen('wave-ready');
      expect(open.map((v) => v.id)).not.toContain(id);
    });

    it('unclaim() returns a claimed issue to available + back into listOpen', async () => {
      const { h, store } = await fresh();
      const id = await store.create(h.baseInput());
      await store.transition(id, 'queued');
      await store.unclaim(id);
      expect((await store.read(id)).status).toBe('available');
      expect((await store.listOpen('wave-ready')).map((v) => v.id)).toContain(id);
    });

    it('unclaim() is idempotent on an unclaimed issue (no-op)', async () => {
      const { h, store } = await fresh();
      const id = await store.create(h.baseInput());
      await store.unclaim(id);
      expect((await store.read(id)).status).toBe('available');
    });

    // ── unclaim() releases ANY rung, not just `queued` (ADR-0022) ──────────
    //
    // The contract used to be described as the single reverse edge
    // `queued → available` (the plan-time drop). `parked` widens it: the
    // `failed → parked` entry edge releases a claim that is sitting at
    // **in-flight**, and the projection's `coarse('parked') === null` is executed
    // by the write path as exactly this call. If any store released only the
    // `queued` rung, a parked row would keep lying on the board — claimed
    // forever, blocking the re-planning it was parked for. Proven per-store
    // because each ledger is a different mechanism: MarkdownFs a header field,
    // GitHub `wave/<rung>` labels, Linear native workflow states.
    it('unclaim() releases an in-flight claim → available (the failed → parked edge)', async () => {
      const { h, store } = await fresh();
      const id = await store.create(h.baseInput());
      await store.transition(id, 'in-flight');
      expect((await store.read(id)).status).toBe('in-flight');

      await store.unclaim(id);

      expect((await store.read(id)).status).toBe('available');
      // back in the pool: a future wave-plan draw must be able to pick it up.
      expect((await store.listOpen('wave-ready')).map((v) => v.id)).toContain(id);
      expect((await store.listClaimed()).map((v) => v.id)).not.toContain(id);
    });

    it('unclaim() releases every claim rung → available (any rung, ADR-0022)', async () => {
      for (const rung of ['queued', 'in-flight', 'in-review'] as const) {
        const { h, store } = await fresh();
        const id = await store.create(h.baseInput());
        await store.transition(id, rung);
        expect((await store.read(id)).status, `claimed at ${rung}`).toBe(rung);

        await store.unclaim(id);

        expect((await store.read(id)).status, `released from ${rung}`).toBe(
          'available',
        );
        expect(
          (await store.listOpen('wave-ready')).map((v) => v.id),
          `back in the pool from ${rung}`,
        ).toContain(id);
      }
    });

    it('listClaimed() returns exactly the claimed issues (the complement of listOpen)', async () => {
      const { h, store } = await fresh();
      const free = await store.create(h.baseInput({ title: 'free' }));
      const claimed = await store.create(h.baseInput({ title: 'claimed' }));
      await store.transition(claimed, 'in-flight');

      const claimedIds = (await store.listClaimed()).map((v) => v.id);
      expect(claimedIds).toContain(claimed);
      expect(claimedIds).not.toContain(free);

      const openIds = (await store.listOpen('wave-ready')).map((v) => v.id);
      expect(openIds).toContain(free);
      expect(openIds).not.toContain(claimed);
    });

    // ── close (record-only; native close via the hook) ────────────────────
    it('close() records closedBy and ticks the acked ACs cosmetically', async () => {
      const { h, store } = await fresh();
      const id = await store.create(
        h.baseInput({
          acceptanceCriteria: [
            { text: 'a', checked: false },
            { text: 'b', checked: false },
            { text: 'c', checked: false },
          ],
        }),
      );
      await store.transition(id, 'in-review');
      await store.close(id, 'https://example/pr/1', [0, 2]);

      const view = await store.read(id);
      expect(view.closedBy).toBe('https://example/pr/1');
      expect(view.acceptanceCriteria[0].checked).toBe(true);
      expect(view.acceptanceCriteria[1].checked).toBe(false);
      expect(view.acceptanceCriteria[2].checked).toBe(true);
    });

    it('close() never throws on an out-of-range ack index (cosmetic, not authority)', async () => {
      const { h, store } = await fresh();
      const id = await store.create(
        h.baseInput({ acceptanceCriteria: [{ text: 'a', checked: false }] }),
      );
      await expect(
        store.close(id, 'https://example/pr/2', [0, 99]),
      ).resolves.not.toThrow();
    });

    it('status derives "done" only after the native close hook', async () => {
      const { h, store } = await fresh();
      const id = await store.create(h.baseInput());
      await store.transition(id, 'in-review');
      await store.close(id, 'https://example/pr/3', []);
      await h.hooks.simulateNativeClose(store, id);

      const view = await store.read(id);
      expect(view.status).toBe('done');
      expect(view.closedBy).toBe('https://example/pr/3');
    });

    it('close() is idempotent — re-closing leaves status=done + closedBy stable', async () => {
      const { h, store } = await fresh();
      const id = await store.create(h.baseInput());
      await store.close(id, 'https://example/pr/4', []);
      await h.hooks.simulateNativeClose(store, id);
      await store.close(id, 'https://example/pr/4', []);

      const view = await store.read(id);
      expect(view.status).toBe('done');
      expect(view.closedBy).toBe('https://example/pr/4');
    });

    it('a closed issue drops out of listOpen', async () => {
      const { h, store } = await fresh();
      const id = await store.create(h.baseInput());
      await store.close(id, 'https://example/pr/5', []);
      await h.hooks.simulateNativeClose(store, id);
      const open = await store.listOpen('wave-ready');
      expect(open.map((v) => v.id)).not.toContain(id);
    });

    // ── listOpen (eligibility OR-set) ─────────────────────────────────────
    it('listOpen() returns only available (eligible & unclaimed & open) issues', async () => {
      const { h, store } = await fresh();
      const a = await store.create(h.baseInput({ title: 'open-unclaimed' }));
      const b = await store.create(h.baseInput({ title: 'claimed' }));
      await store.transition(b, 'in-flight');

      const open = await store.listOpen('wave-ready');
      const ids = open.map((v) => v.id);
      expect(ids).toContain(a);
      expect(ids).not.toContain(b);
      // every returned view is genuinely available + carries conflict-map inputs
      for (const v of open) {
        expect(v.status).toBe('available');
        expect(Array.isArray(v.files)).toBe(true);
      }
    });

    // ── readClosing (the closing probe, ADR-0005 / W2-F1c) ────────────────
    //
    // The four ClosingState outcomes are EVIDENCE claims, not verdicts. Before
    // this block the shared suite never exercised readClosing, so the union
    // FOR-23 widened was a contract only one adapter (Linear) demonstrably
    // honoured — GitHub and MarkdownFs could collapse an evidence-less close into
    // `closed-unmerged` (the exact W2-F1c bug) and nothing here caught it. These
    // cases force every store to draw the line, and DELIBERATELY diverge per
    // adapter on the rejection scenario (no longer 0-diff): a store that can
    // record a rejected PR reports `closed-unmerged`; one that structurally
    // cannot reports `closed-unknown` — never a rejection it cannot prove. The
    // per-store drivers live on the adapter's conformance hooks (the same stance
    // as simulateNativeClose — the suite asserts behaviour, never a mechanism).
    it('readClosing reads "open" for a still-open issue', async () => {
      const { h, store } = await fresh();
      const id = await store.create(h.baseInput());
      expect((await store.readClosing(id)).state).toBe('open');
    });

    it('readClosing reads "merged" (with prUrl) for a merged-PR close', async () => {
      const { h, store } = await fresh();
      const id = await store.create(h.baseInput());
      await store.transition(id, 'in-review');
      await h.hooks.simulateClosedMergedPr(store, id, 'https://example/pr/merged');
      const closing = await store.readClosing(id);
      expect(closing.state).toBe('merged');
      expect(closing.prUrl).toBe('https://example/pr/merged');
    });

    it('readClosing distinguishes a PROVEN rejection (closed-unmerged) from a store that cannot prove one (closed-unknown)', async () => {
      const { h, store } = await fresh();
      const id = await store.create(h.baseInput());
      await store.transition(id, 'in-review');
      // The hook drives the "a linked PR was found and did NOT merge" scenario AND
      // declares the honest state THIS store reports for it — closed-unmerged where
      // the rejection can be recorded (GitHub, Linear), closed-unknown where it
      // structurally cannot (MarkdownFs). Either is a legitimate ClosingState; the
      // one thing forbidden is a store inventing a rejection it never saw (W2-F1c).
      const expected = await h.hooks.simulateClosedUnmergedPr(store, id);
      expect(['closed-unmerged', 'closed-unknown']).toContain(expected);
      expect((await store.readClosing(id)).state).toBe(expected);
    });

    it('readClosing reads "closed-unknown" for a close with NO PR evidence — never a rejection it cannot prove', async () => {
      const { h, store } = await fresh();
      const id = await store.create(h.baseInput());
      await store.transition(id, 'in-review');
      await h.hooks.simulateClosedNoEvidence(store, id);
      expect((await store.readClosing(id)).state).toBe('closed-unknown');
    });

    it('readClosing throws on an unknown id', async () => {
      const { store } = await fresh();
      await expect(store.readClosing('definitely#99')).rejects.toThrow();
    });
  });
}
