/**
 * Purpose: #254 -- the harness guard must see through a wrapper's own flags
 *   (sudo -u root, env -i, nice -n 5, timeout 5 ...) and through shell flag
 *   clusters that carry -c (bash -lc), the way it did before the #240
 *   rewrite. #265 -- it must see writes that land in a protected folder
 *   (cp/mv/rsync into hooks/ or .claude/, rm -rf of the folder or one
 *   holding it), downloads, extracted archives and applied patches, and the
 *   inline override exempts only the command it prefixes. #258 -- writes
 *   through su -c, find -delete/-exec, paths piped to xargs, a heredoc fed
 *   to a shell, and relative paths resolved from the payload cwd and any
 *   cd before them. #286 -- refusals name the owner's ways to approve and
 *   never print the override prefix. Every write is paired with a READ of
 *   the same path, so closing a gap never brings back the #240 false
 *   positives. Only command strings are fed to the hook; nothing is ever run.
 * Author(s): John Reed
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Constants
const HARNESSGUARD = join(dirname(fileURLToPath(import.meta.url)), "..", "..",
  "hooks", "scripts", "pretooluse-harnessguard.mjs");

// Variables
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A bare temp dir is a complete fixture -- the guard reads no project state. */
function proj(): string {
  const d = mkdtempSync(join(tmpdir(), "cairn-harnessguard-wrappers-"));
  dirs.push(d);
  return d;
}

/** Exit status of the guard for one tool call; `cwd` is the payload's, relative to the project. */
function call(projectDir: string, tool: string, input: Record<string, string>, cwd?: string): number | null {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
  delete env.CAIRN_HARNESS_EDIT;
  delete env.CDPATH; // an inherited CDPATH is more places a cd can land (#258)
  const r = spawnSync(process.execPath, [HARNESSGUARD], {
    cwd: projectDir,
    env,
    input: JSON.stringify({ tool_name: tool, tool_input: input, cwd: cwd === undefined ? "" : join(projectDir, cwd) }),
    encoding: "utf8",
    timeout: 5000,
  });
  return r.status;
}

/** Exit status of the guard for one Bash command string. */
function guard(projectDir: string, command: string, cwd?: string): number | null {
  return call(projectDir, "Bash", { command }, cwd);
}

describe("harness guard sees through wrapper flags (#254)", () => {
  it("the reported bypasses are refused again", () => {
    const p = proj();
    for (const c of [
      "sudo -u root tee hooks/a",
      "env -i FOO=1 rm hooks/a",
      "bash -lc 'echo x > hooks/a'",
    ]) {
      expect(guard(p, c), c).toBe(2);
    }
  });

  // Each row: [wrapped write, wrapped read of the same path]. The write must
  // be refused exactly like its plain form; the read must pass like its
  // plain form (#240 stays intact).
  it("a wrapped write is refused and the same wrapper around a read passes", () => {
    const p = proj();
    const pairs: Array<[write: string, read: string]> = [
      ["sudo -u root tee hooks/a", "sudo -u root cat hooks/a"],
      ["sudo -uroot rm hooks/a", "sudo -uroot cat hooks/a"],
      ["sudo -E -g wheel mv /tmp/x .mcp.json", "sudo -E -g wheel cat .mcp.json"],
      ["sudo --user=root rm hooks/a", "sudo --user=root cat hooks/a"],
      ["sudo --user root rm hooks/a", "sudo --user root cat hooks/a"],
      ["sudo -- rm hooks/a", "sudo -- cat hooks/a"],
      ["/usr/bin/sudo -n rm hooks/a", "/usr/bin/sudo -n cat hooks/a"],
      ["env -i FOO=1 rm hooks/a", "env -i FOO=1 cat hooks/a"],
      ["env -u HOME rm hooks/a", "env -u HOME cat hooks/a"],
      ["env -C . rm hooks/a", "env -C . cat hooks/a"],
      ["env -S 'rm hooks/a'", "env -S 'cat hooks/a'"],
      ["env - rm hooks/a", "env - cat hooks/a"],
      ["nice -n 5 rm hooks/a", "nice -n 5 cat hooks/a"],
      ["nice -10 rm hooks/a", "nice -10 cat hooks/a"],
      ["timeout 5 rm hooks/a", "timeout 5 cat hooks/a"],
      ["timeout -s KILL -k 2 5s rm hooks/a", "timeout -s KILL -k 2 5s cat hooks/a"],
      ["xargs -n 1 -I{} rm hooks/a", "xargs -n 1 -I{} cat hooks/a"],
      ["exec -a name rm hooks/a", "exec -a name cat hooks/a"],
      ["command -p rm hooks/a", "command -p cat hooks/a"],
      ["nohup sudo -u root env -i nice -n 1 rm hooks/a",
        "nohup sudo -u root env -i nice -n 1 cat hooks/a"],
      ["sudo -u root bash -c 'rm hooks/a'", "sudo -u root bash -c 'cat hooks/a'"],
      ["time -p rm hooks/a", "time -p cat hooks/a"],
      ["doas -u root rm hooks/a", "doas -u root cat hooks/a"],
      ["stdbuf -oL tee hooks/a", "stdbuf -oL grep x hooks/a"],
      ["setsid rm hooks/a", "setsid cat hooks/a"],
      ["builtin command rm hooks/a", "builtin command cat hooks/a"],
      // #258: macOS env -P takes the PATH to search; zsh's precommand words
      ["env -P /usr/bin rm hooks/a", "env -P /usr/bin cat hooks/a"],
      ["noglob rm hooks/a", "noglob cat hooks/a"],
      ["nocorrect tee hooks/a", "nocorrect grep x hooks/a"],
      ["repeat 2 rm hooks/a", "repeat 2 cat hooks/a"],
    ];
    for (const [write, read] of pairs) {
      expect(guard(p, write), write).toBe(2);
      expect(guard(p, read), read).toBe(0);
    }
  });

  it("GNU time -o names a file it writes", () => {
    const p = proj();
    expect(guard(p, "time -o hooks/a ls")).toBe(2);
    expect(guard(p, "time -o /tmp/t.txt cat hooks/a")).toBe(0);
  });

  it("any shell flag cluster carrying c runs its string as a command", () => {
    const p = proj();
    const pairs: Array<[write: string, read: string]> = [
      ["bash -lc 'echo x > hooks/a'", "bash -lc 'cat hooks/a'"],
      ["bash -ic 'rm hooks/a'", "bash -ic 'cat hooks/a'"],
      ["sh -ec 'rm hooks/a'", "sh -ec 'cat hooks/a'"],
      ["bash -l -c 'rm hooks/a'", "bash -l -c 'cat hooks/a'"],
      ["bash -o pipefail -c 'rm hooks/a'", "bash -o pipefail -c 'cat hooks/a'"],
      ["zsh -xc 'tee hooks/a'", "zsh -xc 'grep x hooks/a'"],
    ];
    for (const [write, read] of pairs) {
      expect(guard(p, write), write).toBe(2);
      expect(guard(p, read), read).toBe(0);
    }
  });

  it("a shell with no -c never reads a script path as its command string", () => {
    const p = proj();
    // Before #254, a missing -c made indexOf return -1 and the guard computed
    // args[0] as the inner command (a later includes("-c") check kept it
    // unused). The string is now only looked for once a -c cluster is seen.
    for (const c of [
      "bash hooks/scripts/check.sh",
      "sh -x hooks/scripts/check.sh 'rm hooks/a'",
      "bash -o pipefail hooks/scripts/check.sh",
    ]) {
      expect(guard(p, c), c).toBe(0);
    }
  });
});

