// Build the Crystal bridge server as a standalone executable (Node SEA) for the
// HOST platform, and stage it — plus node-pty's native module — where Tauri
// expects its sidecar. Node SEA copies the *running* node binary (and macOS
// must codesign locally), so this only ever produces the current OS/arch's
// artifact; the other platforms build on their own CI runners.
//
// Run from apps/server via `pnpm build:sidecar` (Node >= 20 with SEA).
import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const run = (cmd) => {
  console.log(">", cmd);
  execSync(cmd, { stdio: "inherit" });
};

/** Mach-O magic numbers (thin + fat, both byte orders), read big-endian. */
const MACHO_MAGIC = new Set([
  0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
]);

/** True if `file`'s first four bytes are a Mach-O magic (native binary). */
function isMachO(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(4);
    if (fs.readSync(fd, buf, 0, 4, 0) < 4) return false;
    return MACHO_MAGIC.has(buf.readUInt32BE(0));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Recursively collect every Mach-O file under `dir`. */
function collectMachO(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) collectMachO(p, acc);
    else if (entry.isFile() && isMachO(p)) acc.push(p);
  }
  return acc;
}

/** Node target triple for the host — matches Tauri's externalBin naming. */
function hostTriple() {
  const key = `${process.platform}-${process.arch}`;
  const map = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "win32-x64": "x86_64-pc-windows-msvc",
    "win32-arm64": "aarch64-pc-windows-msvc",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "linux-arm64": "aarch64-unknown-linux-gnu",
  };
  const triple = map[key];
  if (!triple) throw new Error(`Unsupported host for sidecar build: ${key}`);
  return triple;
}

/** Package root dir for `name`, resolved from `req`'s context (pnpm-safe). */
function pkgDir(req, name) {
  try {
    return path.dirname(req.resolve(`${name}/package.json`));
  } catch {
    let d = path.dirname(req.resolve(name));
    while (!fs.existsSync(path.join(d, "package.json")) && d !== path.dirname(d)) {
      d = path.dirname(d);
    }
    return d;
  }
}

const triple = hostTriple();
const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
const exeName = isWin ? ".exe" : "";
const out = path.resolve("dist", `crystal-server${exeName}`);

const tauriDir = path.resolve("..", "desktop", "src-tauri");
const binariesDir = path.join(tauriDir, "binaries");
const sidecar = path.join(binariesDir, `crystal-server-${triple}${exeName}`);

// 1. Bundle to a single CJS file (node-pty stays external — see tsup banner).
run("pnpm exec tsup");

// 2. Generate the SEA blob.
run("node --experimental-sea-config sea-config.json");

// 3. Copy the running Node binary and inject the blob (platform-specific).
fs.copyFileSync(process.execPath, out);
if (isMac) {
  // The copied node keeps Apple's signature; strip it before mutating the
  // Mach-O, then re-sign (ad-hoc) after — else macOS SIGKILLs the binary.
  run(`codesign --remove-signature "${out}"`);
}
run(
  `pnpm exec postject "${out}" NODE_SEA_BLOB dist/sea-prep.blob ` +
    `--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2` +
    (isMac ? " --macho-segment-name NODE_SEA" : ""),
);
if (isMac) run(`codesign --sign - "${out}"`);

// 4. Drop the sidecar into the Tauri externalBin location (named per triple).
fs.mkdirSync(binariesDir, { recursive: true });
fs.copyFileSync(out, sidecar);
console.log("sidecar ready:", sidecar);

// 5. Stage node-pty + its host prebuild next to the sidecar as a Tauri
//    resource. The SEA bundle's rebound `require` (tsup banner) loads it from
//    here at runtime — native addons can't live inside a SEA.
const req = createRequire(path.join(process.cwd(), "package.json"));
const ptyDir = pkgDir(req, "@lydell/node-pty");
const platformPkg = `@lydell/node-pty-${process.platform}-${process.arch}`;
const platDir = pkgDir(createRequire(path.join(ptyDir, "package.json")), platformPkg);

const stageBase = path.join(tauriDir, "resources", "sidecar");
const stageRoot = path.join(stageBase, "node_modules", "@lydell");
fs.rmSync(stageBase, { recursive: true, force: true });
fs.mkdirSync(stageRoot, { recursive: true });
fs.cpSync(ptyDir, path.join(stageRoot, "node-pty"), { recursive: true, dereference: true });
fs.cpSync(platDir, path.join(stageRoot, path.basename(platformPkg)), {
  recursive: true,
  dereference: true,
});
console.log("staged node-pty:", ptyDir);
console.log("staged prebuild:", platDir);

// 6. Stage the analysis worker bundle. Worker threads need a real file on
//    disk — a SEA can't host one — so the host resolves it from the module
//    base dir (see workerEntry() in apps/server/src/analysis-host.ts).
fs.copyFileSync(
  path.resolve("dist", "analysis-worker.cjs"),
  path.join(stageBase, "analysis-worker.cjs"),
);
console.log("staged analysis worker");

// 7. Developer-ID sign the staged native Mach-O (node-pty's pty.node +
//    spawn-helper). They ship ad-hoc / linker-signed — no Team ID, no secure
//    timestamp — and Tauri signs only the app's own executables, never nested
//    Mach-O under Contents/Resources, so notarytool rejects the bundle without
//    this. `beforeBuildCommand` re-stages this dir on every build (the rmSync
//    above), so the signing has to happen HERE — a pre-`tauri build` workflow
//    step would just be wiped — and before Tauri seals the app. Gated on
//    APPLE_SIGNING_IDENTITY: only CI (release.yml) sets it, so local/dev builds
//    stay ad-hoc and offline (no --timestamp network call). See docs/releasing.md.
const signingIdentity = process.env.APPLE_SIGNING_IDENTITY;
if (isMac && signingIdentity) {
  const nested = collectMachO(stageBase);
  for (const bin of nested) {
    console.log("> codesign (runtime + timestamp)", path.relative(stageBase, bin));
    execFileSync(
      "codesign",
      ["--force", "--options", "runtime", "--timestamp", "--sign", signingIdentity, bin],
      { stdio: "inherit" },
    );
  }
  console.log(`signed ${nested.length} nested Mach-O for notarization`);
}
