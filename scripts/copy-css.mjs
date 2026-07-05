// Copy .css files from src/ to dist/ preserving structure — bundles keep CSS
// imports external so the consumer's bundler processes them.
import fs from "node:fs";
import path from "node:path";

const src = path.resolve("src");
const dist = path.resolve("dist");

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name.endsWith(".css")) {
      const target = path.join(dist, path.relative(src, p));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(p, target);
    }
  }
}

if (fs.existsSync(src)) walk(src);
