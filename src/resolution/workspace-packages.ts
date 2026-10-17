/**
 * JS/TS workspace (monorepo) package resolution.
 *
 * npm / yarn / bun read member packages from the root `package.json`
 * `workspaces` field; pnpm from `pnpm-workspace.yaml`. A cross-package
 * import like `@scope/ui/widgets` is LOCAL to the monorepo, but to a
 * single-package resolver it looks exactly like a third-party npm
 * specifier — so `isExternalImport` flags it external and the
 * consumer↔definition edge is never created. For component barrels
 * (`export { default as X } from './x.svelte'`) that surfaces as a false
 * `0 callers` on a live component (issue #629).
 *
 * This module maps each member package's declared `name` to its
 * directory so the resolver can rewrite `@scope/ui/widgets` →
 * `packages/ui/widgets` and then run normal extension/index resolution.
 *
 * Scope deliberately small (mirrors path-aliases.ts):
 *   - reads `workspaces` (array OR `{ packages: [...] }`) from package.json,
 *     plus a minimal `pnpm-workspace.yaml` `packages:` list
 *   - expands one level of `*` / `**` globs (`packages/*`, `apps/*`)
 *   - honours a member's package.json `exports` map (`"."`, subpath keys like
 *     `"./nodes"`, condition objects, single-`*` wildcard subpaths) and its
 *     `main` / `module` / `types` fields, so `@scope/ui` resolves to the real
 *     `src/index.ts` barrel rather than the package directory. Subpaths the
 *     manifest does not declare fall back to directory-based resolution
 *     (`@scope/ui/sub` → `<ui>/sub`).
 *   - returns null when the project declares no workspaces, so single-
 *     package repos pay nothing and see no behaviour change.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logDebug } from '../errors';

export interface WorkspacePackages {
  /** Member package `name` → directory relative to projectRoot (posix). */
  byName: Map<string, string>;
  /**
   * Member package `name` → its declared ENTRY FILE relative to projectRoot
   * (posix), when the member's manifest names one (an npm/pnpm `exports`
   * `"."` / `main` / `module` / `types`, or ohpm's oh-package.json5 `main`).
   * Lets a bare `import { X } from "@scope/ui"` resolve to the member's real
   * barrel even when it doesn't follow an index-file convention.
   */
  entryByName?: Map<string, string>;
  /**
   * Member package `name` → (`exports` subpath key → entry file relative to
   * projectRoot, posix). Keys are the literal specifier (`"./nodes"`), plus
   * any single-`*` wildcard (`"./*"`, `"./messages/*"`). An undeclared
   * subpath falls back to directory-based resolution.
   */
  subpathByName?: Map<string, Map<string, string>>;
}

/**
 * Load workspace member packages for `projectRoot`. Returns `null` when
 * the project declares no workspaces (the common single-package case) —
 * callers then skip all workspace logic.
 *
 * Cheap to call repeatedly only via the resolver's per-instance cache;
 * this function itself touches the filesystem, so the resolver memoises it
 * the same way it does {@link loadProjectAliases} / {@link loadGoModule}.
 */
export function loadWorkspacePackages(projectRoot: string): WorkspacePackages | null {
  const byName = new Map<string, string>();
  const entryByName = new Map<string, string>();
  const subpathByName = new Map<string, Map<string, string>>();

  const patterns = readWorkspaceGlobs(projectRoot);
  for (const pattern of patterns) {
    for (const dir of expandWorkspaceGlob(projectRoot, pattern)) {
      const manifest = readNpmPackageManifest(projectRoot, dir);
      // First declaration wins — workspace patterns are tried in order.
      if (manifest?.name && !byName.has(manifest.name)) {
        byName.set(manifest.name, dir);
        if (manifest.entry) entryByName.set(manifest.name, manifest.entry);
        if (manifest.subpaths.size > 0) subpathByName.set(manifest.name, manifest.subpaths);
      }
    }
  }

  // HarmonyOS/OpenHarmony (ArkTS) modular projects: every module's
  // oh-package.json5 declares its local siblings as `"data": "file:../../
  // core/data"` dependencies, and code then imports the bare name
  // (`import { CartRepository } from "data"`). Same monorepo problem as npm
  // workspaces, different manifest.
  for (const [name, dir] of collectOhpmFileDeps(projectRoot)) {
    if (byName.has(name)) continue;
    byName.set(name, dir);
    const entry = readOhpmMain(projectRoot, dir);
    if (entry) entryByName.set(name, entry);
  }

  if (byName.size === 0) return null;

  logDebug('workspace packages loaded', { count: byName.size });
  return {
    byName,
    entryByName: entryByName.size > 0 ? entryByName : undefined,
    subpathByName: subpathByName.size > 0 ? subpathByName : undefined,
  };
}

