import type { GitHubHttp, GitHubHttpRequest, GitHubHttpResponse } from './github-http';

/**
 * Recording fixture probe for hermetic GitHubApi tests. The `handler` inspects
 * each request (method/url/body) and returns a canned `{status, json}`; every
 * request is captured in `.requests` for assertions. Zero network.
 */
export class FakeGitHubHttp implements GitHubHttp {
  readonly requests: GitHubHttpRequest[] = [];
  constructor(private readonly handler: (req: GitHubHttpRequest) => GitHubHttpResponse) {}
  async request(req: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    this.requests.push(req);
    return this.handler(req);
  }
}
