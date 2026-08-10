// The sdk's tsup config bundles its @crystal/* workspace siblings' JS
// (noExternal), but each sibling's own build only copies ITS css into ITS
// OWN dist — so a relative `./foo.css` side-effect import surviving into a
// bundled chunk here has nothing to resolve against. Esbuild flattens
// bundled output into one dist/ dir, so a flat basename copy from the
// bundled siblings' src trees is enough to satisfy those references.
import fs from "node:fs";
import path from "node:path";

const dist = path.resolve("dist");
const bundledPackages = JSON.parse(
  fs.readFileSync(path.resolve("package.json"), "utf8"),
).devDependencies;
const siblingSrcDirs = Object.keys(bundledPackages)
  .filter((name) => name.startsWith("@crystal/"))
  .map((name) => path.resolve("../", name.replace("@crystal/", ""), "src"));

function findCss(basename) {
  for (const srcDir of siblingSrcDirs) {
    const found = walk(srcDir, basename);
    if (found) return found;
  }
  return null;
}

function walk(dir, basename) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = walk(p, basename);
      if (found) return found;
    } else if (entry.name === basename) {
      return p;
    }
  }
  return null;
}

const referenced = new Set();
for (const file of fs.readdirSync(dist)) {
  if (!file.endsWith(".js")) continue;
  const content = fs.readFileSync(path.join(dist, file), "utf8");
  for (const m of content.matchAll(/^import "\.\/([^"]+\.css)"/gm)) {
    referenced.add(m[1]);
  }
}

for (const basename of referenced) {
  const target = path.join(dist, basename);
  if (fs.existsSync(target)) continue;
  const source = findCss(basename);
  if (!source) {
    throw new Error(
      `sdk bundle references ./${basename} but no matching css file was found in bundled @crystal/* siblings`,
    );
  }
  fs.copyFileSync(source, target);
}