/** Writes a patch touching `target` into the fixture; returns its name. */
function patchFile(projectDir: string, name: string, target: string): string {
  writeFileSync(join(projectDir, name), [
    `diff --git a/${target} b/${target}`,
    `--- a/${target}`,
    `+++ b/${target}`,
    "@@ -1 +1 @@",
    "-{}",
    "+{\"hooks\":{}}",
    "",
  ].join("\n"));
  return name;
}

describe("harness guard sees folder targets, downloads, archives and patches (#265)", () => {
  // Each row: [a write the sweep recorded as passing, the everyday READ of
  // the same path]. The write must now be refused; the read must still pass.
  it("a copy or move whose destination is a protected folder is a write into it", () => {
    const p = proj();
    const pairs: Array<[write: string, read: string]> = [
      ["cp -r payload/* hooks/", "cp -r hooks/ /tmp/hooks-review"],
      ["cp settings.json .claude/", "cp .claude/settings.json /tmp/settings-review.json"],
      ["cp settings.json .claude", "ls .claude"],
      [`cp settings.json ${p}/.claude/`, `cat ${p}/.claude/settings.json`],
      ["mv /tmp/evil hooks", "ls hooks"],
      ["rsync -a payload/ hooks/", "rsync -a hooks/ /tmp/hooks-review/"],
      ["install -m 644 x.json .claude/", "install -m 644 .claude/settings.json /tmp/s.json"],
      ["ln -s /tmp/evil hooks", "ln -s hooks/hooks.json /tmp/hooks-link"],
      ["cp -t hooks /tmp/a /tmp/b", "cp -t /tmp/review hooks/hooks.json"],
      ["cp /tmp/x/settings.json sub/.claude/", "cp sub/.claude/settings.json /tmp/"],
    ];
    for (const [write, read] of pairs) {
      expect(guard(p, write), write).toBe(2);
      expect(guard(p, read), read).toBe(0);
    }
  });

  it("a copy into the project root that brings its own hooks or settings is refused", () => {
    const p = proj();
    for (const c of [
      "cp -r payload/* .",       // `*` can expand to hooks
      "rsync -a payload/ .",     // the folder's contents, dotfiles and all
      "cp -r /tmp/x/. .",
      "cp -r /tmp/x/hooks .",    // lands as ./hooks
      "cp /tmp/x/.mcp.json .",   // lands as ./.mcp.json
      "ln -s /tmp/x/.mcp.json",  // one operand: a link of that name, here
    ]) {
      expect(guard(p, c), c).toBe(2);
    }
    // ...while ordinary copies into ordinary folders pass
    for (const c of [
      "cp notes.md docs/", "cp payload/*.md docs/", "rsync -a src/ dist/",
      "rsync -av --exclude hooks src/ dist/", "mv a.txt docs/", "git mv foo.txt .",
      "ln -s ../shared/lib.mjs lib.mjs",
    ]) {
      expect(guard(p, c), c).toBe(0);
    }
  });

  it("removing a protected folder, or a folder holding one, is refused", () => {
    const p = proj();
    const pairs: Array<[write: string, read: string]> = [
      ["rm -rf hooks/", "ls -la hooks/"],
      ["rm -rf hooks", "du -sh hooks"],
      ["rm -r .claude", "ls -la .claude"],
      ["rmdir hooks", "test -d hooks"],
      ["rm -rf .", "ls -la ."],
      ["rm -rf ..", "ls .."],
      ["rm -rf *", "ls *"],
      ["mv hooks /tmp/old-hooks", "cp -r hooks /tmp/hooks-copy"],
      ["git rm -r hooks", "git log -- hooks"],
      ["chmod 000 hooks", "stat hooks"],
    ];
    for (const [write, read] of pairs) {
      expect(guard(p, write), write).toBe(2);
      expect(guard(p, read), read).toBe(0);
    }
    // cleaning an ordinary folder is ordinary work
    for (const c of ["rm -rf build/", "rm -rf node_modules dist", "rm -f *.log", "mkdir -p .claude"]) {
      expect(guard(p, c), c).toBe(0);
    }
  });

  it("a wildcard that can expand to a protected file is refused", () => {
    const p = proj();
    for (const c of ["rm -f .claude/*.json", "rm .c*/settings.json", "rm -f .claude-plugin/*.json"]) {
      expect(guard(p, c), c).toBe(2);
    }
    for (const c of ["rm -f *.json", "rm -f docs/*.md", "cat .claude/*.json"]) {
      expect(guard(p, c), c).toBe(0);
    }
  });

  it("downloaders that save into protected paths are refused", () => {
    const p = proj();
    const pairs: Array<[write: string, read: string]> = [
      ["curl -sSLo hooks/hooks.json https://example.com/h", "curl -sSL https://example.com/h -o /tmp/h"],
      ["curl -o .claude/settings.json https://example.com/s", "curl -s https://example.com/s | head"],
      ["curl --output=hooks/a https://example.com/a", "curl --output=/tmp/a https://example.com/a"],
      ["curl -O --output-dir hooks https://example.com/a.json",
        "curl -O --output-dir /tmp https://example.com/a.json"],
      ["curl -O https://example.com/.mcp.json", "curl -O https://example.com/archive.tgz"],
      ["wget -O hooks/hooks.json https://example.com/h", "wget -O - https://example.com/h"],
      ["wget -P hooks https://example.com/a.json", "wget -q -P /tmp https://example.com/a.json"],
      ["curl -c .claude/settings.json https://example.com/", "curl -b /tmp/jar https://example.com/"],
    ];
    for (const [write, read] of pairs) {
      expect(guard(p, write), write).toBe(2);
      expect(guard(p, read), read).toBe(0);
    }
  });

  it("archive extractors aimed at a protected folder are refused", () => {
    const p = proj();
    const pairs: Array<[write: string, read: string]> = [
      ["tar -xzf a.tgz -C hooks", "tar -xzf a.tgz -C /tmp/out"],
      ["tar xzf a.tgz -C .claude", "tar tzf a.tgz"],
      ["tar --extract --file=a.tar --directory=hooks", "tar --list --file=a.tar"],
      ["tar -xf a.tar hooks/hooks.json", "tar -tf a.tar hooks/hooks.json"],
      ["tar -czf hooks/hooks.json src", "tar -czf /tmp/hooks.tgz hooks"],
      ["unzip a.zip -d hooks", "unzip a.zip -d /tmp/out"],
      ["unzip -o a.zip -d .claude", "unzip -l a.zip"],
    ];
    for (const [write, read] of pairs) {
      expect(guard(p, write), write).toBe(2);
      expect(guard(p, read), read).toBe(0);
    }
  });

  it("patch tools are refused for the files their patch names, and pass for ordinary ones", () => {
    const p = proj();
    patchFile(p, "evil.patch", "hooks/hooks.json");
    patchFile(p, "settings.patch", ".claude/settings.json");
    patchFile(p, "ok.patch", "src/a.ts");
    const pairs: Array<[write: string, read: string]> = [
      ["git apply evil.patch", "git apply ok.patch"],
      ["git apply settings.patch", "git apply --check settings.patch"],
      ["patch -p1 < evil.patch", "patch -p1 < ok.patch"],
      ["patch -p1 -i settings.patch", "patch --dry-run -p1 -i settings.patch"],
      ["patch hooks/hooks.json < ok.patch", "patch -o /tmp/out.json hooks/hooks.json < ok.patch"],
      ["patch -d hooks -p1 < /tmp/unseen.diff", "patch -d src -p1 < /tmp/unseen.diff"],
      ["git apply <<'EOF'\n--- a/hooks/hooks.json\n+++ b/hooks/hooks.json\nEOF",
        "git apply --stat <<'EOF'\n--- a/hooks/hooks.json\n+++ b/hooks/hooks.json\nEOF"],
    ];
    for (const [write, read] of pairs) {
      expect(guard(p, write), write).toBe(2);
      expect(guard(p, read), read).toBe(0);
    }
  });

  it("a device named as a patch or input is never read, so the guard can't be hung open", () => {
    const p = proj();
    // reading /dev/zero would run the hook past its timeout -- and a timed-out
    // guard lets the whole line through, the rm included
    for (const c of [
      "rm hooks/hooks.json; git apply /dev/zero",
      "rm hooks/hooks.json; patch -p1 < /dev/zero",
      "rm hooks/hooks.json; patch -p1 -i /dev/urandom",
    ]) {
      expect(guard(p, c), c).toBe(2);
    }
    expect(guard(p, "git apply /dev/zero")).toBe(0);
  });

  it("the inline override exempts only the command it prefixes, not the chained rest", () => {
    const p = proj();
    // the sweep's recorded bypass: one prefix used to clear the whole line
    for (const c of [
      "CAIRN_HARNESS_EDIT=1 cp a hooks/x && cp b hooks/y",
      "CAIRN_HARNESS_EDIT=1 true; rm -rf .claude",
      "CAIRN_HARNESS_EDIT=1 cat x | tee hooks/a",
      "CAIRN_HARNESS_EDIT=1; rm hooks/a",       // a bare assignment prefixes nothing
      "env CAIRN_HARNESS_EDIT=1 rm hooks/a",    // the prefix form only, as before
      "bash -c 'CAIRN_HARNESS_EDIT=1 rm hooks/a'", // on the command typed, not inside a string
    ]) {
      expect(guard(p, c), c).toBe(2);
    }
    for (const c of [
      "CAIRN_HARNESS_EDIT=1 cp a hooks/x",
      "CAIRN_HARNESS_EDIT=1 cp a hooks/x && npm test",
      "X=1 CAIRN_HARNESS_EDIT=1 rm hooks/a",
      "CAIRN_HARNESS_EDIT=1 bash -c 'rm hooks/a; rm hooks/b'",
    ]) {
      expect(guard(p, c), c).toBe(0);
    }
  });
});

