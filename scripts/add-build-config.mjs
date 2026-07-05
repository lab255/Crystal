// One-shot: stamp build script, files, publishConfig and tsup devDep into
// every publishable package. Safe to re-run.
import fs from "node:fs";
import path from "node:path";

const packages = ["core", "client", "ui", "architect", "orchestrator", "editor", "sdk"];

for (const name of packages) {
  const file = path.resolve("packages", name, "package.json");
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));

  pkg.scripts = { ...pkg.scripts, build: "tsup && node ../../scripts/copy-css.mjs" };
  pkg.devDependencies = { ...pkg.devDependencies, tsup: "^8.3.5" };
  pkg.files = ["dist", "src"];

  const exports = {
    ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
  };
  if (name === "ui") exports["./styles.css"] = "./dist/styles.css";
  pkg.publishConfig = {
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports,
  };

  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  console.log("updated", name);
}
