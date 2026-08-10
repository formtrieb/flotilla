/**
 * bitbucket-api.spec.ts — the Bitbucket Cloud landing adapter, driven entirely
 * over its injectable {@link BitbucketHttp} seam. NO network, no credential:
 * every request is answered by a fixture and every request the adapter makes is
 * recorded, so the REQUEST SHAPES (the part a live consumer's first wave will
 * prove or disprove) are pinned here against Atlassian's documented forms.
 *
 * The live half is declared-unexecutable from this repo (ADR-0030): flotilla's
 * own remote is GitHub and no Bitbucket credential is reachable here. What this
 * file CAN do — and does — is hold every decision the adapter makes to the
 * documentation it was written from, and prove the safety-critical directions:
 * a pending build never reads `clean`, a blind read never reads `clean`, and
 * `enableAutoMerge` throws the one refusal reason that cannot merge past a gate.
 */

import { describe, it, expect } from 'vitest';
import {
  RealBitbucketApi,
  BitbucketApiError,
  bitbucketAuthHeader,
  bitbucketCreateCreds,
  bitbucketBranchRestrictionApplies,
  createBitbucketApiFromEnv,
  BITBUCKET_TOKEN_VAR,
  BITBUCKET_EMAIL_VAR,
  type BitbucketHttp,
  type BitbucketHttpRequest,
  type BitbucketHttpResponse,
} from './bitbucket-api';
import { AutoMergeUnavailableError } from '../../host-pr';

// ─── the seam fixture ────────────────────────────────────────────────────────

/**
 * Answer each request with the first matching canned response, recording every
 * request. An unmatched request resolves to 404 rather than reaching `fetch` —
 * there is no network anywhere in this file.
 */
function fakeHttp(
  routes: Array<[(req: BitbucketHttpRequest) => boolean, BitbucketHttpResponse]>,
): { http: BitbucketHttp; calls: BitbucketHttpRequest[] } {
  const calls: BitbucketHttpRequest[] = [];
  return {
    calls,
    http: {
      async request(req) {
        calls.push(req);
        for (const [match, res] of routes) if (match(req)) return res;
        return { status: 404, json: null };
      },
    },
  };
}

const urlHas = (frag: string) => (req: BitbucketHttpRequest) => req.url.includes(frag);
const isMethod = (m: BitbucketHttpRequest['method']) => (req: BitbucketHttpRequest) => req.method === m;
const both =
  (...ps: Array<(req: BitbucketHttpRequest) => boolean>) =>
  (req: BitbucketHttpRequest) =>
    ps.every((p) => p(req));

const AUTH = 'Basic dGVzdA==';
const api = (http: BitbucketHttp) => new RealBitbucketApi('ws', 'repo', AUTH, http);

/** A `values`-paged Bitbucket collection with no `next` page. */
const page = (values: unknown[]): BitbucketHttpResponse => ({ status: 200, json: { values } });

/** An OPEN PR payload in Bitbucket's own shape. */
const openPr = (over: Record<string, unknown> = {}) => ({
  id: 7,
  state: 'OPEN',
  links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/7' } },
  source: { branch: { name: 'wave/461-x' }, commit: { hash: 'abc123' } },
  destination: { branch: { name: 'main' } },
  ...over,
});

/** No merge check on `main` — the "nothing to wait for" posture. */
const NO_RESTRICTIONS: [(req: BitbucketHttpRequest) => boolean, BitbucketHttpResponse] = [
  urlHas('/branch-restrictions'),
  page([]),
];

/** One `require_passing_builds_to_merge` restriction of N on every branch. */
const requireBuilds = (n: number): [(req: BitbucketHttpRequest) => boolean, BitbucketHttpResponse] => [
  urlHas('/branch-restrictions'),
  page([{ kind: 'require_passing_builds_to_merge', pattern: '*', value: n, branch_match_kind: 'glob' }]),
];

const statuses = (
  values: unknown[],
): [(req: BitbucketHttpRequest) => boolean, BitbucketHttpResponse] => [
  urlHas('/statuses'),
  page(values),
];