describe("harness guard sees su, find, xargs, cwd and heredoc writes (#258)", () => {
  it("su runs its -c string as a command, wherever the -c sits", () => {
    const p = proj();
    const pairs: Array<[write: string, read: string]> = [
      ["su -c 'rm hooks/hooks.json'", "su -c 'cat hooks/hooks.json'"],
      ["su - root -c 'echo x > .claude/settings.json'", "su - root -c 'cat .claude/settings.json'"],
      ["su root -c 'rm -rf hooks'", "su root -c 'ls hooks'"],
      ["su --command='cp x hooks/a'", "su --command='cp hooks/a /tmp/x'"],
      ["sudo su -lc 'tee hooks/a'", "sudo su -lc 'grep x hooks/a'"],
      ["su -s /bin/sh -c 'rm hooks/a' root", "su -s /bin/sh -c 'cat hooks/a' root"],
      ["su - root <<'EOF'\nrm hooks/hooks.json\nEOF", "su - root <<'EOF'\nls hooks\nEOF"],
    ];
    for (const [write, read] of pairs) {
      expect(guard(p, write), write).toBe(2);
      expect(guard(p, read), read).toBe(0);
    }
  });

  it("find acts on what it walks: -delete and -exec are writes there", () => {
    const p = proj();
    const pairs: Array<[write: string, read: string]> = [
      ["find hooks -delete", "find hooks -name '*.json'"],
      ["find hooks -name '*.bak' -delete", "find hooks -name '*.bak'"],
      ["find . -name hooks.json -delete", "find . -name hooks.json"],
      ["find . -name '*.json' -delete", "find . -name '*.pyc' -delete"],
      ["find . -type f -delete", "find . -type f"],
      ["find . ! -name '*.md' -delete", "find . ! -name '*.md'"],
      ["find . -path './hooks/*' -delete", "find . -path './node_modules/*' -delete"],
      ["find .claude -name 'settings*.json' -exec rm {} +", "find .claude -name '*.md' -exec rm {} +"],
      ["find hooks -type f -exec sed -i 's/a/b/' {} \\;", "find hooks -type f -exec grep -l x {} \\;"],
      ["find hooks -exec cp /tmp/evil {} \\;", "find src -exec cp /tmp/evil {} \\;"],
      ["find hooks -exec sh -c 'rm \"$1\"' _ {} \\;", "find hooks -exec sh -c 'cat \"$1\"' _ {} \\;"],
      ["find . -name '*.log' -fprint hooks/list.txt", "find . -name '*.log' -fprint /tmp/list.txt"],
    ];
    for (const [write, read] of pairs) {
      expect(guard(p, write), write).toBe(2);
      expect(guard(p, read), read).toBe(0);
    }
    // copying what find walks to somewhere else is a read of it
    expect(guard(p, "find . -name '*.json' -exec cp {} /tmp/backup/ \\;")).toBe(0);
  });

  it("find's name tests are checked against what hooks/ really holds", () => {
    const p = proj();
    expect(guard(p, "find . -name '*.mjs' -delete")).toBe(0);
    mkdirSync(join(p, "hooks", "scripts"), { recursive: true });
    writeFileSync(join(p, "hooks", "scripts", "check.mjs"), "");
    expect(guard(p, "find . -name '*.mjs' -delete")).toBe(2);
    expect(guard(p, "find . -name '*.mjs'")).toBe(0);
  });

  it("paths piped to xargs are checked against what feeds the pipe", () => {
    const p = proj();
    writeFileSync(join(p, "list.txt"), "hooks/hooks.json\n");
    const pairs: Array<[write: string, read: string]> = [
      ["ls hooks/* | xargs rm", "ls hooks/* | xargs cat"],
      ["echo hooks/hooks.json | xargs rm", "echo src/a.ts | xargs rm"],
      ["echo .claude/settings.json | xargs -I{} cp /tmp/evil {}", "echo src/a.ts | xargs -I{} cp /tmp/evil {}"],
      ["find hooks -type f | xargs rm", "find hooks -type f | xargs wc -l"],
      ["find . -name '*.json' -print0 | xargs -0 rm", "find . -name '*.pyc' -print0 | xargs -0 rm"],
      ["printf '%s\\n' hooks/a hooks/b | xargs -n1 rm -f", "printf '%s\\n' src/a src/b | xargs -n1 rm -f"],
      ["git ls-files hooks | xargs sed -i 's/a/b/'", "git ls-files src | xargs sed -i 's/a/b/'"],
      ["xargs rm <<'EOF'\nhooks/hooks.json\nEOF", "xargs cat <<'EOF'\nhooks/hooks.json\nEOF"],
      ["xargs rm < list.txt", "xargs cat < list.txt"],
      ["xargs -a list.txt rm", "xargs -a list.txt cat"],
      ["echo hooks/a | xargs -I{} sh -c 'rm {}'", "echo src/a | xargs -I{} sh -c 'rm {}'"],
      ["echo hooks/a | xargs sh -c 'rm \"$@\"' _", "echo src/a | xargs sh -c 'rm \"$@\"' _"],
      ["ls hooks | xargs -I{} sh -c 'rm hooks/{}'", "ls hooks | xargs -I{} sh -c 'cat hooks/{}'"],
    ];
    for (const [write, read] of pairs) {
      expect(guard(p, write), write).toBe(2);
      expect(guard(p, read), read).toBe(0);
    }
  });

  it("a patch piped in is read through the pipe, or checked against what feeds it", () => {
    const p = proj();
    patchFile(p, "evil.patch", "hooks/hooks.json");
    patchFile(p, "ok.patch", "src/a.ts");
    const pairs: Array<[write: string, read: string]> = [
      ["cat evil.patch | patch -p1", "cat ok.patch | patch -p1"],
      ["cat evil.patch | git apply", "cat ok.patch | git apply"],
      ["git diff hooks/ | git apply -R", "git diff src/ | git apply -R"],
      ["git show HEAD -- .claude/settings.json | patch -p1 -R", "git show HEAD -- src/a.ts | patch -p1 -R"],
    ];
    for (const [write, read] of pairs) {
      expect(guard(p, write), write).toBe(2);
      expect(guard(p, read), read).toBe(0);
    }
  });

  it("relative paths resolve from the payload cwd, not the project root", () => {
    const p = proj();
    const cases: Array<[command: string, cwd: string, want: number]> = [
      ["echo x > hooks.json", "hooks", 2], ["cat hooks.json", "hooks", 0], ["echo x > hooks.json", "src", 0],
      ["rm -rf scripts", "hooks", 2], ["rm -rf scripts", "src", 0],
      ["echo x > settings.json", ".claude", 2], ["echo x > notes.md", ".claude", 0],
      ["curl -O https://example.com/hooks.json", "hooks", 2], ["curl -O https://example.com/a.tgz", "src", 0],
      ["tar -xzf /tmp/a.tgz", "hooks", 2], ["tar -xzf /tmp/a.tgz", "src", 0],
      ["unzip /tmp/a.zip", ".claude", 2], ["unzip /tmp/a.zip", "src", 0],
      ["patch -p1 < /tmp/unseen.diff", "hooks", 2], ["patch -p1 < /tmp/unseen.diff", "src", 0],
      // a worktree's own hooks/ is not the project's
      ["echo x > hooks/hooks.json", ".claude/worktrees/wt", 0],
    ];
    for (const [command, cwd, want] of cases) expect(guard(p, command, cwd), `${cwd}: ${command}`).toBe(want);
  });

  it("the file tools resolve a relative path from the payload cwd too", () => {
    const p = proj();
    expect(call(p, "Edit", { file_path: "hooks.json" }, "hooks")).toBe(2);
    expect(call(p, "Write", { file_path: "settings.json" }, ".claude")).toBe(2);
    expect(call(p, "Edit", { file_path: "hooks.json" }, "src")).toBe(0);
    expect(call(p, "Write", { file_path: join(p, ".claude/worktrees/wt/hooks/hooks.json") }, ".claude/worktrees/wt"))
      .toBe(0);
  });

  it("a cd in the line adds where relative paths can land", () => {
    const p = proj();
    const pairs: Array<[write: string, read: string]> = [
      ["cd hooks && echo x > hooks.json", "cd hooks && cat hooks.json"],
      ["cd hooks; rm -f hooks.json", "cd src; rm -f hooks.json"],
      ["cd /tmp && cd - && echo x > hooks/hooks.json", "cd /tmp && echo x > out.log"],
      ["pushd hooks && rm hooks.json", "pushd hooks && popd && cat hooks.json"],
      ["(cd hooks && echo x > hooks.json)", "(cd hooks && cat hooks.json)"],
      ["(rm hooks/hooks.json)", "(cat hooks/hooks.json)"],
      ["git -C hooks checkout -- hooks.json", "git -C hooks diff -- hooks.json"],
    ];
    for (const [write, read] of pairs) {
      expect(guard(p, write), write).toBe(2);
      expect(guard(p, read), read).toBe(0);
    }
    expect(guard(p, "cd .. && rm -rf hooks", "src")).toBe(2);
    expect(guard(p, "cd src && cd .. && echo x > hooks.json")).toBe(0);
  });

  it("a cd never takes a folder away: it can fail, be skipped, run in a subshell or run later (#258)", () => {
    const p = proj();
    // v2.8.1 judged every relative write from the project root and refused
    // these; tracking the cds in order let them through, while the write
    // really lands in the project's hooks/
    const pairs: Array<[write: string, read: string]> = [
      ["cd /nonexistent-cairn; echo x > hooks/hooks.json", "cd /nonexistent-cairn; echo x > out.txt"],
      ["false && cd /tmp; echo x > hooks/hooks.json", "false && cd /tmp; echo x > out.txt"],
      ["true || cd /tmp; rm hooks/hooks.json", "true || cd /tmp; rm out.txt"],
      ["(cd /tmp); echo x > hooks/hooks.json", "(cd /tmp); echo x > out.txt"],
      ["true | cd /tmp; tee hooks/hooks.json", "true | cd /tmp; tee out.txt"],
      ["cd /tmp & echo x > hooks/hooks.json", "cd /tmp & echo x > out.txt"],
      ["env cd /tmp && echo x > hooks/hooks.json", "env cd /tmp && echo x > out.log"],
      ["sudo cd /tmp && rm hooks/hooks.json", "sudo cd /tmp && rm out.log"],
      ["if true; then :; else cd /tmp; fi; echo x > hooks/hooks.json", "if true; then :; else cd /tmp; fi; echo x > a"],
      // a body runs later: the write before the cd still sees where it lands
      ["f() { echo x > hooks.json; }; cd hooks; f", "f() { echo x > hooks.json; }; cd src; f"],
      ["function f { rm hooks.json; }; cd hooks; f", "function f { cat hooks.json; }; cd hooks; f"],
    ];
    for (const [write, read] of pairs) {
      expect(guard(p, write), write).toBe(2);
      expect(guard(p, read), read).toBe(0);
    }
    // ...and runs again: a loop or function body's cd keeps applying
    mkdirSync(join(p, "src", "a"), { recursive: true });
    expect(guard(p, "for i in 1 2; do cd ..; done; echo x > hooks/hooks.json", "src/a")).toBe(2);
    expect(guard(p, "f() { cd ..; }; f; f; rm hooks/hooks.json", "src/a")).toBe(2);
    expect(guard(p, "for i in 1 2; do cd ..; done; cat hooks/hooks.json", "src/a")).toBe(0);
    // CDPATH, set on the line, is somewhere else a bare cd target can land
    expect(guard(p, "CDPATH=.. cd hooks && echo x > hooks.json", "src")).toBe(2);
    expect(guard(p, "CDPATH=.. cd hooks && cat hooks.json", "src")).toBe(0);
  });

  it("a heredoc or here-string fed to a shell is read as commands", () => {
    const p = proj();
    const pairs: Array<[write: string, read: string]> = [
      ["bash <<EOF\nrm hooks/hooks.json\nEOF", "bash <<EOF\ncat hooks/hooks.json\nEOF"],
      ["sh <<'X'\necho x > .claude/settings.json\nX", "sh <<'X'\ngrep x .claude/settings.json\nX"],
      ["bash -s <<'EOF'\ncp /tmp/evil hooks/hooks.json\nEOF", "bash -s <<'EOF'\ncp hooks/hooks.json /tmp/x\nEOF"],
      ["cat <<'EOF' | sh\nrm -rf hooks\nEOF", "cat <<'EOF' | sh\nls hooks\nEOF"],
      ["bash <<< 'rm hooks/hooks.json'", "bash <<< 'ls hooks'"],
    ];
    for (const [write, read] of pairs) {
      expect(guard(p, write), write).toBe(2);
      expect(guard(p, read), read).toBe(0);
    }
    // ...but a heredoc handed to anything else, or to a script, stays data
    for (const c of [
      "cat <<'EOF' > notes.md\nrm hooks/hooks.json\nEOF",
      "bash hooks/scripts/check.sh <<'EOF'\nrm hooks/a\nEOF",
      "git commit -F - <<'EOF'\nfix: rm hooks/hooks.json wording\nEOF",
    ]) {
      expect(guard(p, c), c).toBe(0);
    }
  });
});