/**
 * Read an ohpm member's declared entry file: `<dir>/oh-package.json5`'s
 * `main`, normalized to a projectRoot-relative posix path. Null when the
 * manifest or field is missing/escaping.
 */
function readOhpmMain(projectRoot: string, dirRel: string): string | null {
  let parsed: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    parsed = require('jsonc-parser').parse(
      fs.readFileSync(path.join(projectRoot, dirRel, OHPM_MANIFEST), 'utf-8')
    );
  } catch {
    return null;
  }
  const main = (parsed as { main?: unknown } | null)?.main;
  if (typeof main !== 'string' || !main.trim()) return null;
  const entryAbs = path.resolve(projectRoot, dirRel, main.trim());
  const entryRel = path.relative(projectRoot, entryAbs).replace(/\\/g, '/');
  if (entryRel.startsWith('..')) return null;
  return entryRel;
}

/**
 * Scan the project for `oh-package.json5` manifests and collect their
 * `file:`-protocol dependencies as workspace members: dep name (what the
 * source imports) → target directory (projectRoot-relative posix).
 *
 * Precision rule: a name declared with DIFFERENT target directories in
 * different manifests (e.g. every sample in a samples monorepo has its own
 * "common") is AMBIGUOUS and dropped entirely — a missing edge beats a wrong
 * cross-module link. Registry dependencies (`@ohos/axios: "^2.0.0"`) don't
 * use `file:` and are ignored, staying external.
 *
 * The walk is bounded (depth + directory budget) and prunes build/dependency
 * dirs, so non-ArkTS projects pay one readdir at the root and nothing else
 * (they have no oh-package.json5 anywhere shallow).
 */
const OHPM_MANIFEST = 'oh-package.json5';
const OHPM_WALK_MAX_DEPTH = 6;
const OHPM_WALK_DIR_BUDGET = 8000;
const OHPM_SKIP_DIRS = new Set([
  'node_modules', 'oh_modules', '.git', '.codegraph', '.hvigor', '.preview',
  'build', 'dist', 'out', 'oh-package-lock.json5',
]);

function collectOhpmFileDeps(projectRoot: string): Map<string, string> {
  const byName = new Map<string, string>();
  const ambiguous = new Set<string>();

  const queue: Array<{ rel: string; depth: number }> = [{ rel: '', depth: 0 }];
  let visited = 0;
  while (queue.length > 0) {
    const { rel, depth } = queue.shift()!;
    if (++visited > OHPM_WALK_DIR_BUDGET) break;
    const abs = path.join(projectRoot, rel);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth >= OHPM_WALK_MAX_DEPTH) continue;
        if (e.name.startsWith('.') || OHPM_SKIP_DIRS.has(e.name)) continue;
        queue.push({ rel: rel ? `${rel}/${e.name}` : e.name, depth: depth + 1 });
        continue;
      }
      if (e.name !== OHPM_MANIFEST) continue;

      const deps = readOhpmFileDeps(path.join(abs, e.name));
      for (const [name, target] of deps) {
        const targetAbs = path.resolve(abs, target);
        const targetRel = path.relative(projectRoot, targetAbs).replace(/\\/g, '/');
        if (targetRel.startsWith('..')) continue; // escapes the project
        const existing = byName.get(name);
        if (existing === undefined) {
          if (!ambiguous.has(name)) byName.set(name, targetRel);
        } else if (existing !== targetRel) {
          byName.delete(name);
          ambiguous.add(name);
        }
      }
    }
  }

  return byName;
}

