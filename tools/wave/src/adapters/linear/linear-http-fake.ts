import type { LinearHttp, LinearHttpRequest, LinearHttpResponse } from './linear-http';

/** A canned responder for one named GraphQL operation. */
export type LinearHttpFakeHandler = (req: LinearHttpRequest) => LinearHttpResponse;

/**
 * Recording fixture for hermetic `RealLinearApi` tests. Unlike
 * {@link ../github/github-http-fake.FakeGitHubHttp} (one handler that switches
 * on method/url), Linear has a single POST endpoint, so responses are keyed by
 * the GraphQL **operation name** instead — the `query Foo(...)` / `mutation
 * Foo(...)` name every `RealLinearApi` document declares (see the named
 * consts in `real-linear-api.ts`). A spec registers one canned handler per
 * operation regardless of exact query formatting; every request is captured
 * in `.requests` for query/variables shape assertions. Zero network.
 */
export class FakeLinearHttp implements LinearHttp {
  readonly requests: LinearHttpRequest[] = [];

  constructor(private readonly routes: Record<string, LinearHttpFakeHandler>) {}

  async request(req: LinearHttpRequest): Promise<LinearHttpResponse> {
    this.requests.push(req);
    const op = operationName(req.query);
    const handler = this.routes[op];
    if (!handler) {
      const known = Object.keys(this.routes).join(', ') || '<none>';
      throw new Error(`FakeLinearHttp: no route registered for GraphQL operation "${op}" (registered: ${known})`);
    }
    return handler(req);
  }
}

/**
 * Extract the named operation out of a GraphQL document, e.g.
 * `"query ResolveTeamCatalog($match: String!) { … }"` → `"ResolveTeamCatalog"`.
 * Every `real-linear-api.ts` document is deliberately named so both this fake
 * and `LinearApiError.op` read the same identifier for a given wire call.
 */
export function operationName(query: string): string {
  const m = /^\s*(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(query);
  if (!m) {
    throw new Error(
      'FakeLinearHttp: query has no named operation (RealLinearApi documents must be named, e.g. "query Foo(...) { ... }")',
    );
  }
  return m[1];
}