describe("harness guard reads the command after shell keywords and grouping words (#285)", () => {
  it("a write after a shell keyword or grouping word is still a write (#285)", () => {
    const p = proj();
    const pairs: Array<[write: string, read: string]> = [
      ["{ rm hooks/hooks.json; }", "{ cat hooks/hooks.json; }"],
      ["if true; then rm hooks/hooks.json; fi", "if true; then cat hooks/hooks.json; fi"],
      ["if tee hooks/hooks.json; then :; fi", "if git status; then :; fi"],
      ["! rm hooks/hooks.json", "! cat hooks/hooks.json"],
      ["while true; do echo x > hooks/hooks.json; done", "while true; do cat hooks/hooks.json; done"],
      ["for f in a; do rm hooks/hooks.json; done", "for f in *; do cat \"$f\"; done"],
      ["case x in x) rm -rf hooks;; esac", "case x in x) ls hooks;; esac"],
      ["function f { rm hooks/hooks.json; }", "function f { cat hooks/hooks.json; }"],
      ["time { rm hooks/hooks.json; }", "time { cat hooks/hooks.json; }"],
      ["coproc rm hooks/hooks.json", "coproc cat hooks/hooks.json"],
      ["echo hooks/hooks.json | xargs --replace rm {}", "xargs --replace echo {}"],
      ["echo hooks/hooks.json | xargs -iP rm P", "echo src/a | xargs -iP rm P"],
      ["echo hooks/hooks.json | xargs --eof rm", "echo src/a | xargs --eof rm"],
      ["ls | xargs -J % cp % hooks/", "ls | xargs -J % cp % src/"],
    ];
    for (const [write, read] of pairs) {
      expect(guard(p, write), write).toBe(2);
      expect(guard(p, read), read).toBe(0);
    }
    // a loop's word list is data: naming a protected path there writes nothing
    expect(guard(p, "for f in hooks/*; do echo \"$f\"; done")).toBe(0);
  });

  it("a cd behind a keyword may never run, so it never moves a write out of a protected folder (#285)", () => {
    const p = proj();
    for (const c of [
      "if false; then cd /tmp; fi; echo x > hooks/hooks.json",
      "while false; do cd /tmp; done; echo x > hooks/hooks.json",
      "f() { cd /tmp; }; echo x > hooks/hooks.json",
      "{ cd /tmp; } | cat; echo x > hooks/hooks.json",
      "coproc cd /tmp; echo x > hooks/hooks.json",
    ]) {
      expect(guard(p, c), c).toBe(2);
    }
  });
});

