// Conventional-commit release cutter for Crystal — the dependency-free stand-in
// for `nx release` (Crystal has no nx). Two modes:
//
//   node scripts/release.mjs --dry-run
//       Decide whether a release is due and what the next version is, from the
//       conventional commits since the last v* tag. Changes NOTHING on disk;
//       writes `new_release` / `version` to $GITHUB_OUTPUT when present. The CI
//       `plan` job runs this so reviewers are only asked to approve when a
//       release is actually due (routine docs/chore merges ping no one).
//
//   node scripts/release.mjs
//       Cut the release: bump the version in the tracked manifests, prepend a
//       grouped section to CHANGELOG.md, `git commit` + `git tag vX.Y.Z`
//       locally. It does NOT push — the workflow owns the push credentials and
//       creates the GitHub release. A maintainer can run it by hand too, then
//       `git push --follow-tags`.
//
// Bump rules (conventional commits since the last v* tag):
//   feat                                  → minor
//   fix / perf                            → patch
//   any `type!:` or a `BREAKING CHANGE:`  → major
//   docs/chore/refactor/test/ci/build/…   → no release
// On the 0.x line a breaking change is capped at a minor bump (semver's pre-1.0
// rule) so a stray `!` can't launch the app to 1.0.0. With no prior tag, the
// first release ships the version already in package.json as-is (no bump).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRY_RUN = process.argv.includes("--dry-run");

// Manifests whose version the release bumps. Only two matter: the root (the
// version source this script reads) and the desktop app package.json, which
// tauri.conf.json reads via `"version": "../package.json"` to stamp the bundle.
// Internal packages use `workspace:*` refs, so their versions are irrelevant.
const MANIFESTS = ["package.json", "apps/desktop/package.json"];

const git = (...args) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();

function currentVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  if (!pkg.version) throw new Error("root package.json has no version");
  return pkg.version;
}

function lastTag() {
  try {
    // stderr ignored: "No names found" on a tag-less repo is expected, not an
    // error worth printing into the CI log.
    return execFileSync("git", ["describe", "--tags", "--abbrev=0", "--match", "v*"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
  } catch {
    return null; // no release tag yet
  }
}

/** Parsed commits in (range, HEAD]; range null → whole history. */
function commitsSince(tag) {
  const spec = tag ? `${tag}..HEAD` : "HEAD";
  // %x00 field sep, %x1e record sep — subjects/bodies can contain anything else.
  const raw = git("log", spec, "--no-merges", "--format=%h%x00%s%x00%b%x1e");
  return raw
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash, subject = "", body = ""] = r.split("\x00");
      return { hash, subject, body };
    });
}

/** "major" | "minor" | "patch" | null for one commit. */
function classify({ subject, body }) {
  const m = /^(\w+)(\([^)]*\))?(!)?:/.exec(subject);
  const breaking = (m && m[3] === "!") || /(^|\n)BREAKING[ -]CHANGE:/.test(body);
  if (breaking) return "major";
  const type = m ? m[1] : null;
  if (type === "feat") return "minor";
  if (type === "fix" || type === "perf") return "patch";
  return null;
}

const RANK = { major: 3, minor: 2, patch: 1 };

function highestBump(commits) {
  let best = null;
  for (const c of commits) {
    const lvl = classify(c);
    if (lvl && (!best || RANK[lvl] > RANK[best])) best = lvl;
  }
  return best;
}

function applyBump(version, level) {
  let [maj, min, pat] = version.split(".").map(Number);
  if (level === "major" && maj > 0) return `${maj + 1}.0.0`;
  if (level === "major" || level === "minor") return `${maj}.${min + 1}.0`; // 0.x: breaking → minor
  return `${maj}.${min}.${pat + 1}`;
}

function ghSlug() {
  try {
    const url = git("remote", "get-url", "origin");
    const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}

function changelogSection(version, commits) {
  const groups = [
    ["Features", (c) => /^feat(\(|!|:)/.test(c.subject)],
    ["Bug Fixes", (c) => /^fix(\(|!|:)/.test(c.subject)],
    ["Performance", (c) => /^perf(\(|!|:)/.test(c.subject)],
  ];
  const slug = ghSlug();
  const clean = (s) => s.replace(/^(\w+)(\([^)]*\))?!?:\s*/, "");
  const link = (h) => (slug ? `([\`${h}\`](https://github.com/${slug}/commit/${h}))` : `(\`${h}\`)`);
  const date = new Date().toISOString().slice(0, 10);
  let out = `## v${version} (${date})\n\n`;
  let any = false;
  for (const [title, pred] of groups) {
    const items = commits.filter(pred);
    if (!items.length) continue;
    any = true;
    out += `### ${title}\n\n`;
    for (const c of items) out += `- ${clean(c.subject)} ${link(c.hash)}\n`;
    out += "\n";
  }
  const breaking = commits.filter(
    (c) => /^(\w+)(\([^)]*\))?!:/.test(c.subject) || /(^|\n)BREAKING[ -]CHANGE:/.test(c.body),
  );
  if (breaking.length) {
    any = true;
    out += `### ⚠ BREAKING CHANGES\n\n`;
    for (const c of breaking) out += `- ${clean(c.subject)} ${link(c.hash)}\n`;
    out += "\n";
  }
  if (!any) out += `- Maintenance release.\n\n`;
  return out;
}

function setOutput(kv) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  fs.appendFileSync(
    file,
    Object.entries(kv)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n",
  );
}

// ── main ────────────────────────────────────────────────────────────────────
const tag = lastTag();
const current = currentVersion();
const commits = commitsSince(tag);

let version;
let due;
if (!tag) {
  // First release ever: ship what's in the manifest, don't invent a bump.
  version = current;
  due = commits.length > 0;
} else {
  const level = highestBump(commits);
  due = level != null;
  version = due ? applyBump(current, level) : current;
}

if (DRY_RUN) {
  setOutput({ new_release: String(due), version });
  if (due) console.log(`Release due: v${version} (from ${tag ?? "initial commit"}, ${commits.length} commits)`);
  else console.log(`No release-worthy commits since ${tag} — nothing to release.`);
  process.exit(0);
}

if (!due) {
  console.log("No release due — refusing to cut an empty release.");
  process.exit(0);
}

// Bump the tracked manifests (preserve 2-space indent + trailing newline).
for (const rel of MANIFESTS) {
  const p = path.join(repoRoot, rel);
  const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
  if (pkg.version === version) continue;
  pkg.version = version;
  fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`bumped ${rel} → ${version}`);
}

// Prepend the changelog section.
const clPath = path.join(repoRoot, "CHANGELOG.md");
const header = "# Changelog\n\n";
const existing = fs.existsSync(clPath)
  ? fs.readFileSync(clPath, "utf8").replace(/^# Changelog\n+/, "")
  : "";
fs.writeFileSync(clPath, header + changelogSection(version, commits) + existing);
console.log("updated CHANGELOG.md");

// Commit + tag locally. [skip ci] is defensive: a GITHUB_TOKEN push doesn't
// retrigger workflows, but if the push auth is ever swapped for a PAT/deploy
// key it would — and the re-run would self-terminate at `plan` anyway (the
// chore(release) commit is no-bump), so this is belt-and-suspenders.
git("add", "-A");
git("commit", "-m", `chore(release): v${version} [skip ci]`);
git("tag", "-a", `v${version}`, "-m", `v${version}`);
setOutput({ new_release: "true", version });
console.log(`\nCut v${version}. Push with: git push --follow-tags`);
