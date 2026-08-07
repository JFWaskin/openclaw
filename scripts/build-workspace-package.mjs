#!/usr/bin/env node
// Build a single workspace package using its `exports` map to derive tsdown entry points.
//
// Usage: node scripts/build-workspace-package.mjs <package-name>
//
// The script reads `packages/<name>/package.json`, walks each `./dist/<file>.*`
// export, maps it back to a source path, and runs `tsdown` against the resolved
// entries. It also writes a short per-package `tsdown.config.mjs` so the output
// extensions match what the package's `exports` map promises (some packages
// use `.js`/`.d.ts`, others use `.mjs`/`.d.mts`).
//
// Special path overrides live in `PACKAGE_PATH_OVERLAYS` to handle packages
// where the dist file name does not match the source file name (e.g.
// `dist/harness/compaction.mjs` builds from `src/harness/compaction/compaction.ts`,
// or `dist/event-stream.mjs` builds from `src/utils/event-stream.ts`).

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const packageName = process.argv[2];
if (!packageName) {
  console.error("Usage: node scripts/build-workspace-package.mjs <package-name>");
  process.exit(2);
}

const packageDir = path.join(REPO_ROOT, "packages", packageName);
const packageJsonPath = path.join(packageDir, "package.json");
if (!fs.existsSync(packageJsonPath)) {
  console.error(`No package.json found at ${packageJsonPath}`);
  process.exit(2);
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const exports_ = packageJson.exports ?? {};

// Packages where the dist file path does not match the source file path.
// Keys are the dist file path relative to `dist/` (e.g. "harness/compaction"
// for `dist/harness/compaction.mjs`); values are the relative source path
// under `src/` that should be used as the entry.
const PACKAGE_PATH_OVERLAYS = {
  "agent-core": {
    "harness/compaction": "harness/compaction/compaction.ts",
    "harness/branch-summarization": "harness/compaction/branch-summarization.ts",
  },
  ai: {
    diagnostics: "utils/diagnostics.ts",
    "event-stream": "utils/event-stream.ts",
  },
};

// Walk the exports map. For each `./dist/<key>.*` (and the root ".") export
// we compute the matching source path and record the (distKey → sourcePath)
// mapping for tsdown. `distKey` is the dist-relative path (no `./dist/`
// prefix, no extension) — it becomes the entry name and thus the output
// file's basename under `outDir`.
const entryMap = {};
const extensions = { js: null, dts: null };

for (const [exportKey, value] of Object.entries(exports_)) {
  // Include both the root export (".") and subpath exports ("./foo") — the
  // root often points at the package's main entry file (e.g. ./dist/index.mjs)
  // which is what other workspace packages import as a bare specifier.
  if (exportKey !== "." && !exportKey.startsWith("./")) continue;
  const runtimePath =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value.import ?? value.default)
      : value;
  const typesPath =
    typeof value === "object" && value !== null && !Array.isArray(value) ? value.types : null;

  // Track the most common js / dts extension used in this package's exports.
  // `.d.ts` / `.d.mts` are the declaration extensions; `.js` / `.mjs` are the
  // runtime extensions. We read both `types` and `import`/`default` so the
  // detection works for either convention.
  if (typeof runtimePath === "string" && runtimePath.startsWith("./dist/")) {
    const jsMatch = runtimePath.match(/\.(m?js)$/u);
    if (jsMatch) {
      extensions.js = extensions.js ?? `.${jsMatch[1]}`;
    }
  }
  if (typeof typesPath === "string" && typesPath.startsWith("./dist/")) {
    const dtsMatch = typesPath.match(/\.d\.(m?ts)$/u);
    if (dtsMatch) {
      extensions.dts = extensions.dts ?? `.d.${dtsMatch[1]}`;
    }
  }

  // Use the runtime path to derive the dist key (it always points at a
  // concrete dist file). Fall back to the types path if no runtime path is
  // declared (rare; mainly defensive).
  const distPath =
    typeof runtimePath === "string" && runtimePath.startsWith("./dist/")
      ? runtimePath
      : typeof typesPath === "string" && typesPath.startsWith("./dist/")
        ? typesPath
        : null;
  if (!distPath) continue;

  // Strip the leading `./dist/` and the trailing extension to get the dist key.
  // The dist key is what the `exports` map promises will appear under `dist/`
  // and is the entry name we pass to tsdown.
  const distKey = distPath.replace(/^\.\/dist\//u, "").replace(/\.(m?js|d\.[cm]?ts)$/u, "");

  // Map the dist key to a source path. For most entries the source is
  // `src/<distKey>.ts`; PACKAGE_PATH_OVERLAYS handles the exceptions.
  const sourcePath = (() => {
    const overlay = PACKAGE_PATH_OVERLAYS[packageName]?.[distKey];
    if (overlay) return `src/${overlay}`;
    if (exportKey === ".") return `src/${distKey}.ts`;
    return `src/${distKey}.ts`;
  })();

  const fullSourcePath = path.join(packageDir, sourcePath);
  if (!fs.existsSync(fullSourcePath)) {
    console.error(
      `[build-workspace-package] ${packageName}: source not found for export ${exportKey}: ${sourcePath}`,
    );
    process.exit(2);
  }
  entryMap[distKey] = sourcePath;
}

if (Object.keys(entryMap).length === 0) {
  console.error(`[build-workspace-package] ${packageName}: no dist exports to build`);
  process.exit(2);
}

const jsExt = extensions.js ?? ".mjs";
const dtsExt = extensions.dts ?? ".d.mts";

// Write a per-package tsdown config so the output extensions match the
// package's exports. Cleaned up after the build.
const tempConfigPath = path.join(packageDir, `.tsdown.config.${process.pid}.${Date.now()}.mjs`);
const configSource = `// Auto-generated by scripts/build-workspace-package.mjs — safe to delete.
export default {
  noConfig: true,
  platform: "node",
  format: "esm",
  dts: true,
  outDir: "dist",
  clean: true,
  entry: ${JSON.stringify(entryMap, null, 2)},
  outExtensions: () => ({ js: ${JSON.stringify(jsExt)}, dts: ${JSON.stringify(dtsExt)} }),
};
`;
fs.writeFileSync(tempConfigPath, configSource, "utf8");

const args = ["--config", tempConfigPath];

console.log(
  `[build-workspace-package] ${packageName}: building ${Object.keys(entryMap).length} entries (js=${jsExt}, dts=${dtsExt})`,
);

const child = spawn("pnpm", ["exec", "tsdown", ...args], {
  cwd: packageDir,
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code) => {
  // Always clean up the temp config, even on failure. Without this, a
  // partial run would leave a `.tsdown.config.<pid>.<ts>.mjs` next to
  // the package and clutter `git status` for contributors.
  try {
    fs.unlinkSync(tempConfigPath);
  } catch {
    // best-effort cleanup; the file may already be gone or the FS may
    // be read-only. The dedicated "does not leak" test in
    // test/workspace-packages-build-on-install.test.ts asserts the
    // happy-path behaviour end-to-end.
  }
  process.exit(code ?? 1);
});
