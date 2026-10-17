import { describe, it, expect, vi } from "vitest";
import { GitHubTracker, resolveGithubToken } from "../src/tracker/adapters/github.js";
import type { FetchLike } from "../src/tracker/http.js";

/** Records requests; replies from a queue of canned responses. */
function fixtureFetch(fixtures: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const f: FetchLike = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const fx = fixtures.shift()!;
    return new Response(JSON.stringify(fx.body), { status: fx.status });
  };
  return { f, calls };
}

const ghIssue = (over: Record<string, unknown> = {}) => ({
  number: 7, title: "t", body: "b", state: "open",
  labels: [{ name: "cairn-test" }], milestone: null, assignee: null,
  updated_at: "2026-07-12T00:00:00Z", html_url: "https://github.com/o/r/issues/7",
  ...over,
});

describe("GitHubTracker mapping", () => {
  it("createIssue POSTs to /repos/{repo}/issues and normalizes", async () => {
    const { f, calls } = fixtureFetch([{ status: 201, body: ghIssue() }]);
    const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok");
    const issue = await t.createIssue({ title: "t", body: "b", labels: ["cairn-test"] });
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/issues");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toMatchObject({ title: "t", body: "b", labels: ["cairn-test"] });
    expect(issue).toMatchObject({ id: "7", state: "open", labels: ["cairn-test"] });
  });

  it("in-progress label maps to state=in_progress on read", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: ghIssue({ labels: [{ name: "in-progress" }] }) },
    ]);
    const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok");
    expect((await t.getIssue("7")).state).toBe("in_progress");
  });

  it("in_progress without explicit labels preserves the issue's existing labels", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: ghIssue({ labels: [{ name: "priority-high" }] }) }, // GET current
      { status: 200, body: ghIssue({ labels: [{ name: "priority-high" }, { name: "in-progress" }] }) }, // PATCH
    ]);
    const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok");
    await t.updateIssue("7", { state: "in_progress" });
    const patchCall = calls[calls.length - 1];
    expect(patchCall.method).toBe("PATCH");
    expect(patchCall.body.labels).toEqual(expect.arrayContaining(["priority-high", "in-progress"]));
  });

  it("updateIssue(state=in_progress) adds the label; closed sets state", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: ghIssue({ labels: [] }) }, // GET current (no existing labels)
      { status: 200, body: ghIssue({ labels: [{ name: "in-progress" }] }) }, // PATCH
    ]);
    const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok");
    await t.updateIssue("7", { state: "in_progress" });
    const patchCall = calls[calls.length - 1];
    expect(patchCall.method).toBe("PATCH");
    expect(patchCall.body).toMatchObject({ labels: ["in-progress"] });

    const { f: f2, calls: c2 } = fixtureFetch([
      { status: 200, body: ghIssue({ state: "closed" }) },
    ]);
    const t2 = new GitHubTracker({ repo: "o/r" }, f2, () => "tok");
    const closed = await t2.closeIssue("7");
    expect(c2[0].body).toMatchObject({ state: "closed" });
    expect(closed.state).toBe("closed");
  });

  it("updateIssue(state=open) strips the in-progress label but keeps others", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: ghIssue({ labels: [{ name: "in-progress" }, { name: "priority-high" }] }) }, // GET current
      { status: 200, body: ghIssue({ labels: [{ name: "priority-high" }], state: "open" }) }, // PATCH
    ]);
    const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok");
    await t.updateIssue("7", { state: "open" });
    const patchCall = calls[calls.length - 1];
    expect(patchCall.method).toBe("PATCH");
    expect(patchCall.body).toMatchObject({ state: "open" });
    expect(patchCall.body.labels).toContain("priority-high");
    expect(patchCall.body.labels).not.toContain("in-progress");
  });

  it("listIssues excludes pull requests returned by the issues endpoint", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: [
        ghIssue({ number: 7 }),
        ghIssue({ number: 9, pull_request: { url: "https://api.github.com/repos/o/r/pulls/9" } }),
      ] },
    ]);
    const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok");
    const issues = await t.listIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0].id).toBe("7");
  });

  it("createPhase POSTs a milestone; listIssues filters by milestone", async () => {
    const { f, calls } = fixtureFetch([
      { status: 201, body: { number: 2, title: "Phase 1", state: "open" } },
      { status: 200, body: [ghIssue({ milestone: { number: 2, title: "Phase 1" } })] },
    ]);
    const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok");
    const ph = await t.createPhase("Phase 1");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/milestones");
    expect(ph).toMatchObject({ id: "2", name: "Phase 1" });
    const issues = await t.listIssues({ phase: "2" });
    expect(calls[1].url).toContain("milestone=2");
    expect(issues[0].phase).toBe("2");
  });

  it("sends token as Bearer auth header", async () => {
    let auth = "";
    const f: FetchLike = async (_u, init) => {
      auth = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify(ghIssue()), { status: 200 });
    };
    const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok123");
    await t.getIssue("7");
    expect(auth).toBe("Bearer tok123");
  });

  it("rejects non-numeric issue ids before any HTTP call", async () => {
    const { f, calls } = fixtureFetch([]);
    const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok");
    await expect(t.getIssue("7/comments")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls.length).toBe(0);
  });

  it("throws CONFIG_INVALID on non-numeric phase instead of dropping it", async () => {
    const { f } = fixtureFetch([]);
    const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok");
    await expect(t.createIssue({ title: "x", phase: "nope" }))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("closePhase PATCHes the milestone closed", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { number: 3, title: "Phase 1: core", state: "closed" } },
    ]);
    const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok");
    const p = await t.closePhase("3");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/milestones/3");
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].body).toMatchObject({ state: "closed" });
    expect(p).toMatchObject({ id: "3", state: "closed" });
  });

  it("milestones are UNSUPPORTED (capability-flagged fallback)", async () => {
    const { f } = fixtureFetch([]);
    const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok");
    expect(t.capabilities.hasMilestones).toBe(false);
    await expect(t.createMilestone("v1")).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(t.listMilestones()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(t.completeMilestone("1")).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("commentIssue POSTs to /issues/{n}/comments", async () => {
    const { f, calls } = fixtureFetch([
      { status: 201, body: { id: 991, html_url: "https://github.com/o/r/issues/7#issuecomment-991" } },
    ]);
    const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok");
    const c = await t.commentIssue("7", "plain note");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/issues/7/comments");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ body: "plain note" });
    expect(c).toEqual({ id: "991", url: "https://github.com/o/r/issues/7#issuecomment-991" });
  });
});

describe("GitHubTracker identity", () => {
  it("resolveSelf returns the token user's login from /user and memoizes", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: { login: "octo-dev" } }]);
    const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok");
    expect(await t.resolveSelf!()).toBe("octo-dev");
    expect(await t.resolveSelf!()).toBe("octo-dev");
    expect(calls.filter((c) => c.url.endsWith("/user")).length).toBe(1);
  });
});