/** Parse one oh-package.json5's dependencies → [name, file-target] pairs. */
function readOhpmFileDeps(manifestAbs: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let parsed: unknown;
  try {
    // JSON5 tolerates comments and trailing commas; jsonc-parser (already a
    // dependency, used by the opencode installer target) handles both.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    parsed = require('jsonc-parser').parse(fs.readFileSync(manifestAbs, 'utf-8'));
  } catch {
    return out;
  }
  const deps = (parsed as { dependencies?: Record<string, unknown> } | null)?.dependencies;
  if (!deps || typeof deps !== 'object') return out;
  for (const [name, value] of Object.entries(deps)) {
    if (typeof value !== 'string' || !value.startsWith('file:')) continue;
    const target = value.slice('file:'.length).trim();
    if (target) out.push([name, target]);
  }
  return out;
}

/**
 * Rewrite a bare workspace import to an ORDERED list of candidate paths
 * relative to projectRoot, WITHOUT extensions — the caller applies the
 * language's extension/index resolution and takes the first that resolves.
 *
 * A member's package.json `exports` / `main` names the shipped entry, which is
 * frequently BUILD OUTPUT (`./dist/index.js`) that is not in the source graph.
 * So the declared target is tried first, then a `src/` sibling of build output,
 * then the directory-based fallback (`@scope/ui/widgets` → `packages/ui/widgets`,
 * the pre-#629 behaviour). The directory fallback is ALWAYS the last element.
 * Returns an empty array when no member name matches.
 */
export function resolveWorkspaceImport(
  importPath: string,
  ws: WorkspacePackages
): string[] {
  // Longest matching package name wins, so `@scope/ui/core` prefers a
  // `@scope/ui/core` package over a `@scope/ui` one when both exist.
  let bestName: string | null = null;
  for (const name of ws.byName.keys()) {
    if (importPath === name || importPath.startsWith(name + '/')) {
      if (!bestName || name.length > bestName.length) bestName = name;
    }
  }
  if (!bestName) return [];
  const dir = ws.byName.get(bestName)!;
  const subpath = importPath.slice(bestName.length); // '' or '/widgets'

  // The target the manifest declares for this specifier, when it names one
  // (`exports` `"."` / subpath / wildcard, `main` / `module` / `types`, ohpm
  // `main`).
  let declared: string | null = null;
  if (!subpath) {
    declared = ws.entryByName?.get(bestName) ?? null;
  } else {
    const subMap = ws.subpathByName?.get(bestName);
    if (subMap) {
      const key = '.' + subpath; // '/nodes' → './nodes'
      declared = subMap.get(key) ?? matchWildcardSubpath(subMap, key);
    }
  }

  const candidates: string[] = [];
  if (declared) {
    candidates.push(declared);
    candidates.push(...sourceMappedTargets(declared, dir));
  }
  // Directory fallback, always last: the pre-#629 convention, and the only
  // option when the declared target is absent or was not indexed.
  const fallback = (dir + subpath).replace(/\/{2,}/g, '/');
  if (!candidates.includes(fallback)) candidates.push(fallback);
  return candidates;
}

/**
 * Match a subpath specifier like `"./messages/en"` against a single-`*`
 * `exports` pattern such as `"./messages/*"` → `"./messages/*.json"`,
 * substituting the captured segment. Only one path segment is replaced, so a
 * pattern can't be stretched across directories.
 */
function matchWildcardSubpath(subMap: Map<string, string>, key: string): string | null {
  for (const [pattern, target] of subMap) {
    const star = pattern.indexOf('*');
    if (star < 0 || target.indexOf('*') < 0) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
    const captured = key.slice(prefix.length, key.length - suffix.length);
    if (!captured || captured.includes('/')) continue;
    return target.replace('*', captured);
  }
  return null;
}

/** Build-output directories whose shipped files usually have a `src/` sibling. */
const BUILD_OUTPUT_DIRS = new Set(['dist', 'build', 'lib', 'out']);

/** Emitted JS / declaration extensions the `src/` mapping rewrites. */
const BUILD_OUTPUT_EXT = /\.(?:[cm]?js|d\.[cm]?ts)$/;

