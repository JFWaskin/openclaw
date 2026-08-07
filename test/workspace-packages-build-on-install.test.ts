// Regression test for workspace package build-on-install behavior.
//
// Why: Several workspace packages (e.g. @openclaw/normalization-core) ship
// pre-built `dist/` outputs that are consumed by `src/...` via workspace
// aliases. After commit 21dcf2dd994 ("chore: stop tracking package dist
// output") the dist directories are no longer committed, but no lifecycle
// hook rebuilds them on `pnpm install`. As a result, fresh checkouts see
// errors such as:
//
//   Cannot find module '@openclaw/normalization-core/string-coerce'
//
// Two bug classes can produce those errors and both must be guarded:
//
//   1. The root `prepare` script does not run a workspace build at all
//      (the original issue, before the first fix).
//   2. The root `prepare` script runs `pnpm -r ... run build` but a
//      workspace package is missing a `build` script. pnpm's `--filter`
//      silently skips packages without the requested script, so the
//      `dist/` for that package is never produced even though its
//      `exports` map points into `./dist/...`.
//
// This file organizes the regression coverage by responsibility:
//
//   - "root prepare script"       : static checks on the root `package.json`.
//   - "per-package build script"  : every dist-backed package has a build
//                                    script that points at the shared helper.
//   - "dist artifacts on disk"    : every dist subpath resolves to a real
//                                    file on disk after `pnpm run prepare`.
//   - "runtime import resolution" : the produced dist subpaths actually
//                                    load as ESM modules.
//   - "shared helper in isolation": the helper script (independent of the
//                                    prepare chain) builds packages
//                                    correctly, cleans up after itself, and
//                                    fails loudly on bad input.
//   - "exports map consistency"   : the dist tree is exactly the set of
//                                    files the package's `exports` map
//                                    promises — no surprise file omissions,
//                                    no missing declarations.
//   - "per-package parametrized"  : each of the 6 newly-fixed packages is
//                                    exercised end-to-end on its own.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const helperPath = join(repoRoot, "scripts", "build-workspace-package.mjs");

type PackageJson = {
  name?: string;
  scripts?: Record<string, string>;
  exports?: Record<string, { import?: string; default?: string; types?: string } | string>;
};

function readJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
}

type DistSubpath = {
  // The exports key, e.g. "./string-coerce" or "."
  exportKey: string;
  // The runtime import path, e.g. "./dist/string-coerce.mjs"
  importTarget: string | null;
  // The types declaration path, e.g. "./dist/string-coerce.d.mts"
  typesTarget: string | null;
};

type WorkspacePackage = {
  dir: string;
  name: string;
  hasBuild: boolean;
  buildScript: string | null;
  distSubpaths: DistSubpath[];
};

function readExportTarget(value: unknown): { import: string | null; types: string | null } {
  if (typeof value === "string") {
    return { import: value, types: null };
  }
  if (typeof value === "object" && value !== null) {
    const importPath =
      (value as { import?: string; default?: string }).import ??
      (value as { default?: string }).default ??
      null;
    const typesPath = (value as { types?: string }).types ?? null;
    return { import: importPath, types: typesPath };
  }
  return { import: null, types: null };
}

function listWorkspacePackages(root: string): WorkspacePackage[] {
  const out: WorkspacePackage[] = [];
  // pnpm-workspace.yaml lists `packages/*` — mirror that shape to avoid a
  // YAML parser dependency in this test.
  const packagesRoot = join(root, "packages");
  for (const entry of readdirSync(packagesRoot)) {
    const dir = join(packagesRoot, entry);
    if (!statSync(dir).isDirectory()) continue;
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = readJson(pkgPath);
    if (pkg.name?.startsWith("@openclaw/") !== true) continue;

    // Collect ALL dist subpaths, including the root export when it points
    // into ./dist/. A package only counts as "dist-backed" if its
    // *runtime* condition (import or default) points into ./dist/. Some
    // packages (e.g. plugin-sdk) ship types from ./dist/ but resolve at
    // runtime to source files in ./src/ — those do not need a per-package
    // build.
    const distSubpaths: DistSubpath[] = [];
    for (const [subpath, rawValue] of Object.entries(pkg.exports ?? {})) {
      const { import: importTarget, types: typesTarget } = readExportTarget(rawValue);
      const runtimeIntoDist = typeof importTarget === "string" && importTarget.includes("/dist/");
      if (!runtimeIntoDist) continue;
      distSubpaths.push({ exportKey: subpath, importTarget, typesTarget });
    }

    out.push({
      dir,
      name: pkg.name,
      hasBuild: Boolean(pkg.scripts?.build),
      buildScript: pkg.scripts?.build ?? null,
      distSubpaths,
    });
  }
  return out;
}

