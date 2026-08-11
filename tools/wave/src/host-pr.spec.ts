/**
 * host-pr.spec.ts — fixtures for the host-aware PR boundary
 * (wave-orchestration #56).
 *
 * The single network side-effect (`verifyAuth` / `findOpenPr` / `createPr`) is
 * isolated behind the injectable `HttpProbe` seam, so every test is hermetic —
 * NO real network is touched (mirrors the `GitProbe` injection in
 * merge-order.spec.ts and the `FfProbe` injection in ff-guard.spec.ts).
 *
 * `detectHost` is a pure parser and needs no seam at all.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runHostPr } from './host-pr-cli';
import {
  detectHost,
  verifyAuth,
  findOpenPr,
  findOpenPrRef,
  updateOpenPr,
  findClosePhrase,
  hasClosePhrase,
  closePhraseLossReason,
  createPr,
  decideArmAction,
  refineArmDecisionForCheckAttach,
  compareRequiredToReported,
  asCheckAttachReader,
  armPullRequest,
  mergePullRequestNow,
  preflightHost,
  mergeRequiredChecks,
  alignedPrRef,
  AutoMergeUnavailableError,
  LandingNotImplementedError,
  DEFAULT_MERGE_METHOD,
  type ArmDecision,
  type ArmOptions,
  type CheckAttachReader,
  type ReportedCheck,
  type HttpProbe,
  type HttpRequest,
  type HttpResponse,
  type LandingHost,
  type LandingPosture,
  type MergeMethod,
  type MergeResult,
  type PrLandingStatus,
  type PrMergeability,
  type AutoMergeSetting,
  type Host,
  type RequiredChecksInfo,
  type RulesetChecksInfo,
} from './host-pr';
import { BITBUCKET_EMAIL_VAR, bitbucketCreateCreds } from './adapters/bitbucket/bitbucket-api';

// ─── HTTP seam fixture ───────────────────────────────────────────────────────

/**
 * Build a fake {@link HttpProbe} that answers each request with a canned
 * response chosen by a matcher, and records every request it received so a test
 * can assert ordering (e.g. find-before-create) and the zero-network contract.
 *
 * Each route is `[predicate, response]`; the first matching predicate wins.
 * An unmatched request resolves to `{ status: 404, json: null }` rather than
 * hitting the network — there is no `fetch` anywhere in this file.
 */
function fakeProbe(
  routes: Array<[(req: HttpRequest) => boolean, HttpResponse]>,
): { http: HttpProbe; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const http: HttpProbe = {
    async request(req: HttpRequest): Promise<HttpResponse> {
      calls.push(req);
      for (const [match, res] of routes) {
        if (match(req)) return res;
      }
      return { status: 404, json: null };
    },
  };
  return { http, calls };
}

const isGet = (req: HttpRequest) => req.method === 'GET';
const isPost = (req: HttpRequest) => req.method === 'POST';
const isPatch = (req: HttpRequest) => req.method === 'PATCH';
const isPut = (req: HttpRequest) => req.method === 'PUT';
const urlHas = (frag: string) => (req: HttpRequest) => req.url.includes(frag);

// ─── detectHost (pure, no seam) ──────────────────────────────────────────────

describe('detectHost', () => {
  it('parses a GitHub SSH remote', () => {
    expect(detectHost('git@github.com:acme/widgets.git')).toEqual({
      host: 'github',
      workspace: 'acme',
      repo: 'widgets',
    });
  });

  it('parses a GitHub HTTPS remote', () => {
    expect(detectHost('https://github.com/acme/widgets.git')).toEqual({
      host: 'github',
      workspace: 'acme',
      repo: 'widgets',
    });
  });

  it('parses a Bitbucket SSH remote', () => {
    expect(
      detectHost('git@bitbucket.org:acme-team/nx-ui.git'),
    ).toEqual({
      host: 'bitbucket',
      workspace: 'acme-team',
      repo: 'nx-ui',
    });
  });

  it('parses a Bitbucket HTTPS remote', () => {
    expect(
      detectHost('https://bitbucket.org/acme-team/nx-ui.git'),
    ).toEqual({
      host: 'bitbucket',
      workspace: 'acme-team',
      repo: 'nx-ui',
    });
  });

  it('strips the trailing .git and tolerates a missing .git suffix', () => {
    expect(detectHost('https://github.com/acme/widgets')).toEqual({
      host: 'github',
      workspace: 'acme',
      repo: 'widgets',
    });
  });

  it('tolerates inline HTTPS credentials and a trailing slash', () => {
    expect(detectHost('https://user@bitbucket.org/ws/repo.git/')).toEqual({
      host: 'bitbucket',
      workspace: 'ws',
      repo: 'repo',
    });
  });

  it('returns unknown for a non-supported host (GitLab)', () => {
    expect(detectHost('git@gitlab.com:acme/widgets.git')).toEqual({
      host: 'unknown',
      workspace: '',
      repo: '',
    });
  });

  it('returns unknown for junk / empty / local-path input', () => {
    expect(detectHost('not a url')).toEqual({
      host: 'unknown',
      workspace: '',
      repo: '',
    });
    expect(detectHost('')).toEqual({
      host: 'unknown',
      workspace: '',
      repo: '',
    });
    expect(detectHost('/Users/me/repos/widgets')).toEqual({
      host: 'unknown',
      workspace: '',
      repo: '',
    });
  });
});

// ─── verifyAuth ──────────────────────────────────────────────────────────────

describe('verifyAuth', () => {
  it('returns ok:true with the identity on a 200 (Bitbucket GET /2.0/user)', async () => {
    const { http, calls } = fakeProbe([
      [
        urlHas('api.bitbucket.org/2.0/user'),
        { status: 200, json: { username: 'svc-bot' } },
      ],
    ]);
    const r = await verifyAuth('bitbucket', { auth: 'u:p' }, { http });
    expect(r).toEqual({ ok: true, identity: 'svc-bot' });
    // Exactly one network call, and it was the preflight GET.
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
  });

  it('returns ok:true for GitHub via GET /user, reading the login field', async () => {
    const { http } = fakeProbe([
      [
        urlHas('api.github.com/user'),
        { status: 200, json: { login: 'octocat' } },
      ],
    ]);
    const r = await verifyAuth('github', { auth: 'u:t' }, { http });
    expect(r).toEqual({ ok: true, identity: 'octocat' });
  });

  it('returns ok:false with the status on a 401', async () => {
    const { http } = fakeProbe([
      [urlHas('/user'), { status: 401, json: null }],
    ]);
    const r = await verifyAuth('bitbucket', { auth: 'u:wrong' }, { http });
    expect(r).toEqual({ ok: false, status: 401 });
  });

  it('falls back to the supplied username when the body carries no identity', async () => {
    const { http } = fakeProbe([[urlHas('/user'), { status: 200, json: {} }]]);
    const r = await verifyAuth(
      'bitbucket',
      { auth: 'u:p', username: 'hinted' },
      { http },
    );
    expect(r).toEqual({ ok: true, identity: 'hinted' });
  });

  it('returns ok:false for an unknown host without making a request', async () => {
    const { http, calls } = fakeProbe([]);
    const r = await verifyAuth('unknown', { auth: 'u:p' }, { http });
    expect(r).toEqual({ ok: false, status: 0 });
    expect(calls).toHaveLength(0);
  });
});

// ─── findOpenPr ──────────────────────────────────────────────────────────────

describe('findOpenPr', () => {
  it('returns the URL on a hit (Bitbucket values[0].links.html.href)', async () => {
    const { http } = fakeProbe([
      [
        isGet,
        {
          status: 200,
          json: {
            values: [
              {
                links: {
                  html: {
                    href: 'https://bitbucket.org/ws/repo/pull-requests/7',
                  },
                },
              },
            ],
          },
        },
      ],
    ]);
    const r = await findOpenPr(
      'bitbucket',
      { auth: 'u:p' },
      'wave-orch/56-host-pr',
      { workspace: 'ws', repo: 'repo' },
      { http },
    );
    expect(r).toBe('https://bitbucket.org/ws/repo/pull-requests/7');
  });

  it('returns null on a miss (empty values array)', async () => {
    const { http } = fakeProbe([
      [isGet, { status: 200, json: { values: [] } }],
    ]);
    const r = await findOpenPr(
      'bitbucket',
      { auth: 'u:p' },
      'wave-orch/56-host-pr',
      { workspace: 'ws', repo: 'repo' },
      { http },
    );
    expect(r).toBeNull();
  });

  it('returns the URL on a GitHub hit (array of PRs, html_url)', async () => {
    const { http } = fakeProbe([
      [
        isGet,
        {
          status: 200,
          json: [{ html_url: 'https://github.com/acme/w/pull/9' }],
        },
      ],
    ]);
    const r = await findOpenPr(
      'github',
      { auth: 'u:t' },
      'feat/x',
      { workspace: 'acme', repo: 'w' },
      { http },
    );
    expect(r).toBe('https://github.com/acme/w/pull/9');
  });

  it('returns null when the query itself fails (non-200)', async () => {
    const { http } = fakeProbe([[isGet, { status: 500, json: null }]]);
    const r = await findOpenPr(
      'bitbucket',
      { auth: 'u:p' },
      'b',
      { workspace: 'ws', repo: 'repo' },
      { http },
    );
    expect(r).toBeNull();
  });

  it('builds a WELL-FORMED Bitbucket query: BBQL in `q`, `state` as its own parameter', async () => {
    // The bug this pins: `q` used to carry the whole string
    // `source.branch.name="b"&state=OPEN`, URL-encoded as ONE value. `q` is
    // BBQL, whose boolean operator is `and` — Atlassian's own example is
    // `?q=size>1024+and+attributes="binary"` — so the encoded `&state=OPEN`
    // was junk inside the expression. A query Bitbucket rejects returns
    // non-200, which this module reads as "no known open PR", so the caller
    // proceeds to CREATE: find-before-create silently becomes
    // create-a-duplicate on every Bitbucket re-run.
    const { http, calls } = fakeProbe([[isGet, { status: 200, json: { values: [] } }]]);
    await findOpenPr('bitbucket', { auth: 'u:p' }, 'wave/461-x', { workspace: 'ws', repo: 'repo' }, { http });

    const url = calls[0].url;
    expect(url).toContain(`q=${encodeURIComponent('source.branch.name="wave/461-x"')}`);
    expect(url).toContain('&state=OPEN');
    // The decisive negative: `&state=OPEN` must NOT be encoded into the q value.
    expect(url).not.toContain(encodeURIComponent('&state=OPEN'));
    expect(url).not.toContain('%26state');
  });

  it('the GitHub query is untouched by that fix', async () => {
    const { http, calls } = fakeProbe([[isGet, { status: 200, json: [] }]]);
    await findOpenPr('github', { auth: 'u:t' }, 'feat/x', { workspace: 'acme', repo: 'w' }, { http });
    expect(calls[0].url).toBe(
      'https://api.github.com/repos/acme/w/pulls?state=open&head=acme%3Afeat%2Fx',
    );
  });
});

// ─── findOpenPrRef (url + host-local number, for the reuse-time update) ───────

describe('findOpenPrRef', () => {
  it('surfaces the PR number alongside the URL on a GitHub hit', async () => {
    const { http } = fakeProbe([
      [isGet, { status: 200, json: [{ html_url: 'https://github.com/acme/w/pull/9', number: 9 }] }],
    ]);
    const r = await findOpenPrRef(
      'github',
      { auth: 'u:t' },
      'feat/x',
      { workspace: 'acme', repo: 'w' },
      { http },
    );
    expect(r).toEqual({ url: 'https://github.com/acme/w/pull/9', number: 9 });
  });

  it('surfaces the PR number (Bitbucket `id`) alongside the html href', async () => {
    const { http } = fakeProbe([
      [
        isGet,
        {
          status: 200,
          json: { values: [{ id: 7, links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/7' } } }] },
        },
      ],
    ]);
    const r = await findOpenPrRef(
      'bitbucket',
      { auth: 'u:p' },
      'b',
      { workspace: 'ws', repo: 'repo' },
      { http },
    );
    expect(r).toEqual({ url: 'https://bitbucket.org/ws/repo/pull-requests/7', number: 7 });
  });

  it('returns the URL with number ABSENT when the body carries no number (reuse still possible, no PATCH addressable)', async () => {
    const { http } = fakeProbe([[isGet, { status: 200, json: [{ html_url: 'https://github.com/acme/w/pull/9' }] }]]);
    const r = await findOpenPrRef('github', { auth: 'u:t' }, 'b', { workspace: 'acme', repo: 'w' }, { http });
    expect(r).toEqual({ url: 'https://github.com/acme/w/pull/9' });
    expect(r && 'number' in r).toBe(false);
  });

  it('returns null on a miss / non-200 query, exactly like findOpenPr', async () => {
    const { http: miss } = fakeProbe([[isGet, { status: 200, json: [] }]]);
    expect(await findOpenPrRef('github', { auth: 'u:t' }, 'b', { workspace: 'acme', repo: 'w' }, { http: miss })).toBeNull();
    const { http: fail } = fakeProbe([[isGet, { status: 500, json: null }]]);
    expect(await findOpenPrRef('github', { auth: 'u:t' }, 'b', { workspace: 'acme', repo: 'w' }, { http: fail })).toBeNull();
  });
});

// ─── updateOpenPr (reuse-time body/title re-render — FOR-58) ──────────────────

describe('updateOpenPr', () => {
  const fields = { title: 'Composed title', body: 'summary\n\n## Reviewer verdict\n…\n\nFixes EX-1' };

  it('PATCHes the GitHub PR to the passed title/body and reports updated:true through the SAME seam', async () => {
    const { http, calls } = fakeProbe([[isPatch, { status: 200, json: { html_url: 'https://github.com/acme/w/pull/9' } }]]);
    const r = await updateOpenPr(
      'github',
      { auth: 'u:t' },
      { url: 'https://github.com/acme/w/pull/9', number: 9 },
      fields,
      { workspace: 'acme', repo: 'w' },
      { http },
    );
    expect(r).toEqual({ url: 'https://github.com/acme/w/pull/9', updated: true });
    // One PATCH, addressed to the numbered pull, carrying title + body verbatim.
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toBe('https://api.github.com/repos/acme/w/pulls/9');
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ title: fields.title, body: fields.body });
  });

  it('PUTs the Bitbucket PR (title + description) and reports updated:true', async () => {
    const { http, calls } = fakeProbe([[isPut, { status: 200, json: {} }]]);
    const r = await updateOpenPr(
      'bitbucket',
      { auth: 'u:p' },
      { url: 'https://bitbucket.org/ws/repo/pull-requests/7', number: 7 },
      fields,
      { workspace: 'ws', repo: 'repo' },
      { http },
    );
    expect(r).toEqual({ url: 'https://bitbucket.org/ws/repo/pull-requests/7', updated: true });
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe('https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/7');
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ title: fields.title, description: fields.body });
  });

  it('a ref with NO number is a no-op — re-pins the URL, updated:false, NO request', async () => {
    const { http, calls } = fakeProbe([[isPatch, { status: 200, json: {} }]]);
    const r = await updateOpenPr(
      'github',
      { auth: 'u:t' },
      { url: 'https://github.com/acme/w/pull/9' },
      fields,
      { workspace: 'acme', repo: 'w' },
      { http },
    );
    expect(r).toEqual({ url: 'https://github.com/acme/w/pull/9', updated: false });
    expect(calls).toHaveLength(0);
  });

  it('a host decline (non-200) re-pins the URL and discloses updated:false — never throws, never aborts the reuse', async () => {
    const { http } = fakeProbe([[isPatch, { status: 403, json: null }]]);
    const r = await updateOpenPr(
      'github',
      { auth: 'u:t' },
      { url: 'https://github.com/acme/w/pull/9', number: 9 },
      fields,
      { workspace: 'acme', repo: 'w' },
      { http },
    );
    expect(r).toEqual({ url: 'https://github.com/acme/w/pull/9', updated: false });
  });

  it('a probe that rejects is swallowed into updated:false (a value, not a throw)', async () => {
    const http: HttpProbe = { request: () => Promise.reject(new Error('network down')) };
    const r = await updateOpenPr(
      'github',
      { auth: 'u:t' },
      { url: 'https://github.com/acme/w/pull/9', number: 9 },
      fields,
      { workspace: 'acme', repo: 'w' },
      { http },
    );
    expect(r).toEqual({ url: 'https://github.com/acme/w/pull/9', updated: false });
  });

  it('an unknown host is a no-op — re-pins the URL, updated:false, no network', async () => {
    const { http, calls } = fakeProbe([]);
    const r = await updateOpenPr(
      'unknown',
      { auth: 'u:p' },
      { url: 'x', number: 1 },
      fields,
      { workspace: '', repo: '' },
      { http },
    );
    expect(r).toEqual({ url: 'x', updated: false });
    expect(calls).toHaveLength(0);
  });
});

