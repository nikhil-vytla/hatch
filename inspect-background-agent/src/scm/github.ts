/**
 * GitHub PR opening. PRs are opened with the prompting user's token so the
 * human is the PR author (Ramp's attribution rule), never a shared bot.
 */
export type GitHubRepoRef = {
  readonly owner: string;
  readonly repo: string;
};

/** Parse owner/repo from an https or ssh GitHub clone URL. Null for non-GitHub remotes. */
export function parseGitHubRemote(cloneUrl: string): GitHubRepoRef | null {
  const https = cloneUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (https) return { owner: https[1]!, repo: https[2]! };
  const ssh = cloneUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1]!, repo: ssh[2]! };
  return null;
}

export type OpenPullRequestArgs = {
  readonly repo: GitHubRepoRef;
  readonly head: string;
  readonly base?: string;
  readonly title: string;
  readonly body?: string;
  readonly token: string;
};

export type PullRequestResult = {
  readonly number: number;
  readonly url: string;
};

export async function openPullRequest(
  args: OpenPullRequestArgs,
): Promise<PullRequestResult> {
  const r = await fetch(
    `https://api.github.com/repos/${args.repo.owner}/${args.repo.repo}/pulls`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${args.token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({
        title: args.title,
        head: args.head,
        base: args.base ?? "main",
        body: args.body ?? "",
      }),
    },
  );
  if (!r.ok) {
    throw new Error(`GitHub PR failed ${r.status}: ${await r.text()}`);
  }
  const j = (await r.json()) as { number: number; html_url: string };
  return { number: j.number, url: j.html_url };
}