// ─── credential shapes (the MEASURED answer, not the hypothesised one) ───────

describe('bitbucketAuthHeader — the two live credential shapes', () => {
  it('an Atlassian API token pairs with the ACCOUNT EMAIL over Basic auth', () => {
    const header = bitbucketAuthHeader('tok', 'dev@example.com');
    expect(header.startsWith('Basic ')).toBe(true);
    expect(Buffer.from(header.slice('Basic '.length), 'base64').toString('utf-8')).toBe(
      'dev@example.com:tok',
    );
  });

  it('without an email it falls back to Bearer — the repository/workspace access-token form', () => {
    expect(bitbucketAuthHeader('tok')).toBe('Bearer tok');
    expect(bitbucketAuthHeader('tok', '')).toBe('Bearer tok');
  });
});

describe('bitbucketCreateCreds — `create` can only speak Basic', () => {
  it('returns the email:token pair when the account email is configured', () => {
    expect(bitbucketCreateCreds('tok', 'dev@example.com')).toBe('dev@example.com:tok');
  });

  it('refuses LOUDLY without the email, naming the variable and the app-password removal', () => {
    for (const email of [undefined, '']) {
      expect(() => bitbucketCreateCreds('tok', email)).toThrow(
        new RegExp(`${BITBUCKET_EMAIL_VAR}`),
      );
    }
    expect(() => bitbucketCreateCreds('tok', undefined)).toThrow(/app passwords/i);
    // The refusal must point at the variable that FIXES it, not merely at the
    // one that is set — a message naming only the token would send the operator
    // to re-issue a credential that is already fine.
    expect(() => bitbucketCreateCreds('tok', undefined)).toThrow(
      new RegExp(BITBUCKET_TOKEN_VAR),
    );
  });
});

// ─── branch-restriction applicability (the over-match direction is the point) ─

describe('bitbucketBranchRestrictionApplies', () => {
  it('a glob pattern matches ACROSS slashes — a feature/* rule covers feature/a/b', () => {
    const r = { pattern: 'feature/*', branch_match_kind: 'glob' };
    expect(bitbucketBranchRestrictionApplies(r, 'feature/a')).toBe(true);
    expect(bitbucketBranchRestrictionApplies(r, 'feature/a/b')).toBe(true);
    expect(bitbucketBranchRestrictionApplies(r, 'main')).toBe(false);
  });

  it('"*" covers everything, and a literal pattern is exact', () => {
    expect(bitbucketBranchRestrictionApplies({ pattern: '*', branch_match_kind: 'glob' }, 'main')).toBe(true);
    expect(bitbucketBranchRestrictionApplies({ pattern: 'main' }, 'main')).toBe(true);
    expect(bitbucketBranchRestrictionApplies({ pattern: 'main' }, 'mainline')).toBe(false);
  });

  it('regex metacharacters in a pattern are literal, not operators', () => {
    expect(bitbucketBranchRestrictionApplies({ pattern: 'rel.1' }, 'rel.1')).toBe(true);
    expect(bitbucketBranchRestrictionApplies({ pattern: 'rel.1' }, 'relX1')).toBe(false);
  });

  it('a branching-model restriction, which names no pattern, is treated as APPLYING (the safe direction)', () => {
    expect(bitbucketBranchRestrictionApplies({ branch_match_kind: 'branching_model' }, 'anything')).toBe(true);
    expect(bitbucketBranchRestrictionApplies({}, 'anything')).toBe(true);
  });
});

// ─── getPrStatus — the tier-2 done-reconcile probe ───────────────────────────