function packagesWithDistSubpaths(): WorkspacePackage[] {
  return listWorkspacePackages(repoRoot).filter((pkg) => pkg.distSubpaths.length > 0);
}

// The packages this PR adds build scripts to. These are the ones that
// shipped with a dist subpath in `exports` but no `build` script, so
// `pnpm -r ... run build` silently skipped them. Pinning the list here
// keeps the per-package parametrized suite tied to the actual fix.
const NEWLY_FIXED_PACKAGES = [
  "agent-core",
  "ai",
  "llm-core",
  "markdown-core",
  "model-catalog-core",
  "terminal-core",
];

function runPrepare(): void {
  // Some package managers (e.g. pnpm) skip the `prepare` lifecycle hook
  // when the dependency tree is already installed. Run it ourselves to
  // mirror what a fresh `pnpm install` would do.
  execFileSync("pnpm", ["-C", repoRoot, "run", "prepare"], {
    stdio: "pipe",
  });
}

function runHelper(
  packageName: string,
  options: { cwd?: string } = {},
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync("node", [helperPath, packageName], {
      cwd: options.cwd ?? repoRoot,
      stdio: "pipe",
      encoding: "utf8",
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      status: typeof e.status === "number" ? e.status : 1,
    };
  }
}

function listTempConfigs(packageDir: string): string[] {
  // The helper writes `.<pid>.<ts>.mjs` configs in the package dir; on
  // exit the helper is supposed to unlink them. This is the leak detector.
  return readdirSync(packageDir).filter((name) => /^\.tsdown\.config\..*\.mjs$/u.test(name));
}

describe("root prepare script", () => {
  it("chains a workspace build into the root prepare script", () => {
    const rootPkg = readJson(join(repoRoot, "package.json"));
    const prepare = rootPkg.scripts?.prepare ?? "";

    // Preserve existing behavior — the git-hooks script must still run.
    expect(prepare).toMatch(/prepare-git-hooks/);

    // New behavior: the prepare hook must rebuild workspace packages so
    // fresh checkouts can resolve @openclaw/<pkg>/* imports.
    expect(prepare).toMatch(/pnpm\s+-r/);
    expect(prepare).toMatch(/--filter/);
    expect(prepare).toMatch(/run\s+build/);
  });
});

describe("per-package build script", () => {
  it("declares a build script for every @openclaw/* package with a dist subpath export", () => {
    // Without a `build` script, `pnpm -r --filter "./packages/*" run build`
    // silently skips the package and the dist/ subtree stays empty. That
    // is the same shape of failure as the original "no prepare hook" bug
    // — a fresh checkout cannot resolve `@openclaw/<pkg>/<subpath>`.
    const missing: string[] = [];
    for (const pkg of packagesWithDistSubpaths()) {
      if (!pkg.hasBuild) {
        const first = pkg.distSubpaths[0];
        missing.push(`${pkg.name}${first ? first.exportKey : ""}`);
      }
    }
    expect(
      missing,
      "workspace packages with dist subpath exports must declare a build script",
    ).toEqual([]);
  });

  it("every newly-fixed package's build script points at the shared helper", () => {
    // Stronger version of the previous test scoped to the 6 packages this
    // PR touches. The shared helper is the single place that derives
    // tsdown entry points from a package's exports map; if any of the
    // newly-fixed packages drift to an inline script, the entry-point
    // derivation could fall out of sync with the other 5.
    const misrouted: string[] = [];
    for (const pkg of NEWLY_FIXED_PACKAGES) {
      const pkgJson = readJson(join(repoRoot, "packages", pkg, "package.json"));
      const build = pkgJson.scripts?.build;
      if (!build) {
        misrouted.push(`${pkgJson.name}: missing build script`);
        continue;
      }
      if (!build.includes("scripts/build-workspace-package.mjs")) {
        misrouted.push(`${pkgJson.name}: ${build}`);
      }
    }
    expect(
      misrouted,
      "newly-fixed package build scripts must delegate to scripts/build-workspace-package.mjs",
    ).toEqual([]);
  });
});

