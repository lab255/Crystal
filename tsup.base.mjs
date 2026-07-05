/** Shared tsup options for all publishable Crystal packages. */
export function crystalTsup(overrides = {}) {
  return {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2022",
    external: [
      /^react($|\/)/,
      /^react-dom($|\/)/,
      /^@crystal\//,
      /\.css$/,
      /\?worker$/,
    ],
    ...overrides,
  };
}