// ─── The close-phrase guard (issue #125) ─────────────────────────────────────
//
// The reuse is last-writer-wins by design, and must stay that way — a cap=1
// re-dispatch's freshly composed render has to land on the PR the first Worker
// opened. The guard protects the ONE property whose loss is silent: the
// store-kind close phrase. A rewrite that drops it produces a PR that merges
// normally and a row that never reaches `done` — nothing anywhere fails.

describe('findClosePhrase / hasClosePhrase', () => {
  it('finds the github store-kind phrase', () => {
    expect(findClosePhrase('Summary.\n\nCloses #42')).toBe('Closes #42');
    expect(hasClosePhrase('Closes #42')).toBe(true);
  });

  it('finds the linear store-kind phrase', () => {
    expect(findClosePhrase('Summary.\n\nFixes EX-16')).toBe('Fixes EX-16');
  });

  it('is case-insensitive and accepts every closing keyword both trackers act on', () => {
    for (const phrase of ['closes #7', 'CLOSED #7', 'fix #7', 'fixes EX-7', 'Resolved EX-7', 'Closes: #7']) {
      expect(hasClosePhrase(`body\n\n${phrase}`)).toBe(true);
    }
  });

  it('accepts the full issue-URL form GitHub also honours', () => {
    expect(hasClosePhrase('Closes https://github.com/acme/w/issues/42')).toBe(true);
  });

  it('a body with no phrase — including the exploratory one-word body that caused this — carries none', () => {
    expect(findClosePhrase('probe')).toBeNull();
    expect(hasClosePhrase('')).toBe(false);
    expect(hasClosePhrase('Summary line.\n\n## Reviewer verdict\napprove')).toBe(false);
  });

  it('a BARE id is not a close phrase — the keyword is what makes it one', () => {
    // The mention footgun (Convention 4's flip side) is a different concern; the
    // guard must not read every sighting of an id as a close phrase.
    expect(hasClosePhrase('EX-16 was the row this builds on')).toBe(false);
    expect(hasClosePhrase('see #42 for context')).toBe(false);
  });

  // ── Coincidental prose must never read as a reference ─────────────────────
  //
  // A hyphenated technical token is structurally INDISTINGUISHABLE from a Linear
  // reference (`UTF-8` and `EX-8` are the same shape), so the matcher is anchored
  // to the line instead: every real phrase is composed as a standalone line, and
  // prose never is. These fixtures are the falsification of that claim — the
  // first is verbatim the bypass a Reviewer reproduced against the unanchored
  // matcher, where `resolves UTF-8` matched as if it were a tracker reference.

  it('a mid-sentence keyword + hyphenated technical token is NOT a close phrase', () => {
    expect(
      hasClosePhrase(
        'This resolves UTF-8 encoding edge cases in the parser body, no real close phrase here.',
      ),
    ).toBe(false);
    expect(hasClosePhrase('closes UTF-8 handling gap')).toBe(false);
    expect(hasClosePhrase('fixes ISO-8601 parsing')).toBe(false);
    expect(hasClosePhrase('Summary.\n\nThis fixes SHA-256 digest drift in the signer.')).toBe(false);
    expect(hasClosePhrase('- resolves RFC-3339 timestamps for the audit log')).toBe(false);
  });

  it('a lowercase hyphenated token is not a team reference — the team key must be UPPERCASE', () => {
    // The old matcher carried an `i` flag over the whole pattern, which let a
    // lowercase `utf-8` satisfy the uppercase team-key class.
    expect(hasClosePhrase('fixes utf-8')).toBe(false);
    expect(hasClosePhrase('closes iso-8601')).toBe(false);
  });

  it('a reference is token-bounded — never the head of a longer hyphenated token', () => {
    expect(hasClosePhrase('Fixes ISO-8601-2019')).toBe(false);
    expect(hasClosePhrase('Fixes EX-16-rc1')).toBe(false);
    expect(hasClosePhrase('Closes #42-draft')).toBe(false);
  });

  it('the phrase must OWN its line — a phrase buried mid-sentence is not detected', () => {
    expect(hasClosePhrase('Summary of the work. Closes #42 as part of the batch.')).toBe(false);
    // …and the same phrase on its own line is.
    expect(hasClosePhrase('Summary of the work.\n\nCloses #42')).toBe(true);
  });

  it('still accepts the real composed forms — indent, list marker, CRLF, trailing punctuation', () => {
    expect(findClosePhrase('Summary.\r\n\r\nCloses #42\r\n')).toBe('Closes #42');
    expect(findClosePhrase('Summary.\n\n  Fixes EX-16\n')).toBe('Fixes EX-16');
    expect(findClosePhrase('Summary.\n\n- Fixes EX-16')).toBe('Fixes EX-16');
    expect(findClosePhrase('Summary.\n\nCloses #42.')).toBe('Closes #42');
  });
});