describe('RealBitbucketApi.getPrStatus', () => {
  it('asks for ALL FOUR documented states, not the OPEN-only default, and filters with BBQL', async () => {
    const { http, calls } = fakeHttp([[urlHas('/pullrequests'), page([])]]);
    await api(http).getPrStatus('wave/461-x');

    const url = calls[0].url;
    // BBQL is the `q` value; `state` is a repeated first-class parameter. A
    // MERGED PR is the whole point of this probe — the OPEN-only default would
    // answer `none` for exactly the row a done-reconcile is asking about.
    expect(url).toContain(`q=${encodeURIComponent('source.branch.name="wave/461-x"')}`);
    for (const s of ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED']) {
      expect(url).toContain(`state=${s}`);
    }
    expect(calls[0].method).toBe('GET');
    expect(calls[0].auth).toBe(AUTH);
  });

  it('no PR for the branch → state none', async () => {
    const { http } = fakeHttp([[urlHas('/pullrequests'), page([])]]);
    expect(await api(http).getPrStatus('b')).toEqual({ state: 'none' });
  });

  it('a MERGED PR → merged, with the url and number (the evidence that retires a hand-asserted merge)', async () => {
    const { http } = fakeHttp([
      [urlHas('/pullrequests'), page([openPr({ state: 'MERGED' })])],
    ]);
    expect(await api(http).getPrStatus('b')).toEqual({
      state: 'merged',
      number: 7,
      url: 'https://bitbucket.org/ws/repo/pull-requests/7',
    });
  });

  it('DECLINED and SUPERSEDED both project onto closed-unmerged (flotilla never re-opens a PR)', async () => {
    for (const state of ['DECLINED', 'SUPERSEDED']) {
      const { http } = fakeHttp([[urlHas('/pullrequests'), page([openPr({ state })])]]);
      expect((await api(http).getPrStatus('b')).state).toBe('closed-unmerged');
    }
  });

  it('an OPEN PR wins over a merged sibling on the same branch — it is the only actionable one', async () => {
    const { http } = fakeHttp([
      [
        urlHas('/pullrequests'),
        page([openPr({ id: 3, state: 'MERGED' }), openPr({ id: 7, state: 'OPEN' })]),
      ],
      NO_RESTRICTIONS,
    ]);
    const status = await api(http).getPrStatus('b');
    expect(status.state).toBe('open');
    expect(status.number).toBe(7);
  });

  it('an OPEN PR reports headSha + baseRef from source.commit.hash / destination.branch.name', async () => {
    const { http } = fakeHttp([[urlHas('/pullrequests'), page([openPr()])], NO_RESTRICTIONS]);
    const status = await api(http).getPrStatus('b');
    expect(status.headSha).toBe('abc123');
    expect(status.baseRef).toBe('main');
  });

  it('a non-200 list is a typed throw carrying Bitbucket\'s own message', async () => {
    const { http } = fakeHttp([
      [urlHas('/pullrequests'), { status: 403, json: { error: { message: 'Access denied' } } }],
    ]);
    await expect(api(http).getPrStatus('b')).rejects.toThrow(/Access denied/);
    await expect(api(http).getPrStatus('b')).rejects.toBeInstanceOf(BitbucketApiError);
  });
});

// ─── mergeability — Atlassian's own merge-check sentence, implemented ─────────

