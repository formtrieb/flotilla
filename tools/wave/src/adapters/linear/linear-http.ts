/**
 * linear-http.ts — the Linear-adapter-local network seam (ADR-0020, ADR-0019
 * pattern). Simpler than {@link ../github/github-http.GitHubHttp}: Linear has
 * exactly ONE endpoint (`https://api.linear.app/graphql`) and ONE verb (POST) —
 * there is no REST branch, so every request is a `{ query, variables }` GraphQL
 * document. The single network side-effect lives in `defaultLinearHttp`; every
 * other path is pure so the spec injects a fixture (`FakeLinearHttp`).
 */

/** One GraphQL request. `token` is the raw Linear personal API key. */
export interface LinearHttpRequest {
  query: string;
  variables?: Record<string, unknown>;
  token: string;
}

/** The response slice the impl needs: numeric status + pre-parsed JSON (null when empty/unparseable). */
export interface LinearHttpResponse {
  status: number;
  json: unknown;
}

/** Network seam. `defaultLinearHttp` uses global `fetch`; specs inject `FakeLinearHttp`. */
export interface LinearHttp {
  request(req: LinearHttpRequest): Promise<LinearHttpResponse>;
}

/** Linear's single GraphQL endpoint — there is no REST branch (unlike GitHub). */
const LINEAR_API_ENDPOINT = 'https://api.linear.app/graphql';

/**
 * Default {@link LinearHttp} backed by global `fetch` (Node 18+). All real
 * network lives here. Linear **personal API keys go RAW** in `Authorization`
 * (no `Bearer `/`token ` prefix, unlike GitHub's `token <PAT>`) — this is the
 * one auth-shape difference the ADR-0020 brief calls out explicitly. A
 * non-JSON / empty body resolves to `json: null` (status drives every
 * decision, same discipline as `defaultGitHubHttp`).
 */
export function defaultLinearHttp(): LinearHttp {
  return {
    async request(req: LinearHttpRequest): Promise<LinearHttpResponse> {
      const res = await fetch(LINEAR_API_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: req.token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: req.query, variables: req.variables }),
      });
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
