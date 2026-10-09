/**
 * Purpose: #254 -- the harness guard must see through a wrapper's own flags
 *   (sudo -u root, env -i, nice -n 5, timeout 5 ...) and through shell flag
 *   clusters that carry -c (bash -lc), the way it did before the #240
 *   rewrite. #265 -- it must see writes that land in a protected folder
 *   (cp/mv/rsync into hooks/ or .claude/, rm -rf of the folder or one
 *   holding it), downloads, extracted archives and applied patches, and the
 *   inline override exempts only the command it prefixes. Every write is
 *   paired with a READ of the same path, so closing a gap never brings back
 *   the #240 false positives. Only command strings are fed to the hook;
 *   nothing is ever run.
 * Author(s): John Reed
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** Exit status of the guard for one Bash command string. */
function guard(projectDir: string, command: string): number | null {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
  delete env.CAIRN_HARNESS_EDIT;
  const r = spawnSync(process.execPath, [HARNESSGUARD], {
    cwd: projectDir,
    env,
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: "" }),
    encoding: "utf8",
    timeout: 5000,
  });
  return r.status;
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
      ["env -C /tmp rm hooks/a", "env -C /tmp cat hooks/a"],
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