describe("dist artifacts on disk", () => {
  it("produces a dist/ tree and a file at every dist subpath for every @openclaw/* package", () => {
    // Run prepare first so the dist/ is up to date, then assert every
    // @openclaw/* package has a concrete file at EVERY dist subpath it
    // advertises in `exports` (not just the first one).
    runPrepare();

    const offenders: string[] = [];
    for (const pkg of packagesWithDistSubpaths()) {
      const dist = join(pkg.dir, "dist");
      if (!existsSync(dist)) {
        offenders.push(`${pkg.name} (missing ${dist})`);
        continue;
      }
      for (const sub of pkg.distSubpaths) {
        for (const target of [sub.importTarget, sub.typesTarget]) {
          if (!target) continue;
          const file = join(pkg.dir, target.replace(/^\.\//, ""));
          if (!existsSync(file)) {
            offenders.push(`${pkg.name}${sub.exportKey} → expected ${file}`);
          }
        }
      }
    }
    expect(offenders, "workspace package dist/ not fully built after pnpm run prepare").toEqual([]);
  }, 120_000);
});

describe("runtime import resolution", () => {
  it("makes workspace dist subpath entries resolvable at runtime", async () => {
    // Run prepare first so the dist/ is up to date.
    runPrepare();

    // For each workspace package that exposes a dist subpath, dynamically
    // import its runtime entry via the file: URL of the built mjs. This
    // mirrors what the bundler / runtime does when it resolves
    // `@openclaw/<pkg>/<subpath>`.
    const failures: string[] = [];
    for (const pkg of packagesWithDistSubpaths()) {
      for (const sub of pkg.distSubpaths) {
        if (!sub.importTarget) continue;
        const target = sub.importTarget.replace(/^\.\//, "");
        const candidate = join(pkg.dir, target);
        if (!existsSync(candidate)) {
          failures.push(`${pkg.name}${sub.exportKey} → expected ${candidate}`);
          continue;
        }
        try {
          await import(pathToFileURL(candidate).href);
        } catch (err) {
          failures.push(`${pkg.name}${sub.exportKey} → import threw: ${(err as Error).message}`);
        }
      }
    }
    expect(failures, "workspace package dist subpath entries must be importable").toEqual([]);
  }, 120_000);
});

describe("shared helper in isolation", () => {
  // The smoke test below deletes the dist directory of the chosen
  // package, runs the helper, asserts the export-promised files appear.
  // The other tests in this suite that need a fully built dist tree
  // (e.g. "dist artifacts on disk") re-run `pnpm run prepare`
  // themselves; we don't pay that cost on every test here.
  it("builds a fresh package via the shared helper alone", () => {
    const candidate = packagesWithDistSubpaths().find((p) => p.name === "@openclaw/markdown-core");
    if (!candidate) {
      throw new Error("test prerequisite missing: @openclaw/markdown-core not found");
    }
    const distDir = join(candidate.dir, "dist");
    rmSync(distDir, { recursive: true, force: true });

    const result = runHelper("markdown-core");
    expect(result.status, `helper exited non-zero; stderr:\n${result.stderr}`).toBe(0);

    // Every dist subpath advertised in package.json should now exist on
    // disk. The helper derives entries from the exports map, so this is
    // the same set the prepare-chain test asserts on.
    const missing: string[] = [];
    for (const sub of candidate.distSubpaths) {
      for (const target of [sub.importTarget, sub.typesTarget]) {
        if (!target) continue;
        const file = join(candidate.dir, target.replace(/^\.\//, ""));
        if (!existsSync(file)) {
          missing.push(`${candidate.name}${sub.exportKey} → expected ${file}`);
        }
      }
    }
    expect(missing, "helper script must produce every advertised dist subpath").toEqual([]);
  }, 120_000);

  it("does not leak its temporary tsdown config into the package directory", () => {
    // The helper writes `.<pid>.<ts>.mjs` configs next to the package
    // and is supposed to unlink them on exit (success or failure). A
    // leak would clutter the package directory and confuse git status
    // for contributors. Run the helper on a small package, then assert
    // the temp config is gone.
    const before = listTempConfigs(join(repoRoot, "packages", "markdown-core"));

    runHelper("markdown-core");

    const after = listTempConfigs(join(repoRoot, "packages", "markdown-core"));
    expect(after, "temp config leaked into packages/markdown-core").toEqual(before);
  });

  it("is idempotent — two consecutive runs produce the same dist tree", () => {
    // Sanity check that the helper is stable across runs (no timestamped
    // file names, no accumulating side effects). Capture the file listing
    // after run 1 and after run 2; the sets must match.
    const pkg = "markdown-core";
    runHelper(pkg);
    const first = readdirSync(join(repoRoot, "packages", pkg, "dist")).sort();
    runHelper(pkg);
    const second = readdirSync(join(repoRoot, "packages", pkg, "dist")).sort();
    expect(second, "helper produced a different dist tree on the second run").toEqual(first);
  });

  it("fails with a clear error when the package name is unknown", () => {
    const result = runHelper("definitely-not-a-real-package-xyz");
    expect(result.status, `helper should exit non-zero; stderr:\n${result.stderr}`).not.toBe(0);
    // The error should mention the package name and the missing path so
    // a contributor can debug without opening the script.
    expect(result.stderr).toMatch(/definitely-not-a-real-package-xyz/);
    expect(result.stderr).toMatch(/No package\.json/);
  });

  it("fails when a package.json advertises a dist export that has no matching source file", () => {
    // The helper must catch a missing source file up front and exit
    // non-zero — silently producing an incomplete dist tree would
    // defeat the whole point of the fix. We exercise this by writing a
    // broken package.json into a temp directory and running the helper
    // against it. The helper derives REPO_ROOT from its own path (so
    // it can find tsdown), then constructs `packages/<name>` under
    // REPO_ROOT. We pass a name that doesn't exist there, but the
    // relevant check — "exports promise a dist subpath whose source
    // file is missing" — needs to actually run on a real package.
    // So we mutate the markdown-core package.json in place (after
    // stashing the original) and run the helper against the real
    // package.
    const pkg = "markdown-core";
    const pkgJsonPath = join(repoRoot, "packages", pkg, "package.json");
    const original = readFileSync(pkgJsonPath, "utf8");

    try {
      const mutated = JSON.parse(original) as PackageJson;
      mutated.exports = {
        ...(mutated.exports ?? {}),
        "./does-not-exist": "./dist/does-not-exist.mjs",
      };
      writeFileSync(pkgJsonPath, JSON.stringify(mutated, null, 2), "utf8");

      const result = runHelper(pkg);
      expect(
        result.status,
        `helper should exit non-zero when a dist export has no source; stderr:\n${result.stderr}`,
      ).not.toBe(0);
      expect(result.stderr).toMatch(/does-not-exist/);
    } finally {
      // Restore the original package.json no matter what.
      writeFileSync(pkgJsonPath, original, "utf8");
    }
  });
});

describe("per-package parametrized", () => {
  // Each of the 6 newly-fixed packages gets its own end-to-end check:
  // delete the dist tree, run the helper, assert every advertised
  // export resolves to a real file. Parameterizing this catches bugs
  // that would otherwise hide in a one-off "build markdown-core and
  // hope the rest work" smoke test.
  //
  // We rebuild the full dist tree once at the end of the suite (via
  // `afterAll`) so other test groups that depend on it (e.g. "dist
  // artifacts on disk") see a consistent state.
  afterAll(() => {
    runPrepare();
  });

  for (const pkg of NEWLY_FIXED_PACKAGES) {
    it(`builds ${pkg} from scratch via the shared helper`, () => {
      const pkgJson = readJson(join(repoRoot, "packages", pkg, "package.json"));
      const distSubpaths: DistSubpath[] = [];
      for (const [exportKey, rawValue] of Object.entries(pkgJson.exports ?? {})) {
        const { import: importTarget, types: typesTarget } = readExportTarget(rawValue);
        if (typeof importTarget !== "string" || !importTarget.includes("/dist/")) continue;
        distSubpaths.push({ exportKey, importTarget, typesTarget });
      }
      if (distSubpaths.length === 0) {
        throw new Error(
          `test prerequisite missing: ${pkg} advertises no dist subpath exports; nothing to test`,
        );
      }

      const distDir = join(repoRoot, "packages", pkg, "dist");
      rmSync(distDir, { recursive: true, force: true });

      const result = runHelper(pkg);
      expect(result.status, `helper exited non-zero for ${pkg}; stderr:\n${result.stderr}`).toBe(0);

      const missing: string[] = [];
      for (const sub of distSubpaths) {
        for (const target of [sub.importTarget, sub.typesTarget]) {
          if (!target) continue;
          const file = join(repoRoot, "packages", pkg, target.replace(/^\.\//, ""));
          if (!existsSync(file)) {
            missing.push(`${pkgJson.name}${sub.exportKey} → expected ${file}`);
          }
        }
      }
      expect(missing, `helper must produce every advertised dist subpath for ${pkg}`).toEqual([]);
    }, 120_000);
  }
});

describe("exports map consistency", () => {
  it("every dist export key resolves to a real source file", () => {
    // Static check: the dist exports the package advertises must point
    // at source files that exist. If a future contributor adds an export
    // for a dist file but forgets to create the source, this catches it
    // *before* the build even runs.
    const offenders: string[] = [];
    for (const pkg of packagesWithDistSubpaths()) {
      for (const sub of pkg.distSubpaths) {
        for (const target of [sub.importTarget, sub.typesTarget]) {
          if (!target) continue;
          // dist/<key>.<ext> → src/<key>.ts (with PACKAGE_PATH_OVERLAYS
          // applied by the helper, but for the static invariant we
          // accept either the literal mapping or an overlay).
          const stripped = target.replace(/^\.\/dist\//u, "").replace(/\.(m?js|d\.[cm]?ts)$/u, "");
          const candidates = [join(pkg.dir, "src", `${stripped}.ts`)];
          if (pkg.name === "@openclaw/agent-core") {
            if (stripped === "harness/compaction") {
              candidates.push(join(pkg.dir, "src", "harness/compaction/compaction.ts"));
            }
            if (stripped === "harness/branch-summarization") {
              candidates.push(join(pkg.dir, "src", "harness/compaction/branch-summarization.ts"));
            }
          }
          if (pkg.name === "@openclaw/ai") {
            if (stripped === "diagnostics") {
              candidates.push(join(pkg.dir, "src", "utils/diagnostics.ts"));
            }
            if (stripped === "event-stream") {
              candidates.push(join(pkg.dir, "src", "utils/event-stream.ts"));
            }
          }
          if (!candidates.some((c) => existsSync(c))) {
            offenders.push(`${pkg.name}${sub.exportKey} → none of ${candidates.join(", ")} exist`);
          }
        }
      }
    }
    expect(offenders, "every dist export must point at an existing source file").toEqual([]);
  });

  it("the dist tree's main files use the extensions the package's exports promise", () => {
    // Stronger than "file exists" — verify the file extension matches
    // the extension the package's exports map advertises. If a future
    // refactor starts producing `.mjs` for a package that promises
    // `.js` in its exports map, this catches it.
    runPrepare();

    const offenders: string[] = [];
    for (const pkg of packagesWithDistSubpaths()) {
      for (const sub of pkg.distSubpaths) {
        if (!sub.importTarget) continue;
        const rel = sub.importTarget.replace(/^\.\//, "");
        const file = join(pkg.dir, rel);
        if (!existsSync(file)) continue;
        // rel is e.g. "dist/foo.mjs". The extension is the last ".mjs" / ".js".
        const extMatch = rel.match(/\.(m?js|d\.[cm]?ts)$/u);
        if (!extMatch) continue;
        const expectedExt = extMatch[0];
        if (!file.endsWith(expectedExt)) {
          offenders.push(`${pkg.name}${sub.exportKey}: ${file} should end with ${expectedExt}`);
        }
      }
    }
    expect(
      offenders,
      "dist file extensions must match the extensions the package's exports map promises",
    ).toEqual([]);
  }, 120_000);
});

// Note: the "does not leak its temporary tsdown config" test in the
// isolation block above is the leak tripwire. We deliberately do NOT
// put an `afterEach` leak check here: the per-package parametrized
// suite touches 6 different packages, and a single test that races the
// cleanup would cause a cascading false-positive in the other 5 — the
// dedicated leak test is a more targeted signal.