describe("harness guard follows the cd targets it can know and fails closed on the rest (#258)", () => {
  /** The guard's refusal text for one Bash command string. */
  function stderrOf(projectDir: string, command: string): string {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
    delete env.CAIRN_HARNESS_EDIT;
    delete env.CDPATH;
    return spawnSync(process.execPath, [HARNESSGUARD], {
      cwd: projectDir, env, encoding: "utf8", timeout: 5000,
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: "" }),
    }).stderr ?? "";
  }

  it("$PWD, $HOME and ~ resolve to the folders the guard tracks; $OLDPWD is unknown", () => {
    const p = proj();
    const pairs: Array<[write: string, read: string]> = [
      ["cd $PWD/hooks && echo x > hooks.json", "cd $PWD/hooks && cat hooks.json"],
      ["cd ${PWD}/hooks && rm hooks.json", "cd ${PWD}/src && rm hooks.json"],
      ["cd ~+/hooks && tee hooks.json", "cd ~+/src && tee hooks.json"],
      // any cd before may have failed, leaving whatever $OLDPWD the shell had
      ["cd /tmp && cd $OLDPWD && echo x > out.txt", "cd /tmp && cd $OLDPWD && cat out.txt"],
      ["cd /tmp && cd ~- && rm hooks/hooks.json", "cd /tmp && cd ~- && cat hooks/hooks.json"],
      ["cd ~ && echo x > .claude/settings.json", "cd ~ && echo x > notes.txt"],
      ["cd $HOME && rm .claude/settings.json", "cd $HOME && cat .claude/settings.json"],
    ];
    for (const [write, read] of pairs) {
      expect(guard(p, write), write).toBe(2);
      expect(guard(p, read), read).toBe(0);
    }
  });

  it("$PWD, $HOME, ~ and brace lists in a write path are spelled out the way the shell does", () => {
    const p = proj();
    const pairs: Array<[write: string, read: string]> = [
      ["echo x > $PWD/hooks/hooks.json", "echo x > $PWD/src/out.txt"],
      ["echo x > ${PWD}/.mcp.json", "cat ${PWD}/.mcp.json"],
      ["cd src && rm $PWD/../hooks/hooks.json", "cd src && rm $PWD/out.txt"],
      ["rm -rf ~", "rm -rf ~/cairn-guard-scratch"],
      ["rm -rf $HOME", "ls $HOME"],
      ["echo x > ~/.claude/settings.json", "cat ~/.claude/settings.json"],
      ["rm -rf {hooks,}", "rm -rf {build,dist}"],
      ["cp {/tmp/evil,hooks/hooks.json}", "cp {/tmp/evil,src/a.ts}"],
      ["touch hook{r..t}/x", "touch src{1..3}"],
      ["echo x > .{mcp,other}.json", "echo x > {a,b}.log"],
    ];
    for (const [write, read] of pairs) {
      expect(guard(p, write), write).toBe(2);
      expect(guard(p, read), read).toBe(0);
    }
  });

  it("a cd target it can't resolve refuses later relative writes, saying why", () => {
    const p = proj();
    mkdirSync(join(p, "src"));
    mkdirSync(join(p, "scripts"));
    for (const c of [
      "d=hooks; cd $d && echo x > hooks.json",
      "cd \"$d\" && echo x > out.txt",
      "cd $(echo hooks) && echo x > hooks.json",
      "cd `echo hooks` && echo x > hooks.json",
      "cd \"$(git rev-parse --show-toplevel)\" && touch a",
      "cd ${X:-hooks} && rm -f hooks.json",
      "cd ~someone && echo x > a",
      "cd {hooks,} && echo x > hooks.json",
      "cd s* && echo x > out.txt", // src and scripts: two matches
      "cd - && echo x > out.txt", // no cd yet: $OLDPWD is whatever the shell had
      "pushd +1 && echo x > a",
      "cd \"$d\" && rm -rf ../../hooks",
      "cd \"$d\" && find . -name '*.tmp' -delete",
      "echo x > out.txt; cd \"$d\"", // in any order: a function or loop could run the write after
      "cd \"$d\" && ls | xargs rm",
      "env -C \"$d\" rm hooks.json",
      "if true; then cd \"$d\"; fi; echo x > out.txt",
    ]) {
      expect(guard(p, c), c).toBe(2);
      expect(stderrOf(p, c), c).toContain("goes somewhere the guard couldn't tell");
    }
  });

  it("...but reads, writes to absolute paths, and commands that write nothing pass", () => {
    const p = proj();
    for (const c of [
      "cd \"$d\" && npm test",
      "cd \"$d\" && cat hooks.json",
      "cd \"$d\" && git status && ls -la",
      "cd \"$d\" && echo x > /tmp/out.txt",
      "cd \"$d\" && find /tmp/cairn-none -delete",
      "cd \"$d\" 2>/dev/null && grep -r foo . > /dev/null",
    ]) {
      expect(guard(p, c), c).toBe(0);
    }
    // an absolute write is judged as itself, lost folder or not
    const abs = `cd "$d" && echo x > ${join(p, "hooks", "hooks.json")}`;
    expect(guard(p, abs)).toBe(2);
    expect(stderrOf(p, abs)).toContain("this would change the hook directory");
    // a later absolute cd doesn't make the lost folder known again: either cd can fail
    expect(guard(p, "cd \"$d\" && cd /tmp && echo x > notes.txt")).toBe(2);
  });

  it("a wildcard cd target with one match is followed there", () => {
    const p = proj();
    mkdirSync(join(p, "hooks"));
    mkdirSync(join(p, "src"));
    expect(guard(p, "cd h*s && echo x > hooks.json")).toBe(2);
    expect(guard(p, "cd sr? && echo x > hooks.json")).toBe(0);
  });

  it("env -C and sudo -D run the wrapped command in their folder; the shell's redirects stay put", () => {
    const p = proj();
    const pairs: Array<[write: string, read: string]> = [
      ["env -C hooks sh -c 'echo x > hooks.json'", "env -C hooks sh -c 'cat hooks.json'"],
      ["env -C hooks rm hooks.json", "env -C hooks cat hooks.json"],
      ["env --chdir=hooks tee hooks.json", "env --chdir=src tee hooks.json"],
      ["env --chdir hooks rm hooks.json", "env --chdir hooks wc -l hooks.json"],
      ["sudo -D hooks rm hooks.json", "sudo -D hooks cat hooks.json"],
      ["sudo --chdir=hooks rm hooks.json", "sudo --chdir=src rm hooks.json"],
      ["env -C hooks time -o hooks.json true", "env -C src time -o hooks.json true"],
      ["env -C src true > hooks/a", "env -C src true > out.txt"],
    ];
    for (const [write, read] of pairs) {
      expect(guard(p, write), write).toBe(2);
      expect(guard(p, read), read).toBe(0);
    }
    // the write lands under /tmp, not in the project's hooks/
    expect(guard(p, "env -C /tmp rm hooks/a")).toBe(0);
    // an env -C folder is one more place the line's other relative writes are judged from
    expect(guard(p, "env -C hooks true > out.txt")).toBe(2);
  });

  it("a cd behind a keyword may have moved the shell -- or not", () => {
    const p = proj();
    const pairs: Array<[write: string, read: string]> = [
      ["{ cd hooks; echo x > hooks.json; }", "{ cd hooks; cat hooks.json; }"],
      ["if cd hooks; then echo x > hooks.json; fi", "if cd hooks; then cat hooks.json; fi"],
      ["if true; then cd /tmp; fi; echo x > hooks/hooks.json", "if true; then cd /tmp; fi; echo x > out.txt"],
    ];
    for (const [write, read] of pairs) {
      expect(guard(p, write), write).toBe(2);
      expect(guard(p, read), read).toBe(0);
    }
  });
});