/**
 * When a declared target is build output directly inside the member (`dist/`,
 * `build/`, `lib/`, `out/`) with an emitted `.js` / `.mjs` / `.cjs` / `.d.ts`
 * name, the source it was built from almost always sits at the same relative
 * path under `src/`. Returns that extensionless candidate (`dist/index.js` →
 * `packages/pkg/src/index`) for the caller's extension resolution to complete,
 * or an empty list when the target is not build output.
 */
function sourceMappedTargets(target: string, dirRel: string): string[] {
  if (!BUILD_OUTPUT_EXT.test(target)) return [];
  const prefix = dirRel ? dirRel + '/' : '';
  if (!target.startsWith(prefix)) return [];
  const rel = target.slice(prefix.length); // 'dist/index.js'
  const slash = rel.indexOf('/');
  if (slash <= 0 || !BUILD_OUTPUT_DIRS.has(rel.slice(0, slash))) return [];
  const rest = rel.slice(slash + 1); // 'index.js'
  const stem = rest.replace(BUILD_OUTPUT_EXT, '');
  if (!stem) return [];
  return [`${prefix}src/${stem}`];
}

/** Read workspace glob patterns from package.json + pnpm-workspace.yaml. */
function readWorkspaceGlobs(projectRoot: string): string[] {
  const out: string[] = [];

  // package.json `workspaces` (npm / yarn / bun): array, or Yarn's
  // `{ packages: [...], nohoist: [...] }` object form.
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8')
    );
    const ws = pkg?.workspaces;
    if (Array.isArray(ws)) {
      out.push(...ws.filter((w: unknown): w is string => typeof w === 'string'));
    } else if (ws && Array.isArray(ws.packages)) {
      out.push(...ws.packages.filter((w: unknown): w is string => typeof w === 'string'));
    }
  } catch {
    /* no / invalid package.json — not a workspace root */
  }

  // pnpm-workspace.yaml `packages:` list. Parsed with a minimal line
  // scanner so we don't pull in a YAML dependency.
  try {
    const yaml = fs.readFileSync(path.join(projectRoot, 'pnpm-workspace.yaml'), 'utf-8');
    out.push(...parsePnpmPackages(yaml));
  } catch {
    /* no pnpm-workspace.yaml */
  }

  return out;
}

/**
 * Minimal pnpm-workspace.yaml `packages:` extractor. Handles the only shape
 * pnpm actually uses:
 *   packages:
 *     - 'packages/*'
 *     - "apps/*"
 *     - tools/build
 */