describe('RealBitbucketApi.getPrStatus — mergeability (Bitbucket has no mergeable_state)', () => {
  const withStatuses = async (n: number, values: unknown[]) => {
    const { http } = fakeHttp([
      [urlHas('/pullrequests'), page([openPr()])],
      requireBuilds(n),
      statuses(values),
    ]);
    return (await api(http).getPrStatus('b')).mergeability;
  };

  it('no required builds → clean (a no-CI repo direct-merges, exactly as on GitHub)', async () => {
    const { http } = fakeHttp([[urlHas('/pullrequests'), page([openPr()])], NO_RESTRICTIONS]);
    expect((await api(http).getPrStatus('b')).mergeability).toBe('clean');
  });

  it('required builds all reported SUCCESSFUL → clean', async () => {
    expect(await withStatuses(2, [{ state: 'SUCCESSFUL' }, { state: 'SUCCESSFUL' }])).toBe('clean');
  });

  it('ZERO statuses reported → blocked, NOT clean — this is the check-attach latency window', async () => {
    // The defect this closes on the GitHub side is "no pending required checks"
    // being indistinguishable from "nothing has reported yet". On Bitbucket the
    // requirement is a COUNT, so 0 < N settles it without a name comparison.
    expect(await withStatuses(1, [])).toBe('blocked');
  });

  it('an INPROGRESS build → blocked (Atlassian: "no failed builds and no in progress builds")', async () => {
    expect(await withStatuses(1, [{ state: 'SUCCESSFUL' }, { state: 'INPROGRESS' }])).toBe('blocked');
  });

  it('a FAILED build → blocked, even when the successful count is already met', async () => {
    expect(await withStatuses(1, [{ state: 'SUCCESSFUL' }, { state: 'FAILED' }])).toBe('blocked');
  });

  it('an unrecognised state (STOPPED) counts as "not a successful build" → blocked', async () => {
    expect(await withStatuses(1, [{ state: 'STOPPED' }])).toBe('blocked');
  });

  it('a BLIND branch-restrictions read → unknown, never clean', async () => {
    const { http } = fakeHttp([
      [urlHas('/pullrequests'), page([openPr()])],
      [urlHas('/branch-restrictions'), { status: 403, json: null }],
    ]);
    expect((await api(http).getPrStatus('b')).mergeability).toBe('unknown');
  });

  it('a FAILED build-status read → unknown, never clean (a broken read must not counterfeit "nothing pending")', async () => {
    const { http } = fakeHttp([
      [urlHas('/pullrequests'), page([openPr()])],
      requireBuilds(1),
      [urlHas('/statuses'), { status: 500, json: null }],
    ]);
    expect((await api(http).getPrStatus('b')).mergeability).toBe('unknown');
  });

  it('a draft PR → draft (never landed)', async () => {
    const { http } = fakeHttp([
      [urlHas('/pullrequests'), page([openPr({ draft: true })])],
      NO_RESTRICTIONS,
    ]);
    expect((await api(http).getPrStatus('b')).mergeability).toBe('draft');
  });

  it('the STRICTEST applicable restriction wins when several cover the branch', async () => {
    const { http } = fakeHttp([
      [urlHas('/pullrequests'), page([openPr()])],
      [
        urlHas('/branch-restrictions'),
        page([
          { kind: 'require_passing_builds_to_merge', pattern: '*', value: 1, branch_match_kind: 'glob' },
          { kind: 'require_passing_builds_to_merge', pattern: 'main', value: 3, branch_match_kind: 'glob' },
        ]),
      ],
      statuses([{ state: 'SUCCESSFUL' }, { state: 'SUCCESSFUL' }]),
    ]);
    // 2 successful builds satisfy the value-1 rule but not the value-3 one.
    expect((await api(http).getPrStatus('b')).mergeability).toBe('blocked');
  });

  it('a restriction that does NOT cover the destination branch is ignored', async () => {
    const { http } = fakeHttp([
      [urlHas('/pullrequests'), page([openPr()])],
      [
        urlHas('/branch-restrictions'),
        page([
          { kind: 'require_passing_builds_to_merge', pattern: 'release/*', value: 3, branch_match_kind: 'glob' },
        ]),
      ],
    ]);
    expect((await api(http).getPrStatus('b')).mergeability).toBe('clean');
  });
});

// ─── enableAutoMerge — the MEASURED answer (AC4) ─────────────────────────────