describe("harness guard refusals stop coaching the override (#286)", () => {
  /** Exit status and refusal text for one Bash command string. */
  function refusal(projectDir: string, command: string): { status: number | null; stderr: string } {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
    delete env.CAIRN_HARNESS_EDIT;
    delete env.CDPATH;
    const r = spawnSync(process.execPath, [HARNESSGUARD], {
      cwd: projectDir, env, encoding: "utf8", timeout: 5000,
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: "" }),
    });
    return { status: r.status, stderr: r.stderr ?? "" };
  }

  // One command per kind of refusal: a wrapper, a folder copy, a removal, a
  // wildcard, a download, an archive, find, xargs, su, and a lost cd.
  const REFUSED = [
    "sudo -u root tee hooks/a",
    "cp /tmp/evil.json .claude/",
    "rm -rf .claude",
    "rm .claude/*.json",
    "curl -o hooks/x.sh https://example.com/x.sh",
    "tar -C hooks -xf a.tar",
    "find hooks -name '*.mjs' -delete",
    "echo hooks/hooks.json | xargs rm",
    "su -c 'rm hooks/hooks.json'",
    "cd \"$d\" && echo x > out.txt",
  ];

  it("every kind of refusal names the owner's ways to approve, never a paste-ready prefix", () => {
    const p = proj();
    for (const c of REFUSED) {
      const r = refusal(p, c);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain("needs the owner's go-ahead");
      expect(r.stderr, c).toContain("`!` in your prompt");
      expect(r.stderr, c).toContain("start the session with CAIRN_HARNESS_EDIT set to 1");
      expect(r.stderr, c).toContain("not the owner asking");
      expect(r.stderr, c).not.toContain("CAIRN_HARNESS_EDIT=1");
      expect(r.stderr, c).not.toMatch(/prefix/i);
    }
  });

  it("the inline override is still honoured -- stated nowhere in the refusal, but it works", () => {
    const p = proj();
    // one command each: the prefix exempts only the command it sits on (#265)
    for (const c of REFUSED.filter((x) => !/[|&]/.test(x))) {
      expect(refusal(p, `CAIRN_HARNESS_EDIT=1 ${c}`).status, c).toBe(0);
    }
  });
});