function parsePnpmPackages(yaml: string): string[] {
  const out: string[] = [];
  const lines = yaml.split(/\r?\n/);
  let inPackages = false;
  for (const line of lines) {
    if (/^\s*packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const item = line.match(/^\s*-\s*(.+?)\s*$/);
      if (item) {
        out.push(item[1]!.replace(/^['"]|['"]$/g, ''));
        continue;
      }
      // A non-list, non-blank line ends the `packages:` block.
      if (line.trim() !== '' && !/^\s/.test(line)) inPackages = false;
    }
  }
  return out;
}

/** Expand one level of a `packages/*` / `apps/**` glob to member dirs. */
function expandWorkspaceGlob(projectRoot: string, pattern: string): string[] {
  const norm = pattern.replace(/\\/g, '/').replace(/\/+$/, '');
  const star = norm.indexOf('*');
  if (star === -1) return [norm]; // exact directory

  // Everything before the wildcard segment is the base to enumerate.
  const base = norm.slice(0, star).replace(/\/+$/, '');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(projectRoot, base), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    out.push(base ? `${base}/${e.name}` : e.name);
  }
  return out;
}

/**
 * Read one member's package.json: its `name`, root entry, and `exports`
 * subpath map. `null` when the manifest is missing or malformed.
 *
 * `exports` is the modern Node/TS entry surface and wins over `main`/
 * `module`/`types`. It is either a string (the `"."` entry), a condition
 * object for the root (`{ import, require, types }`), or a subpath map whose
 * `"."` key is the root and whose `"./*"` keys are subpaths. Conditions are
 * preferred `types` > `import` > `default` > `require`, and every target is
 * resolved to a projectRoot-relative posix path (rejecting escapes).
 */
interface NpmPackageManifest {
  name: string | null;
  entry: string | null;
  subpaths: Map<string, string>;
}

function readNpmPackageManifest(projectRoot: string, dirRel: string): NpmPackageManifest | null {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, dirRel, 'package.json'), 'utf-8'));
  } catch {
    return null;
  }
  if (!pkg || typeof pkg !== 'object') return null;

  const result: NpmPackageManifest = {
    name: typeof pkg.name === 'string' && pkg.name ? pkg.name : null,
    entry: null,
    subpaths: new Map(),
  };

  const exportsField = pkg.exports;
  if (typeof exportsField === 'string') {
    result.entry = normalizeDeclaredTarget(projectRoot, dirRel, exportsField);
  } else if (exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
    const obj = exportsField as Record<string, unknown>;
    const subpathKeys = Object.keys(obj).filter((k) => k.startsWith('.'));
    if (subpathKeys.length === 0) {
      // A bare condition object is the root export.
      const target = pickExportTarget(obj);
      if (target) result.entry = normalizeDeclaredTarget(projectRoot, dirRel, target);
    } else {
      for (const key of subpathKeys) {
        const target = pickExportTarget(obj[key]);
        if (!target) continue;
        const norm = normalizeDeclaredTarget(projectRoot, dirRel, target);
        if (!norm) continue;
        if (key === '.') result.entry = norm;
        else result.subpaths.set(key, norm);
      }
    }
  }

  // Fall back to the legacy fields when `exports` named no root entry.
  if (!result.entry) {
    for (const field of ['module', 'main', 'types', 'typings']) {
      const value = pkg[field];
      if (typeof value === 'string' && value.trim()) {
        const norm = normalizeDeclaredTarget(projectRoot, dirRel, value);
        if (norm) { result.entry = norm; break; }
      }
    }
  }
  return result;
}

/** Condition preference for an `exports` target object. */
const EXPORT_CONDITION_PREFERENCE = ['types', 'import', 'default', 'require', 'module', 'node', 'browser'];

/** A TypeScript declaration file (`.d.ts` / `.d.mts` / `.d.cts`) — names no symbols. */
const DECLARATION_FILE = /\.d\.[cm]?ts$/;

/**
 * The entry string an `exports` target names: the target itself when it is a
 * string, else the first preferred condition (recursing one level for a
 * nested condition object). `null` when no string target is found.
 *
 * A condition object often offers BOTH `types` (`./dist/index.d.ts`) and
 * `import` (`./dist/index.js`). The declaration file names no symbols, so a
 * non-declaration target wins over it; the declaration is kept only when it is
 * the sole option (or is itself real source, e.g. `./src/index.ts`).
 */
function pickExportTarget(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  let declaration: string | null = null;
  for (const condition of EXPORT_CONDITION_PREFERENCE) {
    const nested = obj[condition];
    const target = typeof nested === 'string' && nested.trim()
      ? nested.trim()
      : (nested && typeof nested === 'object' ? pickExportTarget(nested) : null);
    if (!target) continue;
    if (DECLARATION_FILE.test(target)) { declaration ??= target; continue; }
    return target;
  }
  // A non-standard condition key — accept a non-declaration string target.
  for (const nested of Object.values(obj)) {
    if (typeof nested === 'string' && nested.trim() && !DECLARATION_FILE.test(nested.trim())) {
      return nested.trim();
    }
  }
  return declaration;
}

/**
 * Resolve a manifest-declared target to a projectRoot-relative posix path.
 * A target that is empty or escapes the project root is refused — a workspace
 * member can never legally reach outside the monorepo.
 */
function normalizeDeclaredTarget(projectRoot: string, dirRel: string, target: string): string | null {
  const cleaned = target.trim();
  if (!cleaned) return null;
  const abs = path.resolve(projectRoot, dirRel, cleaned);
  const rel = path.relative(projectRoot, abs).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel;
}