describe('RealBitbucketApi.enableAutoMerge — Bitbucket Cloud has no arming primitive', () => {
  it('throws the typed AutoMergeUnavailableError with reason not-allowed, and issues NO request', async () => {
    const { http, calls } = fakeHttp([]);
    await expect(api(http).enableAutoMerge(7)).rejects.toBeInstanceOf(AutoMergeUnavailableError);
    expect(calls).toEqual([]);
  });

  it("the reason is 'not-allowed', NOT 'clean-status' — only that one refuses rather than merging past a pending check", async () => {
    const { http } = fakeHttp([]);
    let err: AutoMergeUnavailableError | undefined;
    try {
      await api(http).enableAutoMerge(7);
    } catch (e) {
      err = e as AutoMergeUnavailableError;
    }
    expect(err).toBeInstanceOf(AutoMergeUnavailableError);
    if (err === undefined) throw new Error('unreachable — the assertion above already failed');
    expect(err.reason).toBe('not-allowed');
    expect(err.message).toMatch(/no auto-merge arming primitive/i);
    // The message must say WHAT the platform has instead, or the operator reads
    // it as a flotilla gap rather than a host property.
    expect(err.message).toMatch(/merge check/i);
  });
});

// ─── mergePullRequest ────────────────────────────────────────────────────────

describe('RealBitbucketApi.mergePullRequest', () => {
  const mergeRoute = (res: BitbucketHttpResponse): [(req: BitbucketHttpRequest) => boolean, BitbucketHttpResponse] => [
    both(isMethod('POST'), urlHas('/pullrequests/7/merge')),
    res,
  ];

  it('POSTs merge_strategy squash by default and reads the merge commit off merge_commit.hash', async () => {
    const { http, calls } = fakeHttp([mergeRoute({ status: 200, json: { merge_commit: { hash: 'deadbee' } } })]);
    expect(await api(http).mergePullRequest(7)).toEqual({ merged: true, sha: 'deadbee' });
    expect(calls[0].url).toBe('https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/7/merge');
    expect(JSON.parse(calls[0].body as string)).toEqual({ merge_strategy: 'squash' });
  });

  it("maps flotilla's 'merge' onto Bitbucket's merge_commit", async () => {
    const { http, calls } = fakeHttp([mergeRoute({ status: 200, json: {} })]);
    await api(http).mergePullRequest(7, 'merge');
    expect(JSON.parse(calls[0].body as string)).toEqual({ merge_strategy: 'merge_commit' });
  });

  it("refuses 'rebase' LOUDLY — Bitbucket has no rebase strategy — and issues no request", async () => {
    const { http, calls } = fakeHttp([mergeRoute({ status: 200, json: {} })]);
    await expect(api(http).mergePullRequest(7, 'rebase')).rejects.toThrow(/merge_commit, squash and fast_forward/);
    expect(calls).toEqual([]);
  });

  it('a 202 async merge task is merged:true with NO invented sha', async () => {
    const { http } = fakeHttp([mergeRoute({ status: 202, json: { task_id: 'abc' } })]);
    expect(await api(http).mergePullRequest(7)).toEqual({ merged: true });
  });

  it('a 200 without a merge commit is merged:true with sha absent', async () => {
    const { http } = fakeHttp([mergeRoute({ status: 200, json: {} })]);
    const r = await api(http).mergePullRequest(7);
    expect(r).toEqual({ merged: true });
    expect('sha' in r).toBe(false);
  });

  it("a refused merge is a typed throw carrying Bitbucket's own message verbatim (the host stays the final gate)", async () => {
    const { http } = fakeHttp([
      mergeRoute({ status: 400, json: { error: { message: 'There are merge checks not met' } } }),
    ]);
    await expect(api(http).mergePullRequest(7)).rejects.toThrow(/There are merge checks not met/);
  });

  it('does NOT send close_source_branch — branch hygiene is --delete-branch, whose outcome is reported', async () => {
    const { http, calls } = fakeHttp([mergeRoute({ status: 200, json: {} })]);
    await api(http).mergePullRequest(7);
    expect(JSON.parse(calls[0].body as string)).not.toHaveProperty('close_source_branch');
  });
});

// ─── deleteBranch ────────────────────────────────────────────────────────────