describe("resolveGithubToken (#402)", () => {
  it("returns GITHUB_TOKEN when set, without consulting gh", () => {
    const gh = vi.fn(() => "gh-tok");
    expect(resolveGithubToken("env-tok", gh)).toBe("env-tok");
    expect(gh).not.toHaveBeenCalled();
  });

  it("treats an empty GITHUB_TOKEN exactly like unset and falls back to gh", () => {
    // The plugin manifest substitutes an unfilled ${user_config.github_token}
    // as "" — the key is present with an empty value, not dropped.
    const gh = vi.fn(() => "gh-tok");
    expect(resolveGithubToken("", gh)).toBe("gh-tok");
    expect(resolveGithubToken(undefined, gh)).toBe("gh-tok");
    expect(gh).toHaveBeenCalledTimes(2);
  });

  it("treats a whitespace-only GITHUB_TOKEN as unset too", () => {
    expect(resolveGithubToken("  \n", () => "gh-tok")).toBe("gh-tok");
  });

  it("throws AUTH_MISSING when GITHUB_TOKEN is empty and gh has no token", () => {
    const gh = () => { throw new Error("not logged in"); };
    expect(() => resolveGithubToken("", gh)).toThrowError(/no GitHub credentials/);
  });
});

describe("GitHubTracker probe (CRN-48)", () => {
  it("ok on a 200 from /repos/{repo} -- validates the target, not just the token", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: { full_name: "o/r" } }]);
    const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok");
    await expect(t.probe!()).resolves.toEqual({ verdict: "ok" });
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r");
  });

  it("bad_host on a valid token but a nonexistent repo (live-verification gap)", async () => {
    // A valid token passes /user every time -- probing /user alone can never
    // catch a typo'd repo. This is the exact live-verification finding: same
    // token, /user succeeds, but the configured repo doesn't exist.
    const f: FetchLike = async (url) => {
      const u = String(url);
      if (u.endsWith("/user")) return new Response(JSON.stringify({ login: "octo-dev" }), { status: 200 });
      if (u.endsWith("/repos/o/does-not-exist-xyz")) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      throw new Error(`unexpected url in test: ${u}`);
    };
    const t = new GitHubTracker({ repo: "o/does-not-exist-xyz" }, f, () => "tok");
    await expect(t.probe!()).resolves.toMatchObject({ verdict: "bad_host" });
  });

  it("bad_host on a network error", async () => {
    vi.useFakeTimers();
    try {
      const f: FetchLike = async () => { throw new Error("ENOTFOUND api.github.com"); };
      const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok");
      const pending = t.probe!();
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toMatchObject({ verdict: "bad_host" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bad_token on a 401 with a plain-rejected-credentials body", async () => {
    const { f } = fixtureFetch([{ status: 401, body: { message: "Bad credentials" } }]);
    const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok");
    await expect(t.probe!()).resolves.toMatchObject({ verdict: "bad_token" });
  });

  it("missing_scope on a 403 with a scope-shaped body", async () => {
    const { f } = fixtureFetch([
      { status: 403, body: { message: "missing required scope for this operation" } },
    ]);
    const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok");
    await expect(t.probe!()).resolves.toMatchObject({ verdict: "missing_scope" });
  });

  it("rate_limited on an exhausted 429", async () => {
    vi.useFakeTimers();
    try {
      const f: FetchLike = async () => new Response(JSON.stringify({}), { status: 429 });
      const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok");
      const pending = t.probe!();
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toMatchObject({ verdict: "rate_limited" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GitHubTracker custom states", () => {
  it("custom state names are CONFIG_INVALID — no custom-state surface", async () => {
    const t = new GitHubTracker({ repo: "o/r" }, async () => new Response("{}", { status: 200 }), () => "tok");
    await expect(t.updateIssue("1", { state: "review" }))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("GitHubTracker re-phase (#142)", () => {
  it("updateIssue(phase) PATCHes milestone — same mapping as createIssue", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: ghIssue({ milestone: { number: 5 } }) },
    ]);
    const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok");
    const issue = await t.updateIssue("7", { phase: "5" });
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].body).toMatchObject({ milestone: 5 });
    expect(issue.phase).toBe("5");
  });

  it("updateIssue rejects a non-numeric phase before any HTTP call", async () => {
    const { f, calls } = fixtureFetch([]);
    const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok");
    await expect(t.updateIssue("7", { phase: "not-a-number" }))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(calls.length).toBe(0);
  });

  it("declares hasPhaseReassign", () => {
    const t = new GitHubTracker({ repo: "o/r" }, async () => new Response("{}", { status: 200 }), () => "tok");
    expect(t.capabilities.hasPhaseReassign).toBe(true);
  });
});
