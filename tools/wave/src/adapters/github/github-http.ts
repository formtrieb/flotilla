/**
 * github-http.ts — the GitHub-adapter-local network seam (ADR-0019).
 *
 * NOT host-pr's cross-host `HttpProbe` (which is GET|POST + Basic auth for
 * GitHub *and* Bitbucket): GitHub REST needs PATCH/DELETE and GraphQL needs a
 * POST with `Authorization: token <PAT>`. The single network side-effect lives
 * in `defaultGitHubHttp`; every other path is pure so the spec injects a fixture.
 */

/**
 * One GitHub HTTP request. `token` is the raw PAT (REST + GraphQL both accept
 * `token <PAT>`).
 *
 * `PUT` joined the verb set for the ADR-0023 landing path: the REST merge is
 * `PUT /repos/{o}/{r}/pulls/{n}/merge`, the only PUT flotilla issues.
 */
export interface GitHubHttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  token: string;
  /** Already-serialised JSON payload for writes; omitted for reads. */
  body?: string;
}

/** The response slice the impl needs: numeric status + pre-parsed JSON (null when empty/unparseable). */
export interface GitHubHttpResponse {
  status: number;
  json: unknown;
}

/** Network seam. `defaultGitHubHttp` uses global `fetch`; specs inject a fixture (mirrors host-pr's HttpProbe). */
export interface GitHubHttp {
  request(req: GitHubHttpRequest): Promise<GitHubHttpResponse>;
}

/**
 * Default {@link GitHubHttp} backed by global `fetch` (Node 18+). All real
 * network lives here. `Authorization: token <PAT>` authenticates both REST and
 * GraphQL; a non-JSON / empty body resolves to `json: null` (status drives
 * every decision).
 */
export function defaultGitHubHttp(): GitHubHttp {
  return {
    async request(req: GitHubHttpRequest): Promise<GitHubHttpResponse> {
      const headers: Record<string, string> = {
        Authorization: `token ${req.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'flotilla-wave-tools',
      };
      if (req.body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(req.url, { method: req.method, headers, body: req.body });
      let json: unknown;
      try {
        const text = await res.text();
        json = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, json };
    },
  };
}