describe('RealBitbucketApi.deleteBranch', () => {
  it('DELETEs refs/branches/<name> with slashes preserved as path separators, and accepts 204', async () => {
    const { http, calls } = fakeHttp([[isMethod('DELETE'), { status: 204, json: null }]]);
    await api(http).deleteBranch('wave/461-bitbucket-landing-host');
    expect(calls[0].url).toBe(
      'https://api.bitbucket.org/2.0/repositories/ws/repo/refs/branches/wave/461-bitbucket-landing-host',
    );
  });

  it('escapes odd characters WITHIN a segment while keeping the slashes', async () => {
    const { http, calls } = fakeHttp([[isMethod('DELETE'), { status: 204, json: null }]]);
    await api(http).deleteBranch('wave/a b');
    expect(calls[0].url).toMatch(/refs\/branches\/wave\/a%20b$/);
  });

  it('a failed delete throws, so the merge path can record it as a structural degradation', async () => {
    const { http } = fakeHttp([
      [isMethod('DELETE'), { status: 400, json: { error: { message: 'Branch not found' } } }],
    ]);
    await expect(api(http).deleteBranch('gone')).rejects.toThrow(/Branch not found/);
  });
});

// ─── LandingPosture ──────────────────────────────────────────────────────────

describe('RealBitbucketApi — LandingPosture', () => {
  it('canMergePullRequests: write and admin can merge, read cannot', async () => {
    for (const [permission, expected] of [
      ['admin', true],
      ['write', true],
      ['read', false],
    ] as const) {
      const { http } = fakeHttp([[urlHas('/user/permissions/repositories'), page([{ permission }])]]);
      expect(await api(http).canMergePullRequests()).toBe(expected);
    }
  });

  it('canMergePullRequests: a BLIND user-scoped read is absence of evidence, never a finding', async () => {
    // A repository/workspace access token has no user context, so this endpoint
    // cannot grade it. Grading it `false` would hard-fail `host-pr preflight`
    // for a correctly-configured pilot.
    for (const res of [
      { status: 401, json: null },
      { status: 403, json: null },
      { status: 200, json: { values: [] } },
    ]) {
      const { http } = fakeHttp([[urlHas('/user/permissions/repositories'), res]]);
      expect(await api(http).canMergePullRequests()).toBe(true);
    }
  });

  it('getAutoMergeSetting is off — a measurement, not a read (there is no setting to see)', async () => {
    const { http, calls } = fakeHttp([]);
    expect(await api(http).getAutoMergeSetting()).toBe('off');
    expect(calls).toEqual([]);
  });

  it('getRequiredChecks reports PRESENT with an empty context list — Bitbucket states a COUNT, not names', async () => {
    const { http } = fakeHttp([requireBuilds(2)]);
    const r = await api(http).getRequiredChecks('main');
    expect(r.state).toBe('present');
    expect(r.contexts).toEqual([]);
    expect(r.detail).toMatch(/at least 2 successful build/);
  });

  it('getRequiredChecks reports ABSENT when no build restriction is in force', async () => {
    const { http } = fakeHttp([NO_RESTRICTIONS]);
    expect((await api(http).getRequiredChecks('main')).state).toBe('absent');
  });

  it('getRequiredChecks NEVER throws — a blind read degrades to unknown (the report-only contract)', async () => {
    const { http } = fakeHttp([[urlHas('/branch-restrictions'), { status: 500, json: null }]]);
    const r = await api(http).getRequiredChecks('main');
    expect(r.state).toBe('unknown');
    expect(r.detail).toMatch(/Advisory only/);
  });

  it('with no branch argument it resolves the repo mainbranch first', async () => {
    const { http, calls } = fakeHttp([
      [
        (req) => req.url === 'https://api.bitbucket.org/2.0/repositories/ws/repo',
        { status: 200, json: { mainbranch: { name: 'trunk' } } },
      ],
      requireBuilds(1),
    ]);
    expect((await api(http).getRequiredChecks()).detail).toMatch(/'trunk'/);
    expect(calls[0].url).toBe('https://api.bitbucket.org/2.0/repositories/ws/repo');
  });
});

// ─── pagination ──────────────────────────────────────────────────────────────