describe('closePhraseLossReason (the refusal predicate)', () => {
  const withPhrase = 'Summary.\n\n## Reviewer verdict\napprove\n\nFixes EX-1';
  const withoutPhrase = 'probe';

  it('REFUSES a rewrite that would drop the live body\'s phrase, and names the phrase at risk', () => {
    const reason = closePhraseLossReason(withPhrase, withoutPhrase);
    expect(reason).not.toBeNull();
    expect(reason).toContain('Fixes EX-1');
    // It must say WHY, and point at the read-only verb + the override.
    expect(reason).toMatch(/done/);
    expect(reason).toContain('host-pr status');
    expect(reason).toContain('--allow-close-phrase-loss');
  });

  it('ALLOWS the legitimate re-dispatch — a freshly composed render carrying the phrase', () => {
    expect(closePhraseLossReason(withPhrase, 'New render.\n\nFixes EX-1')).toBeNull();
  });

  it('ALLOWS a replacement carrying a DIFFERENT phrase — presence is the property, not identity', () => {
    expect(closePhraseLossReason('old\n\nFixes EX-1', 'new\n\nCloses #9')).toBeNull();
  });

  it('ALLOWS when the live body carries no phrase — there is nothing to lose', () => {
    expect(closePhraseLossReason('just prose', withoutPhrase)).toBeNull();
    expect(closePhraseLossReason('', withoutPhrase)).toBeNull();
  });

  it('ALLOWS when the live body was not readable — absence of evidence is never a finding', () => {
    expect(closePhraseLossReason(undefined, withoutPhrase)).toBeNull();
  });

  it('REFUSES a prose replacement whose only keyword sighting is coincidental (the reviewed bypass)', () => {
    // Verbatim the probe that slipped past the unanchored matcher: `resolves
    // UTF-8` was read as a genuine reference, so the phrase-less body was let
    // through and would have clobbered a live `Fixes EX-125`.
    const reason = closePhraseLossReason(
      'Worker summary.\n\nFixes EX-125',
      'This resolves UTF-8 encoding edge cases in the parser body, no real close phrase here.',
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain('Fixes EX-125');
  });

  it('REFUSES the other coincidental-prose replacements too', () => {
    for (const prose of [
      'closes UTF-8 handling gap',
      'fixes ISO-8601 parsing',
      'This fixes SHA-256 digest drift in the signer.',
    ]) {
      expect(closePhraseLossReason(withPhrase, prose)).not.toBeNull();
    }
  });

  it('still ALLOWS both genuine store-kind forms as the replacement', () => {
    expect(closePhraseLossReason(withPhrase, 'Re-dispatch render.\n\nCloses #125')).toBeNull();
    expect(closePhraseLossReason(withPhrase, 'Re-dispatch render.\n\nFixes EX-125')).toBeNull();
  });
});

describe('updateOpenPr — the close-phrase guard', () => {
  const live = 'Worker summary.\n\nCloses #125';
  const ref = { url: 'https://github.com/acme/w/pull/9', number: 9, body: live };

  it('REFUSES the phrase-dropping rewrite and issues NO request at all (the clobber never happens)', async () => {
    const { http, calls } = fakeProbe([[isPatch, { status: 200, json: {} }]]);
    const r = await updateOpenPr(
      'github',
      { auth: 'u:t' },
      ref,
      { title: 'probe', body: 'probe' },
      { workspace: 'acme', repo: 'w' },
      { http },
    );
    expect(r.updated).toBe(false);
    expect(r.refused).toBe(true);
    expect(r.url).toBe(ref.url);
    expect(r.reason).toContain('Closes #125');
    // NEGATIVE CONTROL for the guard itself: the refusal is worth nothing if the
    // PATCH still went out. Zero requests is the whole claim.
    expect(calls).toHaveLength(0);
  });

  it('the legitimate re-dispatch rewrite is BYTE-IDENTICAL to before the guard existed', async () => {
    const { http, calls } = fakeProbe([[isPatch, { status: 200, json: {} }]]);
    const composed = 'Fresh render.\n\n## Reviewer verdict\napprove\n\nCloses #125';
    const r = await updateOpenPr(
      'github',
      { auth: 'u:t' },
      ref,
      { title: 'Composed title', body: composed },
      { workspace: 'acme', repo: 'w' },
      { http },
    );
    expect(r).toEqual({ url: ref.url, updated: true });
    expect(r.refused).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ title: 'Composed title', body: composed });
  });

  it('allowClosePhraseLoss overrides the refusal — the deliberate overwrite path still exists', async () => {
    const { http, calls } = fakeProbe([[isPatch, { status: 200, json: {} }]]);
    const r = await updateOpenPr(
      'github',
      { auth: 'u:t' },
      ref,
      { title: 'probe', body: 'probe' },
      { workspace: 'acme', repo: 'w' },
      { http, allowClosePhraseLoss: true },
    );
    expect(r).toEqual({ url: ref.url, updated: true });
    expect(calls).toHaveLength(1);
  });

  it('a live body with no phrase is rewritten freely — the guard is about LOSS, not about requiring a phrase', async () => {
    const { http, calls } = fakeProbe([[isPatch, { status: 200, json: {} }]]);
    const r = await updateOpenPr(
      'github',
      { auth: 'u:t' },
      { url: ref.url, number: 9, body: 'a draft body, no phrase' },
      { title: 't', body: 'still no phrase' },
      { workspace: 'acme', repo: 'w' },
      { http },
    );
    expect(r).toEqual({ url: ref.url, updated: true });
    expect(calls).toHaveLength(1);
  });

  it('an UNREADABLE live body never refuses — reuse keeps working on any response that omits it', async () => {
    const { http, calls } = fakeProbe([[isPatch, { status: 200, json: {} }]]);
    const r = await updateOpenPr(
      'github',
      { auth: 'u:t' },
      { url: ref.url, number: 9 }, // no `body` key at all
      { title: 'probe', body: 'probe' },
      { workspace: 'acme', repo: 'w' },
      { http },
    );
    expect(r).toEqual({ url: ref.url, updated: true });
    expect(calls).toHaveLength(1);
  });

  it('the refusal outranks an unaddressable ref — it is a verdict on the CALL, not on the ref', async () => {
    const { http, calls } = fakeProbe([]);
    const r = await updateOpenPr(
      'github',
      { auth: 'u:t' },
      { url: ref.url, body: live }, // no number → nothing to PATCH either way
      { title: 'probe', body: 'probe' },
      { workspace: 'acme', repo: 'w' },
      { http },
    );
    expect(r.refused).toBe(true);
    expect(r.updated).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('guards the Bitbucket path identically (one owner, both hosts)', async () => {
    const { http, calls } = fakeProbe([[isPut, { status: 200, json: {} }]]);
    const r = await updateOpenPr(
      'bitbucket',
      { auth: 'u:p' },
      { url: 'https://bitbucket.org/ws/repo/pull-requests/7', number: 7, body: 'x\n\nFixes EX-1' },
      { title: 'probe', body: 'probe' },
      { workspace: 'ws', repo: 'repo' },
      { http },
    );
    expect(r.refused).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('findOpenPrRef — the live body the guard grades against', () => {
  it('surfaces the GitHub PR body alongside url + number', async () => {
    const { http } = fakeProbe([
      [isGet, { status: 200, json: [{ html_url: 'https://github.com/acme/w/pull/9', number: 9, body: 'live\n\nCloses #9' }] }],
    ]);
    const r = await findOpenPrRef('github', { auth: 'u:t' }, 'b', { workspace: 'acme', repo: 'w' }, { http });
    expect(r).toEqual({ url: 'https://github.com/acme/w/pull/9', number: 9, body: 'live\n\nCloses #9' });
  });

  it('surfaces the Bitbucket `description` as the body', async () => {
    const { http } = fakeProbe([
      [
        isGet,
        {
          status: 200,
          json: {
            values: [
              { id: 7, description: 'live\n\nFixes EX-1', links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/7' } } },
            ],
          },
        },
      ],
    ]);
    const r = await findOpenPrRef('bitbucket', { auth: 'u:p' }, 'b', { workspace: 'ws', repo: 'repo' }, { http });
    expect(r).toEqual({ url: 'https://bitbucket.org/ws/repo/pull-requests/7', number: 7, body: 'live\n\nFixes EX-1' });
  });

  it('a null / absent body leaves the key ABSENT — unreadable, not known-empty', async () => {
    const { http } = fakeProbe([
      [isGet, { status: 200, json: [{ html_url: 'https://github.com/acme/w/pull/9', number: 9, body: null }] }],
    ]);
    const r = await findOpenPrRef('github', { auth: 'u:t' }, 'b', { workspace: 'acme', repo: 'w' }, { http });
    expect(r).toEqual({ url: 'https://github.com/acme/w/pull/9', number: 9 });
    expect(r && 'body' in r).toBe(false);
  });
});

// ─── createPr ────────────────────────────────────────────────────────────────

const createReq = {
  branch: 'wave-orch/56-host-pr',
  title: '[wave] host-pr',
  body: 'Closes #56',
  destination: 'main',
  info: { host: 'bitbucket' as const, workspace: 'ws', repo: 'repo' },
};

describe('createPr', () => {
  it('returns the real URL on a 201 (Bitbucket)', async () => {
    const { http, calls } = fakeProbe([
      [
        isPost,
        {
          status: 201,
          json: {
            links: {
              html: { href: 'https://bitbucket.org/ws/repo/pull-requests/12' },
            },
          },
        },
      ],
    ]);
    const r = await createPr('bitbucket', { auth: 'u:p' }, createReq, { http });
    expect(r).toEqual({
      url: 'https://bitbucket.org/ws/repo/pull-requests/12',
    });
    expect(calls[0].method).toBe('POST');
    // The serialised body carries the close_source_branch flag + destination.
    const sent = JSON.parse(calls[0].body ?? '{}');
    expect(sent.close_source_branch).toBe(true);
    expect(sent.destination.branch.name).toBe('main');
    expect(sent.source.branch.name).toBe('wave-orch/56-host-pr');
  });

  it('returns the real URL on a 201 (GitHub)', async () => {
    const { http } = fakeProbe([
      [
        isPost,
        { status: 201, json: { html_url: 'https://github.com/acme/w/pull/3' } },
      ],
    ]);
    const r = await createPr(
      'github',
      { auth: 'u:t' },
      { ...createReq, info: { host: 'github', workspace: 'acme', repo: 'w' } },
      { http },
    );
    expect(r).toEqual({ url: 'https://github.com/acme/w/pull/3' });
  });

  it('returns the pre-fill fallback signal on a 401 (a value, not a throw)', async () => {
    const { http } = fakeProbe([[isPost, { status: 401, json: null }]]);
    const r = await createPr('bitbucket', { auth: 'u:wrong' }, createReq, {
      http,
    });
    expect('url' in r).toBe(false);
    if ('error' in r) {
      expect(r.error).toContain('401');
      expect(r.fallbackPrefillUrl).toBe(
        'https://bitbucket.org/ws/repo/pull-requests/new?source=wave-orch%2F56-host-pr&t=1',
      );
    }
  });

  it('returns the pre-fill fallback on any non-2xx failure', async () => {
    const { http } = fakeProbe([[isPost, { status: 500, json: null }]]);
    const r = await createPr('bitbucket', { auth: 'u:p' }, createReq, { http });
    expect(
      'error' in r && r.fallbackPrefillUrl.includes('/pull-requests/new'),
    ).toBe(true);
  });

  it('returns the pre-fill fallback (not a throw) when the probe itself rejects', async () => {
    const http: HttpProbe = {
      request: () => Promise.reject(new Error('network down')),
    };
    const r = await createPr('bitbucket', { auth: 'u:p' }, createReq, { http });
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect(r.error).toContain('network down');
      expect(r.fallbackPrefillUrl).toContain('/pull-requests/new');
    }
  });

  it('returns a GitHub pre-fill URL on GitHub failure', async () => {
    const { http } = fakeProbe([[isPost, { status: 422, json: null }]]);
    const r = await createPr(
      'github',
      { auth: 'u:t' },
      { ...createReq, info: { host: 'github', workspace: 'acme', repo: 'w' } },
      { http },
    );
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect(r.fallbackPrefillUrl).toBe(
        'https://github.com/acme/w/pull/new/wave-orch%2F56-host-pr',
      );
    }
  });

  it('falls back when an unknown host is asked to create a PR (no network)', async () => {
    const { http, calls } = fakeProbe([]);
    const r = await createPr(
      'unknown',
      { auth: 'u:p' },
      { ...createReq, info: { host: 'unknown', workspace: '', repo: '' } },
      { http },
    );
    expect('error' in r).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

// ─── Idempotency contract: find-before-create ────────────────────────────────

describe('find-before-create idempotency', () => {
  it('an open PR found by findOpenPr short-circuits createPr (no duplicate POST)', async () => {
    // Simulate the terminator's sequence: find first, only POST on a miss.
    const { http, calls } = fakeProbe([
      [
        isGet,
        {
          status: 200,
          json: {
            values: [
              {
                links: {
                  html: {
                    href: 'https://bitbucket.org/ws/repo/pull-requests/7',
                  },
                },
              },
            ],
          },
        },
      ],
      [
        isPost,
        {
          status: 201,
          json: { links: { html: { href: 'SHOULD-NOT-BE-USED' } } },
        },
      ],
    ]);

    const existing = await findOpenPr(
      'bitbucket',
      { auth: 'u:p' },
      'wave-orch/56-host-pr',
      { workspace: 'ws', repo: 'repo' },
      { http },
    );
    expect(existing).toBe('https://bitbucket.org/ws/repo/pull-requests/7');

    // Caller would skip createPr — assert only the GET happened.
    expect(calls).toHaveLength(1);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });
});

// ─── Landing: arm | merge | status (ADR-0023) ────────────────────────────────

/**
 * Fake {@link LandingHost}. The landing logic under test is host-NEUTRAL — it
 * routes on `PrMergeability` and on the two typed errors, never on GitHub
 * specifics — so a hand-rolled fake is the whole seam. Zero network.
 *
 * `statuses`, when given, answers `getPrStatus` from a QUEUE — call 1 gets
 * `statuses[0]`, call 2 gets `statuses[1]`, etc., sticking on the last entry
 * once exhausted. Models a mergeability that resolves over a few probes
 * (the W10-F1 behind/recomputing race) without needing a real clock; `status`
 * (singular) stays the fixed-answer form every existing test already uses.
 */
function fakeLandingHost(opts: {
  status?: PrLandingStatus;
  statuses?: PrLandingStatus[];
  onEnableAutoMerge?: () => void;
  onMerge?: () => MergeResult;
  onDeleteBranch?: () => void;
}): { host: LandingHost; calls: string[] } {
  const calls: string[] = [];
  let statusCall = 0;
  const host: LandingHost = {
    async getPrStatus(branch: string): Promise<PrLandingStatus> {
      calls.push(`getPrStatus:${branch}`);
      if (opts.statuses !== undefined) {
        const next = opts.statuses[Math.min(statusCall, opts.statuses.length - 1)];
        statusCall++;
        return next;
      }
      return opts.status ?? { state: 'none' };
    },
    async enableAutoMerge(prNumber: number, method?: MergeMethod): Promise<void> {
      calls.push(`enableAutoMerge:${prNumber}:${method ?? ''}`);
      opts.onEnableAutoMerge?.();
    },
    async mergePullRequest(prNumber: number, method?: MergeMethod): Promise<MergeResult> {
      calls.push(`mergePullRequest:${prNumber}:${method ?? ''}`);
      return opts.onMerge?.() ?? { merged: true, sha: 'deadbeef' };
    },
    async deleteBranch(branch: string): Promise<void> {
      calls.push(`deleteBranch:${branch}`);
      opts.onDeleteBranch?.();
    },
  };
  return { host, calls };
}

const openPr = (mergeability: PrMergeability): PrLandingStatus => ({
  state: 'open',
  number: 42,
  url: 'https://github.com/acme/widgets/pull/42',
  mergeability,
});

/** No-op {@link ArmOptions.sleep} — keeps recompute-retry specs hermetic and fast. */
const instantSleep: NonNullable<ArmOptions['sleep']> = async () => {};

describe('alignedPrRef (FOR-54 — one url/number field name across every verb)', () => {
  it('projects a url onto BOTH `url` and `prUrl`', () => {
    expect(alignedPrRef({ url: 'https://x/pull/7' })).toEqual({
      url: 'https://x/pull/7',
      prUrl: 'https://x/pull/7',
    });
  });

  it('projects a number onto BOTH `number` and `prNumber`', () => {
    expect(alignedPrRef({ number: 42 })).toEqual({ number: 42, prNumber: 42 });
  });

  it('carries a url AND a number under all four aligned names (the status/arm/merge shape)', () => {
    expect(alignedPrRef({ url: 'u', number: 9 })).toEqual({
      url: 'u',
      prUrl: 'u',
      number: 9,
      prNumber: 9,
    });
  });

  it('omits an absent number entirely — the documented `create` shape (url only, no number)', () => {
    const ref = alignedPrRef({ url: 'u' });
    expect(ref).toEqual({ url: 'u', prUrl: 'u' });
    // ABSENT keys, not `undefined` values — so JSON.stringify drops them too.
    expect('number' in ref).toBe(false);
    expect('prNumber' in ref).toBe(false);
  });

  it('an empty ref (the `no-pr` outcome) yields no fields at all', () => {
    expect(alignedPrRef({})).toEqual({});
  });

  it('a number of 0 is preserved (not treated as absent)', () => {
    expect(alignedPrRef({ number: 0 })).toEqual({ number: 0, prNumber: 0 });
  });
});

describe('decideArmAction (ADR-0023 deterministic arm intent)', () => {
  it('clean → direct merge (nothing pending; arming a clean PR is rejected by the host)', () => {
    expect(decideArmAction('clean')).toMatchObject({ action: 'merge' });
  });

  it.each<PrMergeability>(['blocked', 'unstable', 'behind', 'unknown'])(
    '%s → enable-auto-merge (checks may still land)',
    (m) => {
      expect(decideArmAction(m)).toMatchObject({ action: 'enable-auto-merge' });
    },
  );

  it.each<PrMergeability>(['dirty', 'draft'])(
    '%s → refuse (no host action can land it — a human must act)',
    (m) => {
      expect(decideArmAction(m)).toMatchObject({ action: 'refuse' });
    },
  );

  it('every decision carries a non-empty human reason', () => {
    const all: PrMergeability[] = ['clean', 'blocked', 'unstable', 'behind', 'unknown', 'dirty', 'draft'];
    for (const m of all) expect(decideArmAction(m).reason.length).toBeGreaterThan(0);
  });
});

describe('armPullRequest', () => {
  it('clean PR → merges directly, never arms', async () => {
    const { host, calls } = fakeLandingHost({ status: openPr('clean') });
    const out = await armPullRequest(host, 'wave/FOR-26-x');
    expect(out).toMatchObject({ outcome: 'merged', prNumber: 42, sha: 'deadbeef' });
    expect(calls).toEqual(['getPrStatus:wave/FOR-26-x', 'mergePullRequest:42:squash']);
  });

  it('blocked PR (required checks pending) → arms, never merges directly', async () => {
    const { host, calls } = fakeLandingHost({ status: openPr('blocked') });
    const out = await armPullRequest(host, 'b');
    expect(out).toMatchObject({ outcome: 'armed', prNumber: 42 });
    expect(calls).toEqual(['getPrStatus:b', 'enableAutoMerge:42:squash']);
  });

  it('defaults to the squash merge method and honours an explicit override', async () => {
    expect(DEFAULT_MERGE_METHOD).toBe('squash');
    const { host, calls } = fakeLandingHost({ status: openPr('blocked') });
    await armPullRequest(host, 'b', 'rebase');
    expect(calls).toContain('enableAutoMerge:42:rebase');
  });

  it('an already-merged PR is an idempotent no-op (re-running wave-close never re-merges)', async () => {
    const { host, calls } = fakeLandingHost({
      status: { state: 'merged', number: 42, url: 'https://github.com/acme/widgets/pull/42' },
    });
    const out = await armPullRequest(host, 'b');
    expect(out).toMatchObject({ outcome: 'already-merged', prUrl: 'https://github.com/acme/widgets/pull/42' });
    expect(calls).toEqual(['getPrStatus:b']); // no write of any kind
  });

  it('no PR for the branch → no-pr, no writes', async () => {
    const { host, calls } = fakeLandingHost({ status: { state: 'none' } });
    expect(await armPullRequest(host, 'b')).toMatchObject({ outcome: 'no-pr' });
    expect(calls).toEqual(['getPrStatus:b']);
  });

  it('a closed-unmerged PR is refused, never re-opened or merged', async () => {
    const { host, calls } = fakeLandingHost({ status: { state: 'closed-unmerged', number: 42 } });
    expect(await armPullRequest(host, 'b')).toMatchObject({ outcome: 'refused' });
    expect(calls).toEqual(['getPrStatus:b']);
  });

  it('a dirty (conflicted) PR is refused with a reason', async () => {
    const { host } = fakeLandingHost({ status: openPr('dirty') });
    const out = await armPullRequest(host, 'b');
    expect(out).toMatchObject({ outcome: 'refused' });
    expect((out as { reason: string }).reason).toMatch(/conflict/i);
  });

  it('an open PR with no mergeability reported is treated as unknown → armed (never blind-merged)', async () => {
    const { host, calls } = fakeLandingHost({ status: { state: 'open', number: 42 } });
    // 'unknown' is a recomputing read too — inject an instant sleep so the
    // default retry (which never resolves against a fixed fake) stays fast.
    expect(await armPullRequest(host, 'b', DEFAULT_MERGE_METHOD, { sleep: instantSleep })).toMatchObject({
      outcome: 'armed',
    });
    expect(calls).toContain('enableAutoMerge:42:squash');
  });

  // ── Spike 2: arming an already-clean PR ─────────────────────────────────
  it('SPIKE-2: arm rejected with reason "clean-status" → falls back to a direct merge', async () => {
    const { host, calls } = fakeLandingHost({
      status: openPr('unknown'), // host had not computed mergeability → we arm…
      onEnableAutoMerge: () => {
        throw new AutoMergeUnavailableError('clean-status', 'Pull request is in clean status');
      },
    });
    const out = await armPullRequest(host, 'b', DEFAULT_MERGE_METHOD, { sleep: instantSleep });
    // …the host says "it is already clean" → the deterministic recovery is to merge.
    expect(out).toMatchObject({ outcome: 'merged', prNumber: 42 });
    // 'unknown' also triggers the default recompute retry (2 extra probes,
    // instant here) before the arm is even attempted; still never resolves
    // against the fixed fake, so it decides on the last-known read.
    expect(calls).toEqual([
      'getPrStatus:b',
      'getPrStatus:b',
      'getPrStatus:b',
      'enableAutoMerge:42:squash',
      'mergePullRequest:42:squash',
    ]);
  });

  it('arm rejected with reason "not-allowed" (repo setting off) + a pending required check (blocked) → refused, NOT merged', async () => {
    const { host, calls } = fakeLandingHost({
      status: openPr('blocked'),
      onEnableAutoMerge: () => {
        throw new AutoMergeUnavailableError('not-allowed', 'Auto merge is not allowed for this repository');
      },
    });
    const out = await armPullRequest(host, 'b');
    expect(out).toMatchObject({ outcome: 'refused' });
    // The whole point (AC3, ADR-0023 amendment): a repo with auto-merge OFF
    // must NOT silently become an immediate merge of a PR whose required
    // checks are still pending — the controlled-degrade fallback below NEVER
    // fires while mergeability is `blocked`.
    expect(calls).not.toContain('mergePullRequest:42:squash');
    expect((out as { reason: string }).reason).toMatch(/allow auto-merge/i);
  });

  it('an unexpected host error propagates (never swallowed into a false "armed")', async () => {
    const { host } = fakeLandingHost({
      status: openPr('blocked'),
      onEnableAutoMerge: () => {
        throw new Error('HTTP 500');
      },
    });
    await expect(armPullRequest(host, 'b')).rejects.toThrow('HTTP 500');
  });
});

// ─── Recompute retry (AC2, ADR-0023 amendment / W10-F1) ──────────────────────

describe('armPullRequest — recompute retry on a transient behind/recomputing read', () => {
  it('a transient behind read resolves to clean via retry — never wastes an arm attempt', async () => {
    const { host, calls } = fakeLandingHost({
      statuses: [openPr('behind'), openPr('behind'), openPr('clean')],
    });
    const out = await armPullRequest(host, 'b', DEFAULT_MERGE_METHOD, { sleep: instantSleep });
    expect(out).toMatchObject({ outcome: 'merged', prNumber: 42 });
    expect(calls).toEqual(['getPrStatus:b', 'getPrStatus:b', 'getPrStatus:b', 'mergePullRequest:42:squash']);
    expect(calls).not.toContain('enableAutoMerge:42:squash');
  });

  it('an unresolved recompute after the retry budget proceeds with the last-known read (never blocks indefinitely)', async () => {
    const { host, calls } = fakeLandingHost({ statuses: [openPr('unknown')] }); // never settles
    const out = await armPullRequest(host, 'b', DEFAULT_MERGE_METHOD, { sleep: instantSleep });
    expect(out).toMatchObject({ outcome: 'armed' });
    // Default budget: the initial read + 2 retries = 3 probes, then decide.
    expect(calls.filter((c) => c.startsWith('getPrStatus'))).toHaveLength(3);
    expect(calls).toContain('enableAutoMerge:42:squash');
  });

  it('recomputeRetries is honoured — 0 decides on the very first read', async () => {
    const { host, calls } = fakeLandingHost({ statuses: [openPr('behind')] });
    await armPullRequest(host, 'b', DEFAULT_MERGE_METHOD, { sleep: instantSleep, recomputeRetries: 0 });
    expect(calls).toEqual(['getPrStatus:b', 'enableAutoMerge:42:squash']);
  });

  it('a PR that reaches a terminal state during the retry window is reported honestly, never re-armed', async () => {
    const { host, calls } = fakeLandingHost({
      statuses: [
        openPr('behind'),
        { state: 'merged', number: 42, url: 'https://github.com/acme/widgets/pull/42' },
      ],
    });
    const out = await armPullRequest(host, 'b', DEFAULT_MERGE_METHOD, { sleep: instantSleep });
    expect(out).toMatchObject({ outcome: 'already-merged' });
    expect(calls).not.toContain('enableAutoMerge:42:squash');
    expect(calls).not.toContain('mergePullRequest:42:squash');
  });

  it('N-PR sequential arm: a PR briefly behind right after a sibling merged still lands, no refusal (W10-F1)', async () => {
    // PR #1 reads clean immediately and merges directly (mirrors the live #9).
    const { host: host1 } = fakeLandingHost({ status: openPr('clean') });
    expect(await armPullRequest(host1, 'wave/pr-1')).toMatchObject({ outcome: 'merged' });

    // PR #2: the base just moved out from under it — briefly `behind`,
    // resolving to `clean` on retry, exactly as the retro's #10 did ("an
    // idempotent retry landed #10, in the window again clean").
    const { host: host2, calls: calls2 } = fakeLandingHost({
      statuses: [openPr('behind'), openPr('clean')],
    });
    const out2 = await armPullRequest(host2, 'wave/pr-2', DEFAULT_MERGE_METHOD, { sleep: instantSleep });
    expect(out2).toMatchObject({ outcome: 'merged' });
    expect(calls2).not.toContain('enableAutoMerge:42:squash');
  });

  it('the default recompute delay is a real timer in production (no injected sleep) — not synchronous', async () => {
    vi.useFakeTimers();
    try {
      const { host, calls } = fakeLandingHost({ statuses: [openPr('behind'), openPr('clean')] });
      const pending = armPullRequest(host, 'b'); // no opts — exercises defaultSleep for real
      await vi.advanceTimersByTimeAsync(0);
      // Still waiting on the timer: only the initial probe has happened.
      expect(calls).toEqual(['getPrStatus:b']);
      await vi.advanceTimersByTimeAsync(1000); // comfortably covers the default delay
      const out = await pending;
      expect(out).toMatchObject({ outcome: 'merged' });
      expect(calls).toEqual(['getPrStatus:b', 'getPrStatus:b', 'mergePullRequest:42:squash']);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── Controlled degrade: refused + zero pending required checks (AC1/AC3) ────

describe('armPullRequest — refused+mergeable controlled degrade (ADR-0023 amendment, W10-F1)', () => {
  it('not-allowed refusal + zero pending required checks (unstable) → falls back to a direct merge, reason names the fallback (the live refused-then-merged sequence)', async () => {
    const { host, calls } = fakeLandingHost({
      status: openPr('unstable'),
      onEnableAutoMerge: () => {
        throw new AutoMergeUnavailableError('not-allowed', 'The repository does not permit auto-merge');
      },
    });
    const out = await armPullRequest(host, 'b');
    expect(out).toMatchObject({ outcome: 'merged', prNumber: 42 });
    expect(calls).toEqual(['getPrStatus:b', 'enableAutoMerge:42:squash', 'mergePullRequest:42:squash']);
    expect((out as { reason: string }).reason).toMatch(/controlled degrade/i);
    expect((out as { reason: string }).reason).toMatch(/does not permit auto-merge/i);
  });

  it('not-allowed refusal + a still-behind read after the retry budget → also falls back (zero pending required checks)', async () => {
    const { host, calls } = fakeLandingHost({
      statuses: [openPr('behind')], // never resolves away from `behind`
      onEnableAutoMerge: () => {
        throw new AutoMergeUnavailableError('not-allowed', 'The repository does not permit auto-merge');
      },
    });
    const out = await armPullRequest(host, 'b', DEFAULT_MERGE_METHOD, { sleep: instantSleep });
    expect(out).toMatchObject({ outcome: 'merged', prNumber: 42 });
    expect(calls).toContain('mergePullRequest:42:squash');
  });

  it('clean-status refusal stays an UNCONDITIONAL fallback (SPIKE 2 unaffected by the new gate)', async () => {
    const { host, calls } = fakeLandingHost({
      status: openPr('unstable'),
      onEnableAutoMerge: () => {
        throw new AutoMergeUnavailableError('clean-status', 'Pull request is in clean status');
      },
    });
    const out = await armPullRequest(host, 'b');
    expect(out).toMatchObject({ outcome: 'merged' });
    expect(calls).toContain('mergePullRequest:42:squash');
  });

  it('NEGATIVE SPEC (AC3): not-allowed refusal + a pending required check — even one only revealed after the recompute retry — NEVER falls back; refused stays refused', async () => {
    const { host, calls } = fakeLandingHost({
      statuses: [openPr('unknown'), openPr('blocked')], // recompute settles into a REAL block
      onEnableAutoMerge: () => {
        throw new AutoMergeUnavailableError('not-allowed', 'The repository does not permit auto-merge');
      },
    });
    const out = await armPullRequest(host, 'b', DEFAULT_MERGE_METHOD, { sleep: instantSleep });
    expect(out).toMatchObject({ outcome: 'refused' });
    // The whole point of the gate: a required check IS pending — merging here
    // would land a PR past exactly the check the human expected to hold.
    expect(calls).not.toContain('mergePullRequest:42:squash');
  });

  it('a merge the host declines during the fallback (merged:false) is still reported as refused, not merged', async () => {
    const { host } = fakeLandingHost({
      status: openPr('unstable'),
      onEnableAutoMerge: () => {
        throw new AutoMergeUnavailableError('not-allowed', 'The repository does not permit auto-merge');
      },
      onMerge: () => ({ merged: false }),
    });
    const out = await armPullRequest(host, 'b');
    // The host is the FINAL gate even inside the fallback: a decline is a
    // decline, never silently upgraded to a false "merged".
    expect(out).toMatchObject({ outcome: 'refused' });
  });
});

describe('mergePullRequestNow (the `merge` verb — no arming, no decision)', () => {
  it('merges an open PR regardless of pending checks', async () => {
    const { host, calls } = fakeLandingHost({ status: openPr('blocked') });
    expect(await mergePullRequestNow(host, 'b')).toMatchObject({ outcome: 'merged', prNumber: 42 });
    expect(calls).toEqual(['getPrStatus:b', 'mergePullRequest:42:squash']);
  });

  it('is idempotent on an already-merged PR', async () => {
    const { host, calls } = fakeLandingHost({ status: { state: 'merged', number: 42 } });
    expect(await mergePullRequestNow(host, 'b')).toMatchObject({ outcome: 'already-merged' });
    expect(calls).toEqual(['getPrStatus:b']);
  });

  it('no PR → no-pr, no writes', async () => {
    const { host } = fakeLandingHost({ status: { state: 'none' } });
    expect(await mergePullRequestNow(host, 'b')).toMatchObject({ outcome: 'no-pr' });
  });

  it('reports a merge the host declined (merged:false) as refused, not merged', async () => {
    const { host } = fakeLandingHost({
      status: openPr('blocked'),
      onMerge: () => ({ merged: false }),
    });
    expect(await mergePullRequestNow(host, 'b')).toMatchObject({ outcome: 'refused' });
  });
});

// ─── merge --delete-branch (consumer KW-F6 — remote branch hygiene at landing) ─

describe('mergePullRequestNow — --delete-branch (consumer KW-F6)', () => {
  it('deletes the PR head branch AFTER a successful merge, reported structurally', async () => {
    const { host, calls } = fakeLandingHost({ status: openPr('blocked') });
    const out = await mergePullRequestNow(host, 'wave/FOR-66-x', DEFAULT_MERGE_METHOD, {
      deleteBranch: true,
    });
    expect(out).toMatchObject({
      outcome: 'merged',
      prNumber: 42,
      branchDeletion: { branch: 'wave/FOR-66-x', deleted: true },
    });
    // Deletion happens strictly AFTER the merge (ordering matters — never before).
    expect(calls).toEqual([
      'getPrStatus:wave/FOR-66-x',
      'mergePullRequest:42:squash',
      'deleteBranch:wave/FOR-66-x',
    ]);
    // A success carries no `error` key.
    expect('error' in (out as { branchDeletion: object }).branchDeletion).toBe(false);
  });

  it('without the flag, the merge is BYTE-IDENTICAL — no delete call, no branchDeletion key', async () => {
    const { host, calls } = fakeLandingHost({ status: openPr('blocked') });
    const out = await mergePullRequestNow(host, 'b');
    // The exact shape the `merge` verb has always returned (no new key).
    expect(out).toEqual({
      outcome: 'merged',
      prNumber: 42,
      prUrl: 'https://github.com/acme/widgets/pull/42',
      sha: 'deadbeef',
      reason: 'Direct merge requested — no arm intent evaluated.',
    });
    expect('branchDeletion' in out).toBe(false);
    expect(calls).toEqual(['getPrStatus:b', 'mergePullRequest:42:squash']);
  });

  it('a FAILED branch deletion after a successful merge is a reported degradation, NOT a merge failure', async () => {
    const { host, calls } = fakeLandingHost({
      status: openPr('blocked'),
      onDeleteBranch: () => {
        throw new Error('Reference does not exist');
      },
    });
    const out = await mergePullRequestNow(host, 'b', DEFAULT_MERGE_METHOD, { deleteBranch: true });
    // The merge still succeeded → the outcome stays `merged`, sha intact.
    expect(out).toMatchObject({
      outcome: 'merged',
      prNumber: 42,
      sha: 'deadbeef',
      branchDeletion: { branch: 'b', deleted: false, error: 'Reference does not exist' },
    });
    expect(calls).toEqual(['getPrStatus:b', 'mergePullRequest:42:squash', 'deleteBranch:b']);
  });

  it('a host that DECLINED the merge (merged:false) never attempts a branch delete', async () => {
    const { host, calls } = fakeLandingHost({
      status: openPr('blocked'),
      onMerge: () => ({ merged: false }),
    });
    const out = await mergePullRequestNow(host, 'b', DEFAULT_MERGE_METHOD, { deleteBranch: true });
    expect(out).toMatchObject({ outcome: 'refused' });
    expect(calls).not.toContain('deleteBranch:b');
  });

  it('the merge method is honoured independently of the delete flag', async () => {
    const { host, calls } = fakeLandingHost({ status: openPr('blocked') });
    await mergePullRequestNow(host, 'b', 'rebase', { deleteBranch: true });
    expect(calls).toEqual(['getPrStatus:b', 'mergePullRequest:42:rebase', 'deleteBranch:b']);
  });

  it('without opts.deleteBranch, arm still never deletes — unchanged default behaviour', async () => {
    // A clean PR arms into a DIRECT merge (same `merge` helper), yet without the
    // flag, the branch stays untouched and no branchDeletion key appears.
    const { host, calls } = fakeLandingHost({ status: openPr('clean') });
    const out = await armPullRequest(host, 'b');
    expect(out).toMatchObject({ outcome: 'merged' });
    expect('branchDeletion' in out).toBe(false);
    expect(calls).not.toContain('deleteBranch:b');
  });
});

// ─── arm --delete-branch (FOR-66-class reproduction — issue #126) ────────────
//
// The FOR-66 fix (KW-F6) was wired ONLY onto `mergePullRequestNow` (the block
// above): `armPullRequest`'s OWN three merge call-sites (the `clean` decision,
// the `clean-status` recovery, the `not-allowed` controlled-degrade) never
// carried a delete option at all — so a landing that went through `arm` and
// bottomed out in one of those direct merges NEVER deleted the branch, no
// matter the repo's "Automatically delete head branches" setting. This is the
// consumer's live reproduction: three `outcome: merged` rows landed through
// `arm`, and all three head branches (remote AND local) survived. These specs
// drive exactly that route — an arm call that resolves to an immediate merge —
// rather than merely asserting the intent.

describe('armPullRequest — --delete-branch (FOR-66-class reproduction, issue #126)', () => {
  it('a CLEAN PR armed with --delete-branch merges directly AND deletes the branch — parity with the merge verb', async () => {
    const { host, calls } = fakeLandingHost({ status: openPr('clean') });
    const out = await armPullRequest(host, 'wave/FOR-66-arm', DEFAULT_MERGE_METHOD, {
      deleteBranch: true,
    });
    expect(out).toMatchObject({
      outcome: 'merged',
      prNumber: 42,
      branchDeletion: { branch: 'wave/FOR-66-arm', deleted: true },
    });
    // Deletion happens strictly AFTER the merge, same ordering as the merge verb.
    expect(calls).toEqual([
      'getPrStatus:wave/FOR-66-arm',
      'mergePullRequest:42:squash',
      'deleteBranch:wave/FOR-66-arm',
    ]);
  });

  it('the clean-status recovery (SPIKE 2) deletes the branch too, when requested', async () => {
    const { host, calls } = fakeLandingHost({
      status: openPr('unknown'),
      onEnableAutoMerge: () => {
        throw new AutoMergeUnavailableError('clean-status', 'Pull request is in clean status');
      },
    });
    const out = await armPullRequest(host, 'b', DEFAULT_MERGE_METHOD, {
      sleep: instantSleep,
      deleteBranch: true,
    });
    expect(out).toMatchObject({
      outcome: 'merged',
      branchDeletion: { branch: 'b', deleted: true },
    });
    expect(calls).toContain('deleteBranch:b');
  });

  it('the not-allowed controlled-degrade (zero pending required checks) deletes the branch too, when requested', async () => {
    const { host, calls } = fakeLandingHost({
      status: openPr('unstable'),
      onEnableAutoMerge: () => {
        throw new AutoMergeUnavailableError('not-allowed', 'The repository does not permit auto-merge');
      },
    });
    const out = await armPullRequest(host, 'b', DEFAULT_MERGE_METHOD, { deleteBranch: true });
    expect(out).toMatchObject({
      outcome: 'merged',
      branchDeletion: { branch: 'b', deleted: true },
    });
    expect(calls).toContain('deleteBranch:b');
  });

  it('a FAILED branch deletion after an arm-driven merge is a reported degradation, NOT a merge failure', async () => {
    const { host, calls } = fakeLandingHost({
      status: openPr('clean'),
      onDeleteBranch: () => {
        throw new Error('Reference does not exist');
      },
    });
    const out = await armPullRequest(host, 'b', DEFAULT_MERGE_METHOD, { deleteBranch: true });
    expect(out).toMatchObject({
      outcome: 'merged',
      branchDeletion: { branch: 'b', deleted: false, error: 'Reference does not exist' },
    });
    expect(calls).toContain('deleteBranch:b');
  });

  it('a merge the host DECLINES during arm never attempts a branch delete', async () => {
    const { host, calls } = fakeLandingHost({
      status: openPr('clean'),
      onMerge: () => ({ merged: false }),
    });
    const out = await armPullRequest(host, 'b', DEFAULT_MERGE_METHOD, { deleteBranch: true });
    expect(out).toMatchObject({ outcome: 'refused' });
    expect(calls).not.toContain('deleteBranch:b');
  });

  it('a TRUE arm (outcome `armed`, enable-auto-merge accepted) never deletes synchronously — the merge has not happened yet', async () => {
    const { host, calls } = fakeLandingHost({ status: openPr('blocked') });
    const out = await armPullRequest(host, 'b', DEFAULT_MERGE_METHOD, { deleteBranch: true });
    expect(out).toMatchObject({ outcome: 'armed', prNumber: 42 });
    expect('branchDeletion' in out).toBe(false);
    expect(calls).not.toContain('deleteBranch:b');
    // The reason DISCLOSES the deferral — this is where the close skill's
    // checked step can point when the branch is still present after an arm.
    expect((out as { reason: string }).reason).toMatch(/deferred/i);
    expect((out as { reason: string }).reason).toMatch(/Automatically delete head branches/i);
  });

  it('a TRUE arm without --delete-branch carries the ORIGINAL reason, unchanged (byte-identical when the flag is absent)', async () => {
    const { host } = fakeLandingHost({ status: openPr('blocked') });
    const out = await armPullRequest(host, 'b');
    expect(out).toMatchObject({
      outcome: 'armed',
      reason: 'A required check or review is still pending — arm the PR to land itself once it passes.',
    });
  });
});

// ─── The check-ATTACH gate: "none reported" is NOT "all required passed" ──────
//
// EVIDENCE — two live occurrences, 2026-07-30, both on pull requests ~90 seconds
// old, both on this repository, whose `main` ruleset names exactly two required
// checks ("Engine Tests (vitest)" and "Engine Typecheck (tsc)"):
//
//   OCCURRENCE 1 — the ops-guards wave's landing round. `host-pr arm` on the
//   freshly-created row PRs answered `outcome: merged`, `reason: "PR is clean —
//   no pending required checks"`. The same session's `host-pr preflight` had
//   listed both required checks minutes earlier, so the ruleset was demonstrably
//   in force; what had not happened yet was the CHECK ATTACH — no check run was
//   associated with the head commit at the instant the arm read mergeability, so
//   GitHub reported `clean` and the arm took the direct-merge branch.
//
//   OCCURRENCE 2 — minutes after the defect was filed, arming the retro docs PR
//   (~90 s old) produced the identical answer: merged, "PR is clean, no pending
//   required checks". Whether those docs-only checks had genuinely completed or
//   had simply not attached yet is INDISTINGUISHABLE from the arm output — and
//   that is itself the defect being fixed here: the caller cannot tell
//   all-required-passed from none-reported, because both render as `clean`.
//
// The specs below pin the distinction the fix draws, against a faked host.

/** A `RequiredChecksInfo` whose effective-rules read found `contexts` in force. */
const requiredPresent = (...contexts: string[]): RequiredChecksInfo => ({
  state: 'present',
  contexts,
  detail: `fake: required — ${contexts.join(', ')}`,
});

/** The AUTHORITATIVE "this branch requires no status checks" answer. */
const requiredAbsent = (): RequiredChecksInfo => ({
  state: 'absent',
  contexts: [],
  detail: 'fake: the effective rules require no status checks',
});

/** The BLIND answer — the probe could not read the rules either way. */
const requiredUnknown = (): RequiredChecksInfo => ({
  state: 'unknown',
  contexts: [],
  detail: 'fake: both reads were unavailable',
});

/** The two required checks named by this repo's live ruleset (both occurrences). */
const VITEST_CHECK = 'Engine Tests (vitest)';
const TSC_CHECK = 'Engine Typecheck (tsc)';

/**
 * The FRESH-PR shape from both live occurrences: an open PR the host reports as
 * `clean` — not because the required checks passed, but because none has reported
 * yet. `headSha`/`baseRef` are what the attach comparison is asked about.
 */
const freshCleanPr = (): PrLandingStatus => ({
  state: 'open',
  number: 42,
  url: 'https://github.com/acme/widgets/pull/42',
  mergeability: 'clean',
  headSha: 'c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ffee',
  baseRef: 'main',
});

/**
 * A {@link fakeLandingHost} that ALSO implements the two optional
 * {@link CheckAttachReader} reads, so `asCheckAttachReader` finds them. Kept
 * separate from `fakeLandingHost` on purpose: every existing spec uses a host
 * WITHOUT these reads, which is itself the "a host that cannot answer keeps
 * today's behaviour" case, and must stay that way.
 */
function fakeAttachAwareHost(opts: {
  status?: PrLandingStatus;
  statuses?: PrLandingStatus[];
  onEnableAutoMerge?: () => void;
  onMerge?: () => MergeResult;
  onDeleteBranch?: () => void;
  required: RequiredChecksInfo;
  reported?: ReportedCheck[];
  /** When set, `getReportedChecks` THROWS this message (a failed read). */
  reportedThrows?: string;
  /** When set, `getRequiredChecks` THROWS this message (a failed read). */
  requiredThrows?: string;
}): { host: LandingHost; calls: string[] } {
  const base = fakeLandingHost(opts);
  const host = base.host as LandingHost & CheckAttachReader;
  host.getRequiredChecks = async (branch?: string) => {
    base.calls.push(`getRequiredChecks:${branch ?? ''}`);
    if (opts.requiredThrows !== undefined) throw new Error(opts.requiredThrows);
    return opts.required;
  };
  host.getReportedChecks = async (ref: string) => {
    base.calls.push(`getReportedChecks:${ref}`);
    if (opts.reportedThrows !== undefined) throw new Error(opts.reportedThrows);
    return opts.reported ?? [];
  };
  return { host, calls: base.calls };
}

const green = (name: string): ReportedCheck => ({ name, state: 'success' });

describe('compareRequiredToReported (the pure required-vs-reported comparison)', () => {
  it('ZERO reported against required checks → every one is unreported, NEVER attached', () => {
    // The load-bearing claim of the whole fix: an empty report list can never
    // satisfy "all required checks passed".
    expect(compareRequiredToReported([VITEST_CHECK, TSC_CHECK], [])).toEqual({
      required: [VITEST_CHECK, TSC_CHECK],
      unreported: [VITEST_CHECK, TSC_CHECK],
      unsettled: [],
      attached: false,
    });
  });

  it('every required check reported green → attached, nothing missing', () => {
    expect(compareRequiredToReported([VITEST_CHECK, TSC_CHECK], [green(VITEST_CHECK), green(TSC_CHECK)])).toEqual({
      required: [VITEST_CHECK, TSC_CHECK],
      unreported: [],
      unsettled: [],
      attached: true,
    });
  });

  it('NO required checks is vacuously attached (a repo with no CI keeps direct-merging)', () => {
    expect(compareRequiredToReported([], [])).toMatchObject({ required: [], attached: true });
  });

  it('a PARTIAL attach — one reported, one not — is not attached, and names only the missing one', () => {
    expect(compareRequiredToReported([VITEST_CHECK, TSC_CHECK], [green(VITEST_CHECK)])).toMatchObject({
      unreported: [TSC_CHECK],
      unsettled: [],
      attached: false,
    });
  });

  it('separates "reported but not green" (unsettled) from "not reported at all" (unreported)', () => {
    const out = compareRequiredToReported(
      [VITEST_CHECK, TSC_CHECK],
      [{ name: VITEST_CHECK, state: 'pending' }],
    );
    expect(out).toMatchObject({ unsettled: [VITEST_CHECK], unreported: [TSC_CHECK], attached: false });
  });

  it('a required check reported as FAILURE is unsettled, never attached', () => {
    expect(
      compareRequiredToReported([VITEST_CHECK], [{ name: VITEST_CHECK, state: 'failure' }]),
    ).toMatchObject({ unsettled: [VITEST_CHECK], attached: false });
  });

  it('reports for checks that are NOT required are ignored entirely', () => {
    expect(
      compareRequiredToReported([VITEST_CHECK], [green(VITEST_CHECK), green('some/optional-lint')]),
    ).toMatchObject({ required: [VITEST_CHECK], attached: true });
  });

  it('de-duplicates the required list and reads a duplicate report tolerantly (any green counts)', () => {
    expect(compareRequiredToReported([VITEST_CHECK, VITEST_CHECK], [
      { name: VITEST_CHECK, state: 'pending' },
      green(VITEST_CHECK),
    ])).toEqual({ required: [VITEST_CHECK], unreported: [], unsettled: [], attached: true });
  });

  it('matching is EXACT on the name — a near-miss context is not a report for the required check', () => {
    expect(compareRequiredToReported([VITEST_CHECK], [green('engine tests (vitest)')])).toMatchObject({
      unreported: [VITEST_CHECK],
      attached: false,
    });
  });
});

describe('refineArmDecisionForCheckAttach (the clean/pending distinction)', () => {
  const cleanDecision = (): ArmDecision => decideArmAction('clean');

  it('AC1 (unit): required checks in force + ZERO reported → the merge becomes an ARM', () => {
    const attach = compareRequiredToReported([VITEST_CHECK, TSC_CHECK], []);
    const out = refineArmDecisionForCheckAttach(cleanDecision(), attach);
    expect(out.action).toBe('enable-auto-merge');
    // The reason must state the distinction in words, not just change the action —
    // occurrence 2's whole complaint was that the OUTPUT could not be read.
    expect(out.reason).toMatch(/not "all required checks passed"/i);
    expect(out.reason).toMatch(/check-attach latency/i);
    expect(out.reason).toContain(VITEST_CHECK);
    expect(out.reason).toContain(TSC_CHECK);
  });

  it('AC2 (unit): all required checks reported green → still a direct merge, and the reason NAMES them', () => {
    const attach = compareRequiredToReported([VITEST_CHECK, TSC_CHECK], [green(VITEST_CHECK), green(TSC_CHECK)]);
    const out = refineArmDecisionForCheckAttach(cleanDecision(), attach);
    expect(out.action).toBe('merge');
    expect(out.reason).toMatch(/Verified: all 2 required check\(s\) have reported success/);
  });

  it('AC2 (unit): no required checks configured → direct merge, authoritatively (not a guess)', () => {
    const out = refineArmDecisionForCheckAttach(cleanDecision(), compareRequiredToReported([], []));
    expect(out.action).toBe('merge');
    expect(out.reason).toMatch(/require NO status checks/i);
  });

  it('no evidence available (null) → direct merge UNCHANGED, but the reason discloses it is unverified', () => {
    const out = refineArmDecisionForCheckAttach(cleanDecision(), null);
    expect(out.action).toBe('merge');
    expect(out.reason).toMatch(/NOT verified/);
    expect(out.reason).toMatch(/the host's word alone/);
  });

  it('is a strict IDENTITY on every non-merge decision — the fix must not turn arms/refusals into anything else', () => {
    const forbidding = compareRequiredToReported([VITEST_CHECK], []);
    for (const m of ['blocked', 'unstable', 'behind', 'unknown', 'dirty', 'draft'] as PrMergeability[]) {
      const before = decideArmAction(m);
      expect(refineArmDecisionForCheckAttach(before, forbidding)).toBe(before);
      expect(refineArmDecisionForCheckAttach(before, null)).toBe(before);
    }
  });
});

describe('asCheckAttachReader (the optional capability probe)', () => {
  it('a plain LandingHost is NOT a reader — an existing adapter keeps working unchanged', () => {
    expect(asCheckAttachReader(fakeLandingHost({ status: openPr('clean') }).host)).toBeNull();
  });

  it('a host carrying BOTH reads is narrowed to a reader', () => {
    const { host } = fakeAttachAwareHost({ status: freshCleanPr(), required: requiredAbsent() });
    expect(asCheckAttachReader(host)).not.toBeNull();
  });

  it('a host carrying only ONE of the two reads is NOT a reader (no half-answered comparison)', () => {
    const { host } = fakeLandingHost({ status: openPr('clean') });
    (host as LandingHost & Partial<CheckAttachReader>).getReportedChecks = async () => [];
    expect(asCheckAttachReader(host)).toBeNull();
  });
});

describe('armPullRequest — the check-attach gate (AC1/AC2, 2026-07-30 live occurrences)', () => {
  it('AC1: the FRESH-PR shape — required checks configured, ZERO reported for the head — ARMS, never direct-merges', async () => {
    // This is occurrence 1 and occurrence 2, reproduced: mergeability `clean` on a
    // PR whose two ruleset-required checks have not attached to the head commit.
    // Pre-fix this answered `merged` with "PR is clean — no pending required checks".
    const { host, calls } = fakeAttachAwareHost({
      status: freshCleanPr(),
      required: requiredPresent(VITEST_CHECK, TSC_CHECK),
      reported: [], // the check-attach latency window
    });
    const out = await armPullRequest(host, 'wave/fresh-pr');
    expect(out).toMatchObject({ outcome: 'armed', prNumber: 42 });
    // NEVER a direct merge — the single most important assertion in this file.
    expect(calls).not.toContain('mergePullRequest:42:squash');
    expect(calls).toEqual([
      'getPrStatus:wave/fresh-pr',
      'getRequiredChecks:main',
      'getReportedChecks:c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ffee',
      'enableAutoMerge:42:squash',
    ]);
    expect((out as { reason: string }).reason).toMatch(/not "all required checks passed"/i);
  });

  it('AC1: a PARTIAL attach (one of the two reported green) still arms — every required check must have reported', async () => {
    const { host, calls } = fakeAttachAwareHost({
      status: freshCleanPr(),
      required: requiredPresent(VITEST_CHECK, TSC_CHECK),
      reported: [green(VITEST_CHECK)],
    });
    expect(await armPullRequest(host, 'b')).toMatchObject({ outcome: 'armed' });
    expect(calls).not.toContain('mergePullRequest:42:squash');
  });

  it('AC2: ALL required checks reported green → direct merge, UNCHANGED (the fix must not arm every landing)', async () => {
    const { host, calls } = fakeAttachAwareHost({
      status: freshCleanPr(),
      required: requiredPresent(VITEST_CHECK, TSC_CHECK),
      reported: [green(VITEST_CHECK), green(TSC_CHECK)],
    });
    const out = await armPullRequest(host, 'b');
    expect(out).toMatchObject({ outcome: 'merged', prNumber: 42, sha: 'deadbeef' });
    expect(calls).not.toContain('enableAutoMerge:42:squash');
    expect(calls).toContain('mergePullRequest:42:squash');
    // And the direct merge is now EVIDENCED, which is what occurrence 2 lacked.
    expect((out as { reason: string }).reason).toMatch(/Verified: all 2 required check\(s\) have reported success/);
  });

  it('AC2: NO required checks configured → direct merge, and the reports are never even asked for', async () => {
    const { host, calls } = fakeAttachAwareHost({
      status: freshCleanPr(),
      required: requiredAbsent(),
    });
    const out = await armPullRequest(host, 'b');
    expect(out).toMatchObject({ outcome: 'merged', prNumber: 42 });
    expect(calls).toEqual(['getPrStatus:b', 'getRequiredChecks:main', 'mergePullRequest:42:squash']);
    expect((out as { reason: string }).reason).toMatch(/require NO status checks/i);
  });

  it('AC2: a host that cannot answer the attach question behaves EXACTLY as before (unchanged direct merge)', async () => {
    const { host, calls } = fakeLandingHost({ status: openPr('clean') });
    const out = await armPullRequest(host, 'b');
    expect(out).toMatchObject({ outcome: 'merged', prNumber: 42 });
    expect(calls).toEqual(['getPrStatus:b', 'mergePullRequest:42:squash']);
    expect((out as { reason: string }).reason).toMatch(/NOT verified/);
  });

  it('a BLIND required-checks read (state unknown) never becomes "nothing is required" — merge unchanged, reports not asked for', async () => {
    const { host, calls } = fakeAttachAwareHost({
      status: freshCleanPr(),
      required: requiredUnknown(),
      reported: [], // would forbid the merge if `unknown` were read as `absent`
    });
    expect(await armPullRequest(host, 'b')).toMatchObject({ outcome: 'merged' });
    expect(calls).toEqual(['getPrStatus:b', 'getRequiredChecks:main', 'mergePullRequest:42:squash']);
  });

  it('a FAILED reports read cannot counterfeit "nothing has attached" — it is no evidence, so the merge is unchanged', async () => {
    const { host, calls } = fakeAttachAwareHost({
      status: freshCleanPr(),
      required: requiredPresent(VITEST_CHECK),
      reportedThrows: 'HTTP 502 from the check-runs read',
    });
    const out = await armPullRequest(host, 'b');
    expect(out).toMatchObject({ outcome: 'merged' });
    expect((out as { reason: string }).reason).toMatch(/NOT verified/);
    expect(calls).toContain('mergePullRequest:42:squash');
  });

  it('a FAILED required-checks read is likewise no evidence (never a refusal, never an arm)', async () => {
    const { host } = fakeAttachAwareHost({
      status: freshCleanPr(),
      required: requiredPresent(VITEST_CHECK),
      requiredThrows: 'HTTP 500 from the effective-rules read',
    });
    expect(await armPullRequest(host, 'b')).toMatchObject({ outcome: 'merged' });
  });

  it('falls back to the documented `heads/<branch>` ref form when the host reports no head SHA', async () => {
    const { host, calls } = fakeAttachAwareHost({
      status: { state: 'open', number: 42, mergeability: 'clean', baseRef: 'main' },
      required: requiredPresent(VITEST_CHECK),
      reported: [green(VITEST_CHECK)],
    });
    await armPullRequest(host, 'wave/256-arm-check-attach');
    expect(calls).toContain('getReportedChecks:heads/wave/256-arm-check-attach');
  });

  it('with no reported baseRef the required-checks read falls back to the default branch (no arg)', async () => {
    const { host, calls } = fakeAttachAwareHost({
      status: { state: 'open', number: 42, mergeability: 'clean', headSha: 'abc' },
      required: requiredPresent(VITEST_CHECK),
      reported: [green(VITEST_CHECK)],
    });
    await armPullRequest(host, 'b');
    expect(calls).toContain('getRequiredChecks:');
  });

  it('a BLOCKED PR arms without paying for the attach read at all (the fast path is untouched)', async () => {
    const { host, calls } = fakeAttachAwareHost({
      status: openPr('blocked'),
      required: requiredPresent(VITEST_CHECK),
    });
    expect(await armPullRequest(host, 'b')).toMatchObject({ outcome: 'armed' });
    expect(calls).toEqual(['getPrStatus:b', 'enableAutoMerge:42:squash']);
  });

  it('the attach evidence is read ONCE and shared across the legs that could merge', async () => {
    const { host, calls } = fakeAttachAwareHost({
      status: freshCleanPr(),
      required: requiredPresent(VITEST_CHECK),
      reported: [green(VITEST_CHECK)],
      onEnableAutoMerge: () => {
        throw new AutoMergeUnavailableError('clean-status', 'Pull request is in clean status');
      },
    });
    await armPullRequest(host, 'b');
    expect(calls.filter((c) => c.startsWith('getRequiredChecks'))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith('getReportedChecks'))).toHaveLength(1);
  });

  it('AC1: the SPIKE-2 clean-status recovery cannot undo the gate — it REFUSES, it does not merge', async () => {
    // Without this leg the fix would be cosmetic: the refined decision arms, the
    // host rejects the arm as "clean status" (it genuinely believes the PR is
    // clean — that is the defect), and the recovery would merge it anyway.
    const { host, calls } = fakeAttachAwareHost({
      status: freshCleanPr(),
      required: requiredPresent(VITEST_CHECK, TSC_CHECK),
      reported: [],
      onEnableAutoMerge: () => {
        throw new AutoMergeUnavailableError('clean-status', 'Pull request is in clean status');
      },
    });
    const out = await armPullRequest(host, 'b');
    expect(out).toMatchObject({ outcome: 'refused', prNumber: 42 });
    expect(calls).not.toContain('mergePullRequest:42:squash');
    expect((out as { reason: string }).reason).toMatch(/not\s+"all required checks passed"/i);
    expect((out as { reason: string }).reason).toMatch(/Re-run `host-pr arm`/);
  });

  it('the clean-status recovery still merges when the attach evidence CONFIRMS all required checks passed', async () => {
    const { host, calls } = fakeAttachAwareHost({
      status: openPr('unknown'),
      required: requiredPresent(VITEST_CHECK),
      reported: [green(VITEST_CHECK)],
      onEnableAutoMerge: () => {
        throw new AutoMergeUnavailableError('clean-status', 'Pull request is in clean status');
      },
    });
    expect(await armPullRequest(host, 'b', DEFAULT_MERGE_METHOD, { sleep: instantSleep })).toMatchObject({
      outcome: 'merged',
    });
    expect(calls).toContain('mergePullRequest:42:squash');
  });

  it('AC1: the not-allowed controlled degrade cannot merge past unattached required checks either', async () => {
    const { host, calls } = fakeAttachAwareHost({
      status: freshCleanPr(),
      required: requiredPresent(VITEST_CHECK, TSC_CHECK),
      reported: [],
      onEnableAutoMerge: () => {
        throw new AutoMergeUnavailableError('not-allowed', 'Auto merge is not allowed for this repository');
      },
    });
    const out = await armPullRequest(host, 'b');
    expect(out).toMatchObject({ outcome: 'refused' });
    expect(calls).not.toContain('mergePullRequest:42:squash');
    expect((out as { reason: string }).reason).toMatch(/Allow auto-merge/i);
    expect((out as { reason: string }).reason).toMatch(/not\s+"all required checks passed"/i);
  });

  it('the not-allowed controlled degrade still merges when the attach evidence confirms the checks passed', async () => {
    const { host, calls } = fakeAttachAwareHost({
      status: openPr('unstable'),
      required: requiredPresent(VITEST_CHECK),
      reported: [green(VITEST_CHECK)],
      onEnableAutoMerge: () => {
        throw new AutoMergeUnavailableError('not-allowed', 'The repository does not permit auto-merge');
      },
    });
    expect(await armPullRequest(host, 'b')).toMatchObject({ outcome: 'merged' });
    expect(calls).toContain('mergePullRequest:42:squash');
  });

  // ── the refusal PROSE is host-aware (the remedy, never the decision) ───────
  //
  // `RealBitbucketApi.enableAutoMerge` raises the SAME typed `not-allowed`
  // refusal GitHub raises for "Allow auto-merge is off" — but for a structurally
  // different reason, and Bitbucket has no such setting to tick. Teaching
  // GitHub's remedy there would send an operator hunting for a control that does
  // not exist, on this host's DOMINANT landing outcome: every row whose required
  // build is still pending lands on exactly these two legs.

  describe('the not-allowed refusal remedy is host-aware', () => {
    const notAllowed = () => {
      throw new AutoMergeUnavailableError('not-allowed', 'Auto merge is not allowed for this repository');
    };

    it('BOTH not-allowed refusal sites drop GitHub\'s settings remedy on bitbucket and name the real one', async () => {
      // Site 1 — the required-pending refusal (no CheckAttachReader involved).
      const pending = fakeLandingHost({ status: openPr('blocked'), onEnableAutoMerge: notAllowed });
      // Site 2 — the check-attach gate refusal.
      const attach = fakeAttachAwareHost({
        status: freshCleanPr(),
        required: requiredPresent(VITEST_CHECK, TSC_CHECK),
        reported: [],
        onEnableAutoMerge: notAllowed,
      });

      for (const { host } of [pending, attach]) {
        const out = await armPullRequest(host, 'b', DEFAULT_MERGE_METHOD, { host: 'bitbucket' });
        expect(out).toMatchObject({ outcome: 'refused' });
        const reason = (out as { reason: string }).reason;
        // The GitHub-only remedy must be gone — both the control and the path.
        expect(reason).not.toMatch(/Settings → General/);
        expect(reason).not.toMatch(/Enable "Allow auto-merge"/);
        // …and replaced by the measured account plus a remedy that exists.
        expect(reason).toMatch(/no per-pull-request auto-merge arming primitive/i);
        expect(reason).toMatch(/merge-order/);
        expect(reason).toMatch(/Allow automatic merge when builds pass/);
        // The host's own message is still carried verbatim for the operator.
        expect(reason).toMatch(/Auto merge is not allowed for this repository/);
      }
    });

    it('omitting the host option keeps the shipped GitHub prose byte-identical (the change is additive)', async () => {
      // The seam carries no host tag, so an injected double and every
      // pre-existing caller must land on exactly the text they always had.
      for (const host of ['github', undefined] as const) {
        const { host: h } = fakeLandingHost({ status: openPr('blocked'), onEnableAutoMerge: notAllowed });
        const out = await armPullRequest(h, 'b', DEFAULT_MERGE_METHOD, host === undefined ? {} : { host });
        expect((out as { reason: string }).reason).toBe(
          'The repository does not permit auto-merge, so this PR cannot be armed. Enable "Allow auto-merge" ' +
            '(Settings → General → Pull Requests) and re-run, or land this row via the advisory merge-order. ' +
            '[Auto merge is not allowed for this repository]',
        );
      }
    });

    it('the host option changes PROSE only — the decision on both hosts is the identical refusal', async () => {
      const calls: string[][] = [];
      for (const h of ['github', 'bitbucket'] as const) {
        const { host, calls: c } = fakeLandingHost({ status: openPr('blocked'), onEnableAutoMerge: notAllowed });
        const out = await armPullRequest(host, 'b', DEFAULT_MERGE_METHOD, { host: h });
        expect(out).toMatchObject({ outcome: 'refused', prNumber: 42 });
        expect(c).not.toContain('mergePullRequest:42:squash');
        calls.push(c);
      }
      expect(calls[0]).toEqual(calls[1]);
    });
  });

  it('--delete-branch on an arm that the gate turned into an ARM defers the deletion (no synchronous merge to delete after)', async () => {
    const { host, calls } = fakeAttachAwareHost({
      status: freshCleanPr(),
      required: requiredPresent(VITEST_CHECK),
      reported: [],
    });
    const out = await armPullRequest(host, 'b', DEFAULT_MERGE_METHOD, { deleteBranch: true });
    expect(out).toMatchObject({ outcome: 'armed' });
    expect(calls).not.toContain('deleteBranch:b');
    expect((out as { reason: string }).reason).toMatch(/deferred/i);
  });

  it('--delete-branch on a VERIFIED direct merge still deletes the branch (KW-F6 parity is preserved)', async () => {
    const { host, calls } = fakeAttachAwareHost({
      status: freshCleanPr(),
      required: requiredPresent(VITEST_CHECK),
      reported: [green(VITEST_CHECK)],
    });
    const out = await armPullRequest(host, 'wave/x', DEFAULT_MERGE_METHOD, { deleteBranch: true });
    expect(out).toMatchObject({ outcome: 'merged', branchDeletion: { branch: 'wave/x', deleted: true } });
    expect(calls).toContain('deleteBranch:wave/x');
  });

  it('an already-merged PR still short-circuits with no attach read and no writes (idempotency preserved)', async () => {
    const { host, calls } = fakeAttachAwareHost({
      status: { state: 'merged', number: 42, url: 'u' },
      required: requiredPresent(VITEST_CHECK),
    });
    expect(await armPullRequest(host, 'b')).toMatchObject({ outcome: 'already-merged' });
    expect(calls).toEqual(['getPrStatus:b']);
  });

  it('CONVENTION 11 — the fresh-PR shape demonstrated FAILING against the pre-fix decision', async () => {
    // The pre-fix arm consulted `decideArmAction(mergeability)` and NOTHING else.
    // Fed the fresh-PR shape, that decision is the defect, verbatim: it picks the
    // direct merge and its reason asserts "no pending required checks" about a PR
    // whose required checks have reported nothing at all.
    const attach = compareRequiredToReported([VITEST_CHECK, TSC_CHECK], []);
    const preFix = decideArmAction(freshCleanPr().mergeability as PrMergeability);
    expect(preFix.action).toBe('merge');
    expect(preFix.reason).toMatch(/no pending required checks/);
    // …and the evidence available at that very moment contradicts it.
    expect(attach.attached).toBe(false);
    expect(attach.unreported).toEqual([VITEST_CHECK, TSC_CHECK]);
    // The post-fix pipeline reads the same two inputs and answers differently.
    expect(refineArmDecisionForCheckAttach(preFix, attach).action).toBe('enable-auto-merge');
    // End to end, on the same shape: armed, and no merge call was ever issued.
    const { host, calls } = fakeAttachAwareHost({
      status: freshCleanPr(),
      required: requiredPresent(VITEST_CHECK, TSC_CHECK),
      reported: [],
    });
    expect(await armPullRequest(host, 'b')).toMatchObject({ outcome: 'armed' });
    expect(calls.some((c) => c.startsWith('mergePullRequest'))).toBe(false);
  });
});

describe('LandingNotImplementedError', () => {
  it('is typed with a stable code + names the host', () => {
    const err = new LandingNotImplementedError('bitbucket');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('adapter-not-implemented');
    expect(err.host).toBe('bitbucket');
    expect(err.message).toMatch(/bitbucket/);
  });

  it('a NAMED host is told an adapter can be written for it', () => {
    expect(new LandingNotImplementedError('bitbucket').message).toMatch(/LandingHost/);
  });

  it('an UNKNOWN host is told the remote was unparseable — not to "write an unknown adapter"', () => {
    const err = new LandingNotImplementedError('unknown');
    expect(err.code).toBe('adapter-not-implemented');
    // The actionable fact for an unrecognised remote is that the REMOTE could
    // not be identified; advising "implement a LandingHost for 'unknown'" is
    // nonsense (and reads as broken English).
    expect(err.message).toMatch(/remote/i);
    expect(err.message).not.toMatch(/A unknown/);
  });

  it('names BOTH shipped adapters — the message is the currency check on which hosts work', () => {
    // Currency, not cosmetics: this sentence is what an operator reads when a
    // remote is unrecognised, and it told them 'github' only for as long as
    // that was true. A message that still said so would send a Bitbucket pilot
    // looking for a workaround that no longer exists.
    for (const host of ['unknown', 'bitbucket'] as const) {
      const message = new LandingNotImplementedError(host).message;
      expect(message).toMatch(/'github' and 'bitbucket'/);
      expect(message).not.toMatch(/'github' only/);
      expect(message).not.toMatch(/supports 'github';/);
    }
  });
});

// ─── mergeRequiredChecks (ruleset-vs-legacy reconciliation) ──────────────────
//
// The single owner of the effective-rules + legacy branch-protection merge
// (2026-07-23 gate-arm gap). A pure total function — no seam, no network.

const legacy = (over: Partial<RequiredChecksInfo> = {}): RequiredChecksInfo => ({
  state: 'absent',
  contexts: [],
  detail: 'legacy',
  ...over,
});
const ruleset = (over: Partial<RulesetChecksInfo> = {}): RulesetChecksInfo => ({
  readable: false,
  contexts: [],
  detail: 'ruleset',
  ...over,
});

describe('mergeRequiredChecks (effective-rules + legacy reconciliation)', () => {
  it('checks found ONLY in the ruleset (legacy 403/unknown) → present, names them — the AC2 admin-403 fix', async () => {
    const merged = mergeRequiredChecks(
      'main',
      legacy({ state: 'unknown' }), // legacy branch-protection 403'd
      ruleset({ readable: true, contexts: ['Engine Tests (vitest)', 'Engine Typecheck (tsc)'] }),
    );
    expect(merged.state).toBe('present');
    expect(merged.contexts).toEqual(['Engine Tests (vitest)', 'Engine Typecheck (tsc)']);
    expect(merged.detail).toContain('Engine Tests (vitest)');
  });

  it('checks found ONLY in legacy (rules read blind) → present — either source counts (AC3 defensive)', () => {
    const merged = mergeRequiredChecks('main', legacy({ state: 'present', contexts: ['ci/test'] }), ruleset());
    expect(merged.state).toBe('present');
    expect(merged.contexts).toEqual(['ci/test']);
  });

  it('the union is DE-DUPLICATED when both sources carry the same context (rules aggregates classic protection)', () => {
    const merged = mergeRequiredChecks(
      'main',
      legacy({ state: 'present', contexts: ['ci/test'] }),
      ruleset({ readable: true, contexts: ['ci/test'] }),
    );
    expect(merged.contexts).toEqual(['ci/test']);
  });

  it('no checks, but a READABLE rules answer → absent (a non-admin token reaches absent, not unknown)', () => {
    const merged = mergeRequiredChecks('main', legacy({ state: 'unknown' }), ruleset({ readable: true, contexts: [] }));
    expect(merged.state).toBe('absent');
  });

  it('no checks, legacy authoritative-absent, rules blind → absent', () => {
    const merged = mergeRequiredChecks('main', legacy({ state: 'absent' }), ruleset({ readable: false }));
    expect(merged.state).toBe('absent');
  });

  it('BOTH reads blind (legacy unknown + rules unreadable) → unknown (the residual advisory case)', () => {
    const merged = mergeRequiredChecks('main', legacy({ state: 'unknown' }), ruleset({ readable: false }));
    expect(merged.state).toBe('unknown');
  });
});

// ─── preflightHost (ADR-0023 amendment — code-host posture probe) ─────────────
//
// The pure GRADING matrix, driven by a fake LandingPosture (no network, no
// GitHub adapter). The CLI wiring (detect-host routing, $GITHUB_TOKEN build,
// store-blindness) is host-pr-cli.spec.ts's job; this covers what each posture
// grades to.

const REQUIRED_PRESENT: RequiredChecksInfo = {
  state: 'present',
  contexts: ['ci/test', 'ci/lint'],
  detail: 'Branch requires 2 checks.',
};
const REQUIRED_ABSENT: RequiredChecksInfo = {
  state: 'absent',
  contexts: [],
  detail: 'Branch has no required status checks.',
};
const REQUIRED_UNKNOWN: RequiredChecksInfo = {
  state: 'unknown',
  contexts: [],
  detail: 'Could not read branch protection — needs admin (HTTP 403). Advisory only.',
};

function fakePosture(opts: {
  canMerge?: boolean;
  autoMerge?: AutoMergeSetting;
  required?: RequiredChecksInfo;
  onGetRequiredChecks?: (branch?: string) => void;
}): LandingPosture {
  return {
    async canMergePullRequests() {
      return opts.canMerge ?? true;
    },
    async getAutoMergeSetting() {
      return opts.autoMerge ?? 'on';
    },
    async getRequiredChecks(branch?: string) {
      opts.onGetRequiredChecks?.(branch);
      return opts.required ?? REQUIRED_ABSENT;
    },
  };
}

const byName = (checks: { name: string; status: string; detail: string }[]) =>
  Object.fromEntries(checks.map((c) => [c.name, c]));

/**
 * `preflightHost` with an EXPLICIT environment on every call — empty unless a
 * test says otherwise. Not sugar: the report now carries an ambient-credential
 * check alongside the three posture reads, and `preflightHost`'s own default is
 * `process.env`, so a two-argument call in a spec would let the machine running
 * the suite decide the answer. Every assertion in this file grades an injected
 * environment; none reads the real one, and none resolves a credential.
 */
const preflight = (host: Host, posture: LandingPosture, env: NodeJS.ProcessEnv = {}) =>
  preflightHost(host, posture, env);

describe('preflightHost (ADR-0023 amendment posture grading)', () => {
  it('reports exactly the three code-host checks and echoes the host', async () => {
    const report = await preflight('github', fakePosture({ autoMerge: 'on', required: REQUIRED_ABSENT }));
    expect(report.host).toBe('github');
    expect(report.checks.map((c) => c.name)).toEqual(['pr-merge-token', 'allow-auto-merge', 'required-checks']);
  });

  it('reads required-checks against the DEFAULT branch (no branch argument)', async () => {
    let seen: string | undefined | 'UNCALLED' = 'UNCALLED';
    await preflight('github', fakePosture({ onGetRequiredChecks: (b) => (seen = b) }));
    expect(seen).toBeUndefined(); // called with no arg → the default branch
  });

  describe('pr-merge-token', () => {
    it('pass when the token can merge', async () => {
      const report = await preflight('github', fakePosture({ canMerge: true }));
      expect(byName(report.checks)['pr-merge-token'].status).toBe('pass');
    });

    it('FAIL (ok:false) with a write-access instruction when it cannot', async () => {
      const report = await preflight('github', fakePosture({ canMerge: false }));
      const c = byName(report.checks)['pr-merge-token'];
      expect(c.status).toBe('fail');
      expect(c.detail).toMatch(/write/i);
      expect(report.ok).toBe(false);
    });

    // ADR-0029: after the lookup-command indirection the credential is usually
    // NOT an ambient variable, so a posture text calling it "ambient" would be
    // simply false. It still names the VARIABLE — that is the operator's handle
    // on it, whichever of the two paths supplied it.
    it('never describes the token as "ambient" (ADR-0029), on either verdict', async () => {
      for (const canMerge of [true, false]) {
        const report = await preflight('github', fakePosture({ canMerge }));
        const c = byName(report.checks)['pr-merge-token'];
        expect(c.detail).not.toMatch(/ambient/i);
        expect(c.detail).toContain('GITHUB_TOKEN');
      }
    });
  });

  describe('allow-auto-merge', () => {
    it('ON → pass', async () => {
      const report = await preflight('github', fakePosture({ autoMerge: 'on', required: REQUIRED_PRESENT }));
      expect(byName(report.checks)['allow-auto-merge'].status).toBe('pass');
      expect(report.ok).toBe(true);
    });

    it('a visible OFF with required checks present → FAIL (ok:false) + the fix instruction', async () => {
      const report = await preflight('github', fakePosture({ autoMerge: 'off', required: REQUIRED_PRESENT }));
      const c = byName(report.checks)['allow-auto-merge'];
      expect(c.status).toBe('fail');
      expect(c.detail).toMatch(/Settings/);
      expect(c.detail).toMatch(/auto-merge/i);
      expect(report.ok).toBe(false); // structurally impossible to arm those rows
    });

    it('a visible OFF with NO required checks → advisory (a clean PR direct-merges today), never blocks', async () => {
      const report = await preflight('github', fakePosture({ autoMerge: 'off', required: REQUIRED_ABSENT }));
      const c = byName(report.checks)['allow-auto-merge'];
      expect(c.status).toBe('advisory');
      expect(report.ok).toBe(true);
    });

    it('UNKNOWN (the token cannot see it) → unknown, never blocks, detail carries the manual-verify/permission fix and demands no admin', async () => {
      const report = await preflight('github', fakePosture({ autoMerge: 'unknown', required: REQUIRED_PRESENT }));
      const c = byName(report.checks)['allow-auto-merge'];
      expect(c.status).toBe('unknown');
      expect(report.ok).toBe(true); // absence of evidence is not a finding
      expect(c.detail).toMatch(/maintain\/admin|cannot see/i);
      expect(c.detail).toMatch(/no admin|needs no admin/i);
      expect(c.detail).toMatch(/Settings|verify by hand/i);
    });
  });

  describe('required-checks', () => {
    it('present → advisory, names the contexts, and says --auto will ARM', async () => {
      const report = await preflight('github', fakePosture({ required: REQUIRED_PRESENT }));
      const c = byName(report.checks)['required-checks'];
      expect(c.status).toBe('advisory');
      expect(c.detail).toContain('ci/test');
      expect(c.detail).toMatch(/ARM/);
    });

    it('absent → advisory, states that confirming means an IMMEDIATE merge', async () => {
      const report = await preflight('github', fakePosture({ required: REQUIRED_ABSENT }));
      const c = byName(report.checks)['required-checks'];
      expect(c.status).toBe('advisory');
      expect(c.detail).toMatch(/immediate/i);
    });

    it('unknown → unknown (report-only), never blocks', async () => {
      const report = await preflight('github', fakePosture({ required: REQUIRED_UNKNOWN }));
      expect(byName(report.checks)['required-checks'].status).toBe('unknown');
      expect(report.ok).toBe(true);
    });
  });

  it('NO posture detail anywhere calls the credential "ambient" (ADR-0029), across the whole grading matrix', async () => {
    // Every combination the grader can emit — one sweep, so a future detail
    // string cannot quietly re-introduce the word on a path nobody spot-checks.
    for (const canMerge of [true, false]) {
      for (const autoMerge of ['on', 'off', 'unknown'] as AutoMergeSetting[]) {
        for (const required of [REQUIRED_PRESENT, REQUIRED_ABSENT, REQUIRED_UNKNOWN]) {
          const report = await preflight('github', fakePosture({ canMerge, autoMerge, required }));
          for (const check of report.checks) {
            expect(check.detail).not.toMatch(/ambient/i);
          }
        }
      }
    }
  });

  it('unknown + advisory NEVER drag ok to false — only a fail blocks', async () => {
    const report = await preflight(
      'github',
      fakePosture({ canMerge: true, autoMerge: 'unknown', required: REQUIRED_UNKNOWN }),
    );
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.status).sort()).toEqual(['pass', 'unknown', 'unknown']);
  });

  // ─── the same grading, on bitbucket ────────────────────────────────────
  //
  // The three reads are host-neutral in SHAPE and not in MEANING, so the
  // grader is host-aware. What must hold on this host: nothing about the
  // absence of an arming primitive is ever a hard `fail` (it is a platform
  // property, not a misconfiguration), and no detail promises an arm.

  describe('bitbucket grading', () => {
    it('an OFF auto-merge setting is ADVISORY here, where the same value is a hard fail on github', async () => {
      const posture = fakePosture({ canMerge: true, autoMerge: 'off', required: REQUIRED_PRESENT });
      const bb = await preflight('bitbucket', posture);
      const gh = await preflight('github', posture);

      expect(byName(bb.checks)['allow-auto-merge'].status).toBe('advisory');
      expect(bb.ok).toBe(true);
      // The contrast is the assertion: identical posture, different verdict,
      // because only one of the two hosts has a setting that could be ticked.
      expect(byName(gh.checks)['allow-auto-merge'].status).toBe('fail');
      expect(gh.ok).toBe(false);
    });

    it('the bitbucket auto-merge detail states the MEASUREMENT and what --auto does instead', async () => {
      const report = await preflight('bitbucket', fakePosture({ autoMerge: 'off' }));
      const detail = byName(report.checks)['allow-auto-merge'].detail;
      expect(detail).toMatch(/no per-pull-request auto-merge arming primitive/i);
      expect(detail).toMatch(/merge check/i);
      expect(detail).toMatch(/DIRECT MERGE/);
      expect(detail).toMatch(/merge-order/);
      // It must NOT hand a Bitbucket operator GitHub's fix instruction.
      expect(detail).not.toMatch(/Settings → General/);
    });

    // The posture READ is real now (the adapter reads the
    // `allow_auto_merge_when_builds_pass` branch restriction), so the three
    // answers must be told apart in the report — while none of them may promise
    // an arm, because none of them changes what the engine can call.
    it('the three read answers are reported APART, and each names the branch restriction it came from', async () => {
      const on = byName((await preflight('bitbucket', fakePosture({ autoMerge: 'on' }))).checks)['allow-auto-merge'];
      const off = byName((await preflight('bitbucket', fakePosture({ autoMerge: 'off' }))).checks)['allow-auto-merge'];
      const unk = byName((await preflight('bitbucket', fakePosture({ autoMerge: 'unknown' }))).checks)['allow-auto-merge'];

      expect(on.detail).toMatch(/HAS Bitbucket's "Allow automatic merge when builds pass"/);
      expect(off.detail).toMatch(/does NOT have Bitbucket's "Allow automatic merge when builds pass"/);
      expect(unk.detail).toMatch(/[Cc]ould not read/);
      for (const c of [on, off, unk]) {
        expect(c.detail).toMatch(/allow_auto_merge_when_builds_pass/);
        // Whatever the value, the arming conclusion is identical and no detail
        // may promise the engine can arm.
        expect(c.detail).toMatch(/no per-pull-request auto-merge arming primitive/i);
      }
      // `on` must not read as "flotilla can arm now".
      expect(on.detail).toMatch(/NOT an arming API/);
    });

    it('NO value of the setting is ever a `fail` here — the arming gap is structural, not a misconfiguration', async () => {
      for (const autoMerge of ['on', 'off', 'unknown'] as AutoMergeSetting[]) {
        for (const required of [REQUIRED_PRESENT, REQUIRED_ABSENT, REQUIRED_UNKNOWN]) {
          const check = byName(
            (await preflight('bitbucket', fakePosture({ canMerge: true, autoMerge, required }))).checks,
          )['allow-auto-merge'];
          expect(check.status).not.toBe('fail');
          // `unknown` keeps its real meaning: a read that failed, nothing else.
          expect(check.status).toBe(autoMerge === 'unknown' ? 'unknown' : 'advisory');
        }
      }
    });

    it('required-checks present does NOT promise an arm on bitbucket (the github sentence would be false here)', async () => {
      const bbDetail = byName(
        (await preflight('bitbucket', fakePosture({ required: REQUIRED_PRESENT }))).checks,
      )['required-checks'].detail;
      const ghDetail = byName(
        (await preflight('github', fakePosture({ required: REQUIRED_PRESENT }))).checks,
      )['required-checks'].detail;

      expect(ghDetail).toMatch(/will ARM these PRs/);
      expect(bbDetail).toMatch(/will NOT arm these PRs/);
      expect(bbDetail).toMatch(/REFUSED/);
    });

    it('the pr-merge-token detail names BITBUCKET_TOKEN, and its pass discloses that a blind read is not proof', async () => {
      const pass = byName((await preflight('bitbucket', fakePosture({ canMerge: true }))).checks)['pr-merge-token'];
      expect(pass.status).toBe('pass');
      expect(pass.detail).toMatch(/BITBUCKET_TOKEN/);
      expect(pass.detail).not.toMatch(/GITHUB_TOKEN/);
      // Absence of evidence is disclosed, never dressed up as a proven grant.
      expect(pass.detail).toMatch(/absence of evidence/i);

      const fail = byName((await preflight('bitbucket', fakePosture({ canMerge: false }))).checks)['pr-merge-token'];
      expect(fail.status).toBe('fail');
      expect(fail.detail).toMatch(/write:repository:bitbucket/);
    });

    it('a read-only credential is the ONLY bitbucket posture that blocks', async () => {
      for (const autoMerge of ['on', 'off', 'unknown'] as AutoMergeSetting[]) {
        for (const required of [REQUIRED_PRESENT, REQUIRED_ABSENT, REQUIRED_UNKNOWN]) {
          const ok = await preflight('bitbucket', fakePosture({ canMerge: true, autoMerge, required }));
          expect(ok.ok).toBe(true);
          const blocked = await preflight('bitbucket', fakePosture({ canMerge: false, autoMerge, required }));
          expect(blocked.ok).toBe(false);
        }
      }
    });

    it('the github grading is untouched by the host-aware branches (every github detail is byte-identical to its no-host-argument meaning)', async () => {
      // A regression net for the additive claim: the github texts asserted
      // across this whole describe block still hold, so the bitbucket branches
      // added behaviour rather than rewriting the shipped report.
      const report = await preflight('github', fakePosture({ canMerge: true, autoMerge: 'on', required: REQUIRED_PRESENT }));
      expect(byName(report.checks)['pr-merge-token'].detail).toMatch(/GITHUB_TOKEN/);
      expect(byName(report.checks)['allow-auto-merge'].detail).toMatch(/"Allow auto-merge" is ON/);
      expect(byName(report.checks)['required-checks'].detail).toMatch(/Required: ci\/test, ci\/lint\./);
    });
  });

  // ─── create-credentials (the BITBUCKET_EMAIL advisory) ──────────────────
  //
  // The gap this closes: the email is an OPTIONAL half of the Bitbucket auth
  // header (absent → Bearer, which the LANDING verbs accept), so the adapter
  // constructs, its construction-time preflight passes, and all three posture
  // checks above go green without ever looking at the variable. The refusal
  // lives one verb on, in `host-pr create` — which rides the Worker terminator,
  // per row, after dispatch. This check states it BEFORE a row burns.
  //
  // Two things are settled and asserted as settled: the grade is `advisory`
  // (a land-only consumer has a healthy posture and must not be refused), and
  // the DETAIL — not the status — is what has to carry the consequence.

  describe('create-credentials (the BITBUCKET_EMAIL advisory)', () => {
    const NO_EMAIL: NodeJS.ProcessEnv = {};
    const WITH_EMAIL: NodeJS.ProcessEnv = { [BITBUCKET_EMAIL_VAR]: 'wave-fixture@example.test' };
    const CREATE_CREDENTIALS = 'create-credentials';

    /** The report's create-credentials check, or `undefined` when it is omitted. */
    const check = async (host: Host, env: NodeJS.ProcessEnv) =>
      (await preflight(host, fakePosture({ canMerge: true }), env)).checks.find(
        (c) => c.name === CREATE_CREDENTIALS,
      );

    it('bitbucket + the variable UNSET → advisory, and ok stays TRUE', async () => {
      const report = await preflight('bitbucket', fakePosture({ canMerge: true }), NO_EMAIL);
      const c = byName(report.checks)[CREATE_CREDENTIALS];
      expect(c.status).toBe('advisory');
      // The settled grade, asserted as an invariant and not as a coincidence:
      // `ok` is "no check is fail", so an advisory may never move it.
      expect(report.ok).toBe(true);
    });

    it('bitbucket + the variable SET → pass', async () => {
      expect((await check('bitbucket', WITH_EMAIL))?.status).toBe('pass');
    });

    it('an EMPTY-STRING value is graded exactly as unset — the rule `create` itself applies', async () => {
      // Not a re-derived convention: `bitbucketCreateCreds` refuses `''` as well
      // as `undefined`, and this check calls that helper rather than re-testing
      // the rule, so the two cannot disagree.
      expect((await check('bitbucket', { [BITBUCKET_EMAIL_VAR]: '' }))?.status).toBe('advisory');
    });

    it('the EMPTY-STRING detail names the empty case truthfully — not just "is not set"', async () => {
      // A reader who DID set the variable (to '') must not be told they did
      // not set it at all. Pins the exact leading-sentence wording so a future
      // edit cannot silently regress back to the absent-only phrasing.
      const detail = (await check('bitbucket', { [BITBUCKET_EMAIL_VAR]: '' }))?.detail ?? '';
      expect(detail).toContain(`${BITBUCKET_EMAIL_VAR} is not set, or is set to an empty string.`);
    });

    it('the advisory detail states BOTH halves — landing unaffected, AND create refuses on every wave row', async () => {
      const detail = (await check('bitbucket', NO_EMAIL))?.detail ?? '';

      // Half one: the landing verbs are fine. Without this a reader concludes
      // the host is broken and stops.
      expect(detail).toMatch(/landing verbs are UNAFFECTED/i);
      expect(detail).toMatch(/arm \| merge \| status \| preflight/);
      expect(detail).toMatch(/Bearer/);

      // Half two: the consequence. `advisory` alone reads as "ignorable" — the
      // detail is the only place a reader learns that a WAVE fails on it.
      expect(detail).toMatch(/host-pr create/);
      expect(detail).toMatch(/refuse/i);
      expect(detail).toMatch(/Worker\s+terminator/i);
      expect(detail).toMatch(/EVERY row/i);

      // And the remedy, named where the reader is (an identifier, not a secret
      // — it must not send anyone to the ADR-0029 credential seam).
      expect(detail).toContain(BITBUCKET_EMAIL_VAR);
      expect(detail).toMatch(/not a secret/i);
    });

    it('the advisory QUOTES the refusal `bitbucketCreateCreds` actually throws — one rule, one owner', async () => {
      // The drift guard, and the reason this check calls the create helper
      // instead of re-implementing its precondition: if that refusal text (or
      // the precondition behind it) ever changes, the advisory follows it
      // automatically. A second, parallel copy of the rule would not.
      let refusal: string | undefined;
      try {
        bitbucketCreateCreds('token-fixture-not-a-credential', undefined);
      } catch (err) {
        refusal = (err as Error).message;
      }
      expect(refusal).toBeDefined();

      const detail = (await check('bitbucket', NO_EMAIL))?.detail ?? '';
      expect(detail).toContain(refusal as string);
    });

    it('github NEVER reports it — variable unset AND variable set (no fail, no spurious advisory)', async () => {
      // The chosen host-aware behaviour is OMISSION, not an inert
      // `not-applicable` row: GitHub's create credential is the same token
      // `pr-merge-token` already grades, so a row here would be one fact under
      // two names — and omission keeps the shipped GitHub report byte-identical.
      for (const env of [NO_EMAIL, WITH_EMAIL]) {
        const report = await preflight('github', fakePosture({ canMerge: true }), env);
        expect(report.checks.map((c) => c.name)).toEqual([
          'pr-merge-token',
          'allow-auto-merge',
          'required-checks',
        ]);
        expect(report.checks.find((c) => c.name === CREATE_CREDENTIALS)).toBeUndefined();
      }
    });

    it('is ADDITIVE: the three posture checks are byte-identical across both hosts and both environments', async () => {
      // AC5, asserted structurally rather than by re-quoting the shipped detail
      // strings: whatever the three posture checks say, the environment cannot
      // change it, and the new check is APPENDED after them.
      const posture = fakePosture({ canMerge: true, autoMerge: 'off', required: REQUIRED_PRESENT });
      for (const host of ['github', 'bitbucket'] as Host[]) {
        const a = await preflight(host, posture, NO_EMAIL);
        const b = await preflight(host, posture, WITH_EMAIL);
        expect(a.checks.slice(0, 3)).toEqual(b.checks.slice(0, 3));
        expect(a.checks.slice(0, 3).map((c) => c.name)).toEqual([
          'pr-merge-token',
          'allow-auto-merge',
          'required-checks',
        ]);
      }
      // …and on GitHub the whole report is identical, not just its first three.
      expect(await preflight('github', posture, NO_EMAIL)).toEqual(
        await preflight('github', posture, WITH_EMAIL),
      );
    });

    it('is never a `fail` on ANY bitbucket posture, and never drags ok down', async () => {
      for (const env of [NO_EMAIL, WITH_EMAIL]) {
        for (const autoMerge of ['on', 'off', 'unknown'] as AutoMergeSetting[]) {
          for (const required of [REQUIRED_PRESENT, REQUIRED_ABSENT, REQUIRED_UNKNOWN]) {
            const report = await preflight(
              'bitbucket',
              fakePosture({ canMerge: true, autoMerge, required }),
              env,
            );
            expect(byName(report.checks)[CREATE_CREDENTIALS].status).not.toBe('fail');
            expect(report.ok).toBe(true);
          }
        }
      }
    });

    it('grades PRESENCE only — the variable value never reaches the report, on either verdict', async () => {
      // The helper this check calls builds a `user:secret` pair. Neither half of
      // it, nor the sentinel token passed in place of a real credential, may
      // appear anywhere in the emitted report.
      for (const env of [NO_EMAIL, WITH_EMAIL]) {
        const report = await preflight('bitbucket', fakePosture({ canMerge: true }), env);
        const serialised = JSON.stringify(report);
        expect(serialised).not.toContain('wave-fixture@example.test');
        expect(serialised).not.toContain('preflight-probe-not-a-credential');
      }
    });
  });
});

// ─── The guard, DRIVEN through the `host-pr create` verb (issue #125 AC3) ────
//
// The specs above assert the predicate; these DRIVE the real verb, from argv to
// exit code, against a live-shaped GitHub list response — the same route the
// exploratory `--title probe --body probe` call took when it overwrote a real
// PR (docs/retros/2026-07-27-plugin-consumer-w1.md, DA-F6).
//
// They live here rather than in host-pr-cli.spec.ts because this row's declared
// Files globs cover host-pr.spec.ts and not that file; the seam under test is
// host-pr.ts's guard either way.

describe('host-pr create — the close-phrase guard, driven end-to-end', () => {
  const GITHUB_REMOTE = 'git@github.com:example-org/example-repo.git';
  const ENV = { GITHUB_TOKEN: 'test-token' } as NodeJS.ProcessEnv;
  const PR_URL = 'https://github.com/example-org/example-repo/pull/4';
  /** The live PR body, exactly as a Worker's terminator would have left it. */
  const LIVE_BODY = 'Worker summary.\n\n## Reviewer verdict\napprove\n\nCloses #4';

  /** A probe that answers the find with ONE open PR carrying `LIVE_BODY`. */
  function livePrProbe(): { http: HttpProbe; requests: HttpRequest[] } {
    const requests: HttpRequest[] = [];
    const http: HttpProbe = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        requests.push(req);
        if (req.method === 'GET') {
          return { status: 200, json: [{ html_url: PR_URL, number: 4, body: LIVE_BODY }] };
        }
        if (req.method === 'PATCH') return { status: 200, json: {} };
        throw new Error(`unexpected ${req.method} — create must never POST when a PR is open`);
      },
    };
    return { http, requests };
  }

  let stdout = '';
  let stderr = '';

  beforeEach(() => {
    stdout = '';
    stderr = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      stdout += String(c);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      stderr += String(c);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const out = (): Record<string, unknown> => JSON.parse(stdout);

  it('a phrase-less reuse is REFUSED — exit 1, outcome reuse-refused, and the live PR is never written', async () => {
    const { http, requests } = livePrProbe();
    const code = await runHostPr(
      ['create', '--branch', 'wave/4-x', '--title', 'probe', '--body', 'probe', '--remote', GITHUB_REMOTE],
      undefined,
      { http, env: ENV },
    );

    expect(code).toBe(1);
    expect(out()).toMatchObject({
      ok: false,
      verb: 'create',
      outcome: 'reuse-refused',
      updated: false,
      url: PR_URL,
    });
    // It says WHY — on stderr and in the payload — naming the phrase at risk.
    expect(stderr).toContain('Closes #4');
    expect(String(out().reason)).toContain('host-pr status');
    // The claim that matters: the find happened, the WRITE did not.
    expect(requests.map((r) => r.method)).toEqual(['GET']);
  });

  it('a PROSE reuse whose keyword sighting is coincidental is REFUSED too — driven, not asserted', async () => {
    // The reviewed bypass, driven through the real CLI against a live PR body:
    // `resolves UTF-8` used to satisfy the matcher, so this body was written.
    const { http, requests } = livePrProbe();
    const code = await runHostPr(
      [
        'create',
        '--branch',
        'wave/4-x',
        '--title',
        'probe',
        '--body',
        'This resolves UTF-8 encoding edge cases in the parser body, no real close phrase here.',
        '--remote',
        GITHUB_REMOTE,
      ],
      undefined,
      { http, env: ENV },
    );

    expect(code).toBe(1);
    expect(out()).toMatchObject({ ok: false, outcome: 'reuse-refused', updated: false, url: PR_URL });
    expect(stderr).toContain('Closes #4');
    expect(requests.map((r) => r.method)).toEqual(['GET']);
  });

  it('a linear-form render (TEAM-N) passes the guard just as the github form does', async () => {
    const requests: HttpRequest[] = [];
    const http: HttpProbe = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        requests.push(req);
        if (req.method === 'GET') {
          return { status: 200, json: [{ html_url: PR_URL, number: 4, body: 'Worker summary.\n\nFixes EX-125' }] };
        }
        return { status: 200, json: {} };
      },
    };
    const composed = 'Re-dispatch summary.\n\n## Reviewer verdict\napprove\n\nFixes EX-125';
    const code = await runHostPr(
      ['create', '--branch', 'wave/4-x', '--title', 'Composed title', '--body', composed, '--remote', GITHUB_REMOTE],
      undefined,
      { http, env: ENV },
    );

    expect(code).toBe(0);
    expect(out()).toMatchObject({ ok: true, outcome: 'reused', updated: true, url: PR_URL });
    expect(requests.map((r) => r.method)).toEqual(['GET', 'PATCH']);
    const patched = requests.find((r) => r.method === 'PATCH');
    expect(JSON.parse(patched?.body ?? '{}')).toEqual({ title: 'Composed title', body: composed });
  });

  it('the same reuse WITH the close phrase passes untouched — exit 0, reused, the composed body PATCHed verbatim', async () => {
    const { http, requests } = livePrProbe();
    const composed = 'Re-dispatch summary.\n\n## Reviewer verdict\napprove\n\nCloses #4';
    const code = await runHostPr(
      ['create', '--branch', 'wave/4-x', '--title', 'Composed title', '--body', composed, '--remote', GITHUB_REMOTE],
      undefined,
      { http, env: ENV },
    );

    expect(code).toBe(0);
    expect(out()).toMatchObject({ ok: true, outcome: 'reused', updated: true, url: PR_URL });
    expect(requests.map((r) => r.method)).toEqual(['GET', 'PATCH']);
    const patched = requests.find((r) => r.method === 'PATCH');
    expect(JSON.parse(patched?.body ?? '{}')).toEqual({ title: 'Composed title', body: composed });
  });

  it('--allow-close-phrase-loss performs the deliberate overwrite — exit 0, reused, PATCH sent', async () => {
    const { http, requests } = livePrProbe();
    const code = await runHostPr(
      [
        'create',
        '--branch',
        'wave/4-x',
        '--title',
        'probe',
        '--body',
        'probe',
        '--allow-close-phrase-loss',
        '--remote',
        GITHUB_REMOTE,
      ],
      undefined,
      { http, env: ENV },
    );

    expect(code).toBe(0);
    expect(out()).toMatchObject({ ok: true, outcome: 'reused', updated: true });
    expect(requests.map((r) => r.method)).toEqual(['GET', 'PATCH']);
  });

  it('a live PR whose body carries NO phrase is still rewritten — the guard adds no new requirement', async () => {
    const requests: HttpRequest[] = [];
    const http: HttpProbe = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        requests.push(req);
        if (req.method === 'GET') return { status: 200, json: [{ html_url: PR_URL, number: 4, body: 'draft' }] };
        return { status: 200, json: {} };
      },
    };
    const code = await runHostPr(
      ['create', '--branch', 'wave/4-x', '--title', 't', '--body', 'still no phrase', '--remote', GITHUB_REMOTE],
      undefined,
      { http, env: ENV },
    );
    expect(code).toBe(0);
    expect(out()).toMatchObject({ outcome: 'reused', updated: true });
    expect(requests.map((r) => r.method)).toEqual(['GET', 'PATCH']);
  });

  it('creating a FIRST PR is untouched by the guard — nothing exists to lose a phrase from', async () => {
    const requests: HttpRequest[] = [];
    const http: HttpProbe = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        requests.push(req);
        if (req.method === 'GET') return { status: 200, json: [] };
        return { status: 201, json: { html_url: PR_URL } };
      },
    };
    const code = await runHostPr(
      ['create', '--branch', 'wave/4-x', '--title', 'probe', '--body', 'probe', '--remote', GITHUB_REMOTE],
      undefined,
      { http, env: ENV },
    );
    expect(code).toBe(0);
    expect(out()).toMatchObject({ outcome: 'created', url: PR_URL });
    expect(requests.map((r) => r.method)).toEqual(['GET', 'POST']);
  });

  it('--allow-close-phrase-loss on a landing verb is a usage error (exit 2), never silently ignored', async () => {
    const code = await runHostPr(['status', '--branch', 'b', '--allow-close-phrase-loss', '--remote', GITHUB_REMOTE]);
    expect(code).toBe(2);
    expect(stderr).toContain('--allow-close-phrase-loss');
  });

  it("create's help names the rewrite, the refusal, and the read-only alternative", async () => {
    const code = await runHostPr([]);
    expect(code).toBe(2);
    expect(stderr).toContain('RE-WRITES');
    expect(stderr).toContain('reuse-refused');
    expect(stderr).toMatch(/read-only `status` verb/);
  });
});
