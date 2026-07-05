// Build the Crystal bridge server as a standalone executable (Node SEA) and
// place it where Tauri expects its sidecar binary.
//
// Run from apps/server via `pnpm build:sidecar` (needs Node >= 20 with SEA).
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const run = (cmd) => {
  console.log(">", cmd);
  execSync(cmd, { stdio: "inherit" });
};

const triple = "x86_64-pc-windows-msvc"; // extend per-platform when needed
const exeName = process.platform === "win32" ? ".exe" : "";
const out = path.resolve("dist", `crystal-server${exeName}`);
const sidecarDir = path.resolve("..", "desktop", "src-tauri", "binaries");
const sidecar = path.join(sidecarDir, `crystal-server-${triple}${exeName}`);

// 1. Bundle to a single CJS file.
run("pnpm exec tsup");

// 2. Generate the SEA blob.
run("node --experimental-sea-config sea-config.json");

// 3. Copy the running Node binary and inject the blob.
fs.copyFileSync(process.execPath, out);
run(
  `pnpm exec postject "${out}" NODE_SEA_BLOB dist/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
);

// 4. Drop it into the Tauri sidecar location.
fs.mkdirSync(sidecarDir, { recursive: true });
fs.copyFileSync(out, sidecar);
console.log("sidecar ready:", sidecar);