describe('RealBitbucketApi — paged reads follow the `next` LINK', () => {
  it('walks every page of branch restrictions (an unpaginated read would drop a real gate)', async () => {
    const { http, calls } = fakeHttp([
      [
        (req) => req.url.includes('/branch-restrictions') && !req.url.includes('cursor=2'),
        {
          status: 200,
          json: {
            values: [{ kind: 'require_passing_builds_to_merge', pattern: 'nope', value: 9 }],
            next: 'https://api.bitbucket.org/2.0/repositories/ws/repo/branch-restrictions?cursor=2',
          },
        },
      ],
      [
        urlHas('cursor=2'),
        page([{ kind: 'require_passing_builds_to_merge', pattern: '*', value: 4 }]),
      ],
    ]);
    // The page-2 rule is the one that applies; a single-page read would have
    // reported `absent` and let a checks-pending PR read `clean`.
    const r = await api(http).getRequiredChecks('main');
    expect(r.state).toBe('present');
    expect(r.detail).toMatch(/at least 4 successful build/);
    expect(calls).toHaveLength(2);
  });

  it('a `next` that repeats a URL stops the walk rather than hanging', async () => {
    const self = 'https://api.bitbucket.org/2.0/repositories/ws/repo/branch-restrictions?kind=require_passing_builds_to_merge&pagelen=100';
    const { http, calls } = fakeHttp([
      [urlHas('/branch-restrictions'), { status: 200, json: { values: [], next: self } }],
    ]);
    expect((await api(http).getRequiredChecks('main')).state).toBe('absent');
    expect(calls).toHaveLength(1);
  });
});

// ─── the factory (ADR-0029 credential seam) ──────────────────────────────────

describe('createBitbucketApiFromEnv', () => {
  const remoteUrl = 'git@bitbucket.org:ws/repo.git';

  it('resolves the token through the credential seam and preflights the BOUND REPO, not /2.0/user', async () => {
    const { http, calls } = fakeHttp([
      [(req) => req.url === 'https://api.bitbucket.org/2.0/repositories/ws/repo', { status: 200, json: {} }],
    ]);
    await createBitbucketApiFromEnv({
      remoteUrl,
      workspace: 'ws',
      repo: 'repo',
      http,
      env: { [BITBUCKET_TOKEN_VAR]: 'tok', [BITBUCKET_EMAIL_VAR]: 'dev@example.com' },
    });
    // `/2.0/user` would reject a repository/workspace access token, which has
    // no user context — a preflight that rejected a valid credential would be
    // worse than none.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.bitbucket.org/2.0/repositories/ws/repo');
    expect(calls[0].auth.startsWith('Basic ')).toBe(true);
  });

  it('falls back to Bearer when no account email is configured', async () => {
    const { http, calls } = fakeHttp([[urlHas('/repositories/ws/repo'), { status: 200, json: {} }]]);
    await createBitbucketApiFromEnv({
      remoteUrl,
      workspace: 'ws',
      repo: 'repo',
      http,
      env: { [BITBUCKET_TOKEN_VAR]: 'tok' },
    });
    expect(calls[0].auth).toBe('Bearer tok');
  });

  it('a rejected credential fails LOUD at construction, not mid-wave', async () => {
    const { http } = fakeHttp([[urlHas('/repositories/ws/repo'), { status: 401, json: null }]]);
    await expect(
      createBitbucketApiFromEnv({
        remoteUrl,
        workspace: 'ws',
        repo: 'repo',
        http,
        env: { [BITBUCKET_TOKEN_VAR]: 'tok' },
      }),
    ).rejects.toThrow(new RegExp(`${BITBUCKET_TOKEN_VAR} rejected`));
  });

  it('an unconfigured credential is the engine-owned typed error, never a silent anonymous request', async () => {
    const { http, calls } = fakeHttp([]);
    await expect(
      createBitbucketApiFromEnv({ remoteUrl, workspace: 'ws', repo: 'repo', http, env: {} }),
    ).rejects.toThrow(new RegExp(`${BITBUCKET_TOKEN_VAR} is required`));
    expect(calls).toEqual([]);
  });
});
