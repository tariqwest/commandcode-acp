#!/usr/bin/env node
/**
 * Create a GitHub release for commandcode-acp and optionally publish to npm.
 *
 * Usage:
 *   node scripts/release.mjs [version] [options]
 *   bun run release [version] [options]
 *   bun run release -- [version] [options]   # bare -- is ignored
 *
 * Examples:
 *   bun run release 0.1.1                    # GitHub release
 *   bun run release 0.2.0 --npm              # + npm publish
 *   bun run release --npm                    # use package.json version
 *   bun run release 0.1.1 --dry-run
 *   bun run release patch --npm              # npm version bump style: patch|minor|major
 *   bun run release 0.1.4 --no-homebrew      # GitHub only (skip tap)
 *
 * Options:
 *   --npm              Publish to npm after creating the GitHub release
 *   --homebrew         Update Homebrew formula (default: on; kept for clarity)
 *   --no-homebrew      Skip Homebrew formula update
 *   --tap OWNER/NAME   Homebrew tap repo (default: tariqwest/homebrew-tap)
 *   --dry-run          Print actions without changing git/npm/GitHub/tap
 *   --skip-checks      Skip bun test / typecheck
 *   --skip-push        Create local tag/commit but do not push (implies no Homebrew;
 *                      formula needs the remote tag tarball)
 *   --draft            Create a draft GitHub release
 *   --prerelease       Mark the GitHub release as prerelease
 *   --yes, -y          Skip interactive confirmation
 *   --notes-file PATH  Use release notes from a file
 *   --generate-notes   Ask gh to auto-generate notes (default when no notes file)
 *   --title TEXT       Override GitHub release title (default: vX.Y.Z)
 *   --otp CODE         npm one-time password for publish
 *   --tag-prefix STR   Git tag prefix (default: v)  e.g. v0.1.1
 *   --help, -h         Show help
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PACKAGE_JSON = path.join(ROOT, "package.json");
const BIN_NAME = "commandcode-acp";

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const BUMP_KINDS = new Set(["patch", "minor", "major", "prepatch", "preminor", "premajor", "prerelease"]);

function usage(exitCode = 0) {
  const text = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  const block = text.match(/\/\*\*([\s\S]*?)\*\//)?.[1] ?? "";
  console.log(
    block
      .split("\n")
      .map((l) => l.replace(/^\s*\*\s?/, "").replace(/^\s*$/, ""))
      .join("\n")
      .trim(),
  );
  process.exit(exitCode);
}

function fail(message, code = 1) {
  console.error(`error: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    versionArg: null,
    npm: false,
    homebrew: true,
    tap: "tariqwest/homebrew-tap",
    dryRun: false,
    skipChecks: false,
    skipPush: false,
    draft: false,
    prerelease: false,
    yes: false,
    notesFile: null,
    generateNotes: true,
    title: null,
    otp: null,
    tagPrefix: "v",
  };

  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (a === "--help" || a === "-h") usage(0);
    if (a === "--npm") {
      opts.npm = true;
      continue;
    }
    if (a === "--homebrew") {
      opts.homebrew = true;
      continue;
    }
    if (a === "--no-homebrew") {
      opts.homebrew = false;
      continue;
    }
    if (a === "--tap") {
      opts.tap = argv[++i];
      if (!opts.tap) fail("--tap requires OWNER/NAME");
      continue;
    }
    if (a.startsWith("--tap=")) {
      opts.tap = a.slice("--tap=".length);
      continue;
    }
    if (a === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (a === "--skip-checks") {
      opts.skipChecks = true;
      continue;
    }
    if (a === "--skip-push") {
      opts.skipPush = true;
      continue;
    }
    if (a === "--draft") {
      opts.draft = true;
      continue;
    }
    if (a === "--prerelease") {
      opts.prerelease = true;
      continue;
    }
    if (a === "--yes" || a === "-y") {
      opts.yes = true;
      continue;
    }
    if (a === "--generate-notes") {
      opts.generateNotes = true;
      continue;
    }
    if (a === "--no-generate-notes") {
      opts.generateNotes = false;
      continue;
    }
    if (a === "--notes-file") {
      opts.notesFile = argv[++i];
      opts.generateNotes = false;
      if (!opts.notesFile) fail("--notes-file requires a path");
      continue;
    }
    if (a.startsWith("--notes-file=")) {
      opts.notesFile = a.slice("--notes-file=".length);
      opts.generateNotes = false;
      continue;
    }
    if (a === "--title") {
      opts.title = argv[++i];
      if (!opts.title) fail("--title requires a value");
      continue;
    }
    if (a.startsWith("--title=")) {
      opts.title = a.slice("--title=".length);
      continue;
    }
    if (a === "--otp") {
      opts.otp = argv[++i];
      if (!opts.otp) fail("--otp requires a code");
      continue;
    }
    if (a.startsWith("--otp=")) {
      opts.otp = a.slice("--otp=".length);
      continue;
    }
    if (a === "--tag-prefix") {
      opts.tagPrefix = argv[++i] ?? "";
      continue;
    }
    if (a.startsWith("--tag-prefix=")) {
      opts.tagPrefix = a.slice("--tag-prefix=".length);
      continue;
    }
    if (a.startsWith("-")) fail(`unknown option: ${a}\nRun with --help for usage.`);
    positionals.push(a);
  }

  if (positionals.length > 1) fail("expected at most one version argument");
  opts.versionArg = positionals[0] ?? null;
  return opts;
}

function run(cmd, args, { cwd = ROOT, stdio = "inherit", env = process.env, input } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    env,
    stdio: input != null ? ["pipe", "inherit", "inherit"] : stdio,
    encoding: "utf8",
    input,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`command failed (${result.status}): ${cmd} ${args.join(" ")}`);
  }
  return result;
}

function capture(cmd, args, { cwd = ROOT, allowFail = false } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFail) {
    const detail = (result.stderr || result.stdout || "").trim();
    fail(
      detail
        ? `command failed (${result.status}): ${cmd} ${args.join(" ")}\n${detail}`
        : `command failed (${result.status}): ${cmd} ${args.join(" ")}`,
    );
  }
  return {
    status: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function requireCmd(cmd) {
  const which = process.platform === "win32" ? "where" : "which";
  const res = spawnSync(which, [cmd], { encoding: "utf8" });
  if (res.status !== 0) fail(`required command not found on PATH: ${cmd}`);
}

function readPackage() {
  return JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8"));
}

function writePackage(pkg) {
  fs.writeFileSync(PACKAGE_JSON, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

function parseSemver(version) {
  const m = SEMVER_RE.exec(version);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
    build: m[5] ?? null,
  };
}

function formatSemver({ major, minor, patch, prerelease, build }) {
  let out = `${major}.${minor}.${patch}`;
  if (prerelease) out += `-${prerelease}`;
  if (build) out += `+${build}`;
  return out;
}

function bumpVersion(current, kind) {
  const parsed = parseSemver(current);
  if (!parsed) fail(`package.json version is not valid semver: ${current}`);

  const next = { ...parsed, build: null };
  switch (kind) {
    case "major":
      next.major += 1;
      next.minor = 0;
      next.patch = 0;
      next.prerelease = null;
      break;
    case "minor":
      next.minor += 1;
      next.patch = 0;
      next.prerelease = null;
      break;
    case "patch":
      next.patch += 1;
      next.prerelease = null;
      break;
    case "premajor":
      next.major += 1;
      next.minor = 0;
      next.patch = 0;
      next.prerelease = "0";
      break;
    case "preminor":
      next.minor += 1;
      next.patch = 0;
      next.prerelease = "0";
      break;
    case "prepatch":
      next.patch += 1;
      next.prerelease = "0";
      break;
    case "prerelease": {
      if (!next.prerelease) {
        next.patch += 1;
        next.prerelease = "0";
      } else if (/^\d+$/.test(next.prerelease)) {
        next.prerelease = String(Number(next.prerelease) + 1);
      } else {
        const parts = next.prerelease.split(".");
        const last = parts[parts.length - 1];
        if (/^\d+$/.test(last)) {
          parts[parts.length - 1] = String(Number(last) + 1);
          next.prerelease = parts.join(".");
        } else {
          next.prerelease = `${next.prerelease}.0`;
        }
      }
      break;
    }
    default:
      fail(`unknown bump kind: ${kind}`);
  }
  return formatSemver(next);
}

function normalizeVersionArg(arg, current) {
  if (!arg) return current;
  if (BUMP_KINDS.has(arg)) return bumpVersion(current, arg);
  const cleaned = arg.startsWith("v") ? arg.slice(1) : arg;
  if (!parseSemver(cleaned)) fail(`invalid version: ${arg}`);
  return cleaned;
}

function git(args, opts) {
  return capture("git", args, opts);
}

function ensureGitReady({ dryRun }) {
  requireCmd("git");
  const inside = git(["rev-parse", "--is-inside-work-tree"], { allowFail: true });
  if (inside.status !== 0 || inside.stdout !== "true") fail("not inside a git repository");

  const dirty = git(["status", "--porcelain"]);
  if (dirty.stdout && !dryRun) {
    fail("working tree is dirty; commit or stash changes before releasing");
  }

  const branch = git(["branch", "--show-current"]).stdout;
  if (branch && branch !== "main" && branch !== "master") {
    console.warn(`warning: current branch is '${branch}' (expected main/master)`);
  }

  return { branch };
}

function ensureTools({ npm }) {
  requireCmd("bun");
  requireCmd("gh");
  if (npm) requireCmd("npm");
}

function ensureGhAuth() {
  const res = capture("gh", ["auth", "status"], { allowFail: true });
  if (res.status !== 0) fail("gh is not authenticated; run `gh auth login`");
}

function ensureNpmAuth() {
  const npm = capture("npm", ["whoami"], { allowFail: true });
  if (npm.status === 0 && npm.stdout) {
    console.log(`npm authenticated as ${npm.stdout}`);
    return;
  }
  fail("not logged in to npm; run `npm login` before --npm");
}

function assertPackagePublishable(pkg) {
  if (pkg.private) fail("package.json has \"private\": true; refusing to publish");
  if (!pkg.name) fail("package.json missing name");
  if (!pkg.version) fail("package.json missing version");
  if (!pkg.license) fail("package.json missing license");
}

function tagExistsLocally(tag) {
  return git(["rev-parse", "-q", "--verify", `refs/tags/${tag}`], { allowFail: true }).status === 0;
}

function tagExistsRemote(tag) {
  const res = git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`], { allowFail: true });
  return res.status === 0 && res.stdout.includes(`refs/tags/${tag}`);
}

function releaseExists(tag) {
  const res = capture("gh", ["release", "view", tag, "--json", "tagName"], { allowFail: true });
  return res.status === 0;
}

async function confirm(promptText, { yes }) {
  if (yes) return true;
  if (!process.stdin.isTTY) fail("refusing to continue non-interactively without --yes");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${promptText} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function step(label) {
  console.log(`\n==> ${label}`);
}

function publishHomebrewFormula({ version, tap, dryRun, tag }) {
  requireCmd("gh");
  const formulaName = "commandcode-acp.rb";
  const genScript = path.join(ROOT, "scripts", "generate-homebrew-formula.mjs");
  if (!fs.existsSync(genScript)) fail(`missing formula generator: ${genScript}`);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "commandcode-acp-brew-"));
  const formulaPath = path.join(tmpRoot, formulaName);

  const genArgs = [genScript, version, "--source", "github", "--write", formulaPath];
  if (dryRun) {
    console.log(`[dry-run] node ${genArgs.join(" ")}`);
  } else {
    run("node", genArgs);
  }

  const tapDir = path.join(tmpRoot, "tap");
  if (dryRun) {
    console.log(`[dry-run] gh repo clone ${tap} ${tapDir} -- --depth 1`);
    console.log(`[dry-run] write Formula/${formulaName}`);
    console.log(`[dry-run] git commit + push on ${tap}`);
    console.log(`[dry-run] formula preview path would be ${formulaPath}`);
    if (fs.existsSync(formulaPath)) {
      console.log(fs.readFileSync(formulaPath, "utf8"));
    }
    return;
  }

  run("gh", ["repo", "clone", tap, tapDir, "--", "--depth", "1"]);
  const destDir = path.join(tapDir, "Formula");
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, formulaName);
  fs.copyFileSync(formulaPath, dest);

  const status = capture("git", ["-C", tapDir, "status", "--porcelain", `Formula/${formulaName}`]);
  if (!status.stdout) {
    console.log("Homebrew formula already up to date");
    return;
  }
  run("git", ["-C", tapDir, "add", `Formula/${formulaName}`]);
  run("git", ["-C", tapDir, "commit", "-m", `formula(commandcode-acp): ${version}`]);
  run("git", ["-C", tapDir, "push", "origin", "HEAD"]);
  const owner = tap.split("/")[0] || "tariqwest";
  console.log(`Homebrew formula updated: https://github.com/${tap}/blob/main/Formula/${formulaName}`);
  console.log(`Install: brew tap ${owner}/tap && brew install commandcode-acp`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  process.chdir(ROOT);

  if (opts.homebrew && opts.skipPush) {
    console.warn("warning: --skip-push disables Homebrew formula update (no remote tag tarball)");
    opts.homebrew = false;
  }

  ensureTools({ npm: opts.npm });
  const { branch } = ensureGitReady({ dryRun: opts.dryRun });
  ensureGhAuth();

  const pkg = readPackage();
  assertPackagePublishable(pkg);
  if (opts.npm && !opts.dryRun) ensureNpmAuth();
  const currentVersion = pkg.version;
  if (!parseSemver(currentVersion)) fail(`package.json version is not valid semver: ${currentVersion}`);

  const version = normalizeVersionArg(opts.versionArg, currentVersion);
  const tag = `${opts.tagPrefix}${version}`;
  const title = opts.title || tag;
  const versionChanged = version !== currentVersion;

  if (opts.notesFile && !fs.existsSync(opts.notesFile)) {
    fail(`notes file not found: ${opts.notesFile}`);
  }

  if (!opts.dryRun) {
    if (tagExistsLocally(tag)) fail(`local tag already exists: ${tag}`);
    if (tagExistsRemote(tag)) fail(`remote tag already exists: ${tag}`);
    if (releaseExists(tag)) fail(`GitHub release already exists: ${tag}`);
  }

  console.log("Release plan");
  console.log(`  package:        ${pkg.name}`);
  console.log(`  branch:         ${branch || "(detached)"}`);
  console.log(`  current:        ${currentVersion}`);
  console.log(`  release:        ${version}`);
  console.log(`  tag:            ${tag}`);
  console.log(`  github release: yes${opts.draft ? " (draft)" : ""}${opts.prerelease ? " (prerelease)" : ""}`);
  console.log(`  npm publish:    ${opts.npm ? "yes" : "no"}`);
  console.log(`  homebrew tap:   ${opts.homebrew ? opts.tap : "no"}`);
  console.log(`  checks:         ${opts.skipChecks ? "skip" : "test + typecheck"}`);
  console.log(`  push:           ${opts.skipPush ? "no" : "yes"}`);
  console.log(`  dry-run:        ${opts.dryRun ? "yes" : "no"}`);

  const ok = await confirm("Proceed?", { yes: opts.yes || opts.dryRun });
  if (!ok) fail("aborted", 0);

  if (!opts.skipChecks) {
    step("Running checks");
    if (opts.dryRun) {
      console.log(`[dry-run] bun test`);
      console.log(`[dry-run] bun run typecheck`);
    } else {
      run("bun", ["test"]);
      run("bun", ["run", "typecheck"]);
    }
  }

  if (versionChanged) {
    step(`Bumping package.json ${currentVersion} -> ${version}`);
    if (opts.dryRun) {
      console.log(`[dry-run] write package.json version=${version}`);
      console.log(`[dry-run] git commit -am "chore(release): ${version}"`);
    } else {
      const nextPkg = readPackage();
      nextPkg.version = version;
      writePackage(nextPkg);
      run("git", ["add", "package.json"]);
      run("git", ["commit", "-m", `chore(release): ${version}`]);
    }
  } else {
    step("package.json already at release version");
  }

  step(`Creating tag ${tag}`);
  if (opts.dryRun) {
    console.log(`[dry-run] git tag -a ${tag} -m "Release ${version}"`);
  } else {
    run("git", ["tag", "-a", tag, "-m", `Release ${version}`]);
  }

  if (!opts.skipPush) {
    step("Pushing commit and tag");
    if (opts.dryRun) {
      if (versionChanged) console.log(`[dry-run] git push origin HEAD`);
      console.log(`[dry-run] git push origin ${tag}`);
    } else {
      if (versionChanged) run("git", ["push", "origin", "HEAD"]);
      run("git", ["push", "origin", tag]);
    }
  } else {
    console.log("\n(skipping push)");
  }

  step(`Creating GitHub release ${tag}`);
  const ghArgs = ["release", "create", tag, "--title", title];
  if (opts.draft) ghArgs.push("--draft");
  if (opts.prerelease) ghArgs.push("--prerelease");
  if (opts.notesFile) ghArgs.push("--notes-file", opts.notesFile);
  else if (opts.generateNotes) ghArgs.push("--generate-notes");
  else ghArgs.push("--notes", `Release ${version}`);

  if (opts.dryRun) {
    console.log(`[dry-run] gh ${ghArgs.join(" ")}`);
  } else {
    run("gh", ghArgs);
  }

  if (opts.npm) {
    step("Publishing to npm");
    const publishArgs = ["publish", "--access", "public"];
    if (opts.otp) publishArgs.push("--otp", opts.otp);
    if (opts.dryRun) {
      console.log(`[dry-run] npm ${publishArgs.join(" ")}`);
      console.log("[dry-run] npm pack --dry-run");
      run("npm", ["pack", "--dry-run"]);
    } else {
      run("npm", ["pack", "--dry-run"]);
      run("npm", publishArgs);
    }
  }

  if (opts.homebrew) {
    step(`Updating Homebrew formula on ${opts.tap}`);
    publishHomebrewFormula({
      version,
      tap: opts.tap,
      dryRun: opts.dryRun,
      tag,
    });
  } else {
    console.log("\n(skipping Homebrew formula update)");
  }

  step("Done");
  if (!opts.dryRun) {
    const repo = capture("gh", ["repo", "view", "--json", "url", "-q", ".url"], { allowFail: true });
    if (repo.status === 0 && repo.stdout) {
      console.log(`GitHub release: ${repo.stdout}/releases/tag/${tag}`);
    } else {
      console.log(`GitHub release tag: ${tag}`);
    }
    if (opts.npm) console.log(`npm: https://www.npmjs.com/package/${pkg.name}/v/${version}`);
    if (opts.homebrew) {
      const owner = opts.tap.split("/")[0] || "tariqwest";
      console.log(`Homebrew: brew tap ${owner}/tap && brew install commandcode-acp`);
      console.log(`Formula: https://github.com/${opts.tap}/blob/main/Formula/commandcode-acp.rb`);
    }
  } else {
    console.log("Dry run complete — no changes were made.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
