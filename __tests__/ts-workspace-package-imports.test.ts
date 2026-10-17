/**
 * A TypeScript npm / pnpm / yarn workspace member imported BY PACKAGE NAME
 * (`import { Widget } from '@acme/ui'`) resolves to the member's real source
 * file named by its package.json `exports` / `main` — not just its directory.
 * That lets the resolver follow a re-export, including an aliased
 * `export { Thing as Widget } from './thing'`, so callers of the aliased name
 * are found even though no symbol named `Widget` is ever declared.
 *
 * The specifier looks exactly like a third-party npm package, so the two bugs
 * this pins are:
 *   A. a bare workspace member (`@acme/ui`) is not treated as a path, so
 *      workspace resolution never runs and the file→file `imports` edge is
 *      missing; and
 *   B. the member maps to its DIRECTORY, ignoring `exports` / `main`, so the
 *      entry file under `src/` is never reached.
 *
 * An external npm specifier must stay external, and a relative import must
 * keep resolving.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

let root: string;
let cg: CodeGraph | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ts-ws-pkg-')); });
afterEach(() => { cg?.close(); cg = undefined; fs.rmSync(root, { recursive: true, force: true }); });

async function index(files: Record<string, string>) {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  cg = await CodeGraph.init(root, { index: true });
}

function node(file: string, name: string) {
  const n = cg!.getNodesInFile(file).find((x) => x.name === name);
  expect(n, `${file}:${name}`).toBeDefined();
  return n!;
}

/** `file:qualifiedName` of the sources of every `kind` edge into `file:name`. */
function incoming(file: string, name: string, kind: string): string[] {
  return cg!.getIncomingEdges(node(file, name).id)
    .filter((e) => e.kind === kind)
    .map((e) => {
      const src = cg!.getNode(e.source);
      return src ? `${src.filePath}:${src.qualifiedName}` : '?';
    })
    .sort();
}

/** `file:qualifiedName` of every caller (a `calls` edge) that resolves into `file:name`. */
function callers(file: string, name: string): string[] {
  return incoming(file, name, 'calls');
}

/** `file:qualifiedName` of every `imports`-edge source into `file`. */
function importers(file: string): string[] {
  const fileNode = cg!.getNodesInFile(file).find((n) => n.kind === 'file');
  expect(fileNode, `file node ${file}`).toBeDefined();
  return cg!.getIncomingEdges(fileNode!.id)
    .filter((e) => e.kind === 'imports')
    .map((e) => {
      const src = cg!.getNode(e.source);
      return src ? `${src.filePath}:${src.qualifiedName}` : '?';
    })
    .sort();
}

const PNPM = 'packages:\n  - "packages/*"\n  - "apps/*"\n';
const UI_PKG = JSON.stringify({
  name: '@acme/ui',
  version: '1.0.0',
  exports: { '.': './src/index.ts', './nodes': './src/nodes/index.ts' },
});

/** package.json `workspaces` (npm/yarn) or pnpm-workspace.yaml pointing at packages/*. */
function rootFiles(pnpm: boolean): Record<string, string> {
  return pnpm
    ? { 'pnpm-workspace.yaml': PNPM }
    : { 'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*', 'apps/*'] }) };
}

const UI_FILES: Record<string, string> = {
  'packages/ui/package.json': UI_PKG,
  // Aliased barrel: `Widget` is never declared anywhere.
  'packages/ui/src/index.ts': `export { Thing as Widget } from './thing';\n`,
  'packages/ui/src/thing.ts': 'export function Thing() {}\n',
  'packages/ui/src/nodes/index.ts': `export { Node } from './node';\n`,
  'packages/ui/src/nodes/node.ts': 'export function Node() {}\n',
};

it('resolves a bare member import to the package.json `exports` entry and follows an aliased re-export', async () => {
  await index({
    ...rootFiles(true),
    ...UI_FILES,
    'apps/web/consumer.ts': `import { Widget } from '@acme/ui';\nexport function use() { Widget(); }\n`,
  });

  expect(callers('packages/ui/src/thing.ts', 'Thing')).toEqual(['apps/web/consumer.ts:use']);
  expect(importers('packages/ui/src/index.ts')).toEqual(['apps/web/consumer.ts:apps/web/consumer.ts']);
});

it('resolves a subpath export (`@acme/ui/nodes`) to the declared subpath entry', async () => {
  await index({
    ...rootFiles(true),
    ...UI_FILES,
    'apps/web/consumer-nodes.ts': `import { Node } from '@acme/ui/nodes';\nexport function useNode() { Node(); }\n`,
  });

  expect(callers('packages/ui/src/nodes/node.ts', 'Node')).toEqual(['apps/web/consumer-nodes.ts:useNode']);
  expect(importers('packages/ui/src/nodes/index.ts')).toEqual(['apps/web/consumer-nodes.ts:apps/web/consumer-nodes.ts']);
});

it('falls back to package.json `main` when there is no `exports` map', async () => {
  await index({
    'pnpm-workspace.yaml': PNPM,
    'packages/lib/package.json': JSON.stringify({ name: '@acme/lib', main: './src/index.ts' }),
    'packages/lib/src/index.ts': `export { Thing as Widget } from './thing';\n`,
    'packages/lib/src/thing.ts': 'export function Thing() {}\n',
    'apps/web/consumer.ts': `import { Widget } from '@acme/lib';\nexport function use() { Widget(); }\n`,
  });

  expect(callers('packages/lib/src/thing.ts', 'Thing')).toEqual(['apps/web/consumer.ts:use']);
  expect(importers('packages/lib/src/index.ts')).toEqual(['apps/web/consumer.ts:apps/web/consumer.ts']);
});

it('resolves workspace members declared with npm/yarn package.json `workspaces`', async () => {
  await index({
    ...rootFiles(false),
    ...UI_FILES,
    'apps/web/consumer.ts': `import { Widget } from '@acme/ui';\nexport function use() { Widget(); }\n`,
  });

  expect(callers('packages/ui/src/thing.ts', 'Thing')).toEqual(['apps/web/consumer.ts:use']);
});

it('reads a conditional root export and a wildcard subpath export', async () => {
  await index({
    'pnpm-workspace.yaml': PNPM,
    'packages/pkg/package.json': JSON.stringify({
      name: '@acme/pkg',
      exports: {
        '.': { import: './src/index.ts', types: './src/index.ts' },
        './items/*': './src/items/*.ts',
      },
    }),
    'packages/pkg/src/index.ts': `export { Thing as Widget } from './thing';\n`,
    'packages/pkg/src/thing.ts': 'export function Thing() {}\n',
    'packages/pkg/src/items/one.ts': 'export function One() {}\n',
    'apps/web/a.ts': `import { Widget } from '@acme/pkg';\nexport function use() { Widget(); }\n`,
    'apps/web/b.ts': `import { One } from '@acme/pkg/items/one';\nexport function useOne() { One(); }\n`,
  });

  expect(callers('packages/pkg/src/thing.ts', 'Thing')).toEqual(['apps/web/a.ts:use']);
  expect(importers('packages/pkg/src/index.ts')).toEqual(['apps/web/a.ts:apps/web/a.ts']);
  expect(callers('packages/pkg/src/items/one.ts', 'One')).toEqual(['apps/web/b.ts:useOne']);
  expect(importers('packages/pkg/src/items/one.ts')).toEqual(['apps/web/b.ts:apps/web/b.ts']);
});

it('falls back to the package directory when a declared build-output entry is absent', async () => {
  await index({
    'pnpm-workspace.yaml': PNPM,
    // `main` names build output that is NOT on disk. Pre-change behaviour:
    // resolve the package directory and its index-file convention.
    'packages/pkg/package.json': JSON.stringify({ name: '@acme/pkg', main: './dist/index.js' }),
    'packages/pkg/index.ts': `export { Thing as Widget } from './thing';\n`,
    'packages/pkg/thing.ts': 'export function Thing() {}\n',
    'apps/web/consumer.ts': `import { Widget } from '@acme/pkg';\nexport function use() { Widget(); }\n`,
  });

  expect(callers('packages/pkg/thing.ts', 'Thing')).toEqual(['apps/web/consumer.ts:use']);
  expect(importers('packages/pkg/index.ts')).toEqual(['apps/web/consumer.ts:apps/web/consumer.ts']);
});

it('maps a declared dist entry onto the same path under src/', async () => {
  await index({
    'pnpm-workspace.yaml': PNPM,
    'packages/pkg/package.json': JSON.stringify({ name: '@acme/pkg', main: './dist/index.js' }),
    'packages/pkg/src/index.ts': `export { Thing as Widget } from './thing';\n`,
    'packages/pkg/src/thing.ts': 'export function Thing() {}\n',
    'apps/web/consumer.ts': `import { Widget } from '@acme/pkg';\nexport function use() { Widget(); }\n`,
  });

  expect(callers('packages/pkg/src/thing.ts', 'Thing')).toEqual(['apps/web/consumer.ts:use']);
  expect(importers('packages/pkg/src/index.ts')).toEqual(['apps/web/consumer.ts:apps/web/consumer.ts']);
});

it('ignores a declared dist entry present on disk but not indexed, falling back to the directory', async () => {
  await index({
    'pnpm-workspace.yaml': PNPM,
    // `dist/` is present on disk but gitignored, so it is NOT in the graph.
    '.gitignore': 'dist/\n',
    'packages/pkg/package.json': JSON.stringify({ name: '@acme/pkg', main: './dist/index.js' }),
    'packages/pkg/dist/index.js': 'export const built = true;\n',
    'packages/pkg/index.ts': `export { Thing as Widget } from './thing';\n`,
    'packages/pkg/thing.ts': 'export function Thing() {}\n',
    'apps/web/consumer.ts': `import { Widget } from '@acme/pkg';\nexport function use() { Widget(); }\n`,
  });

  expect(callers('packages/pkg/thing.ts', 'Thing')).toEqual(['apps/web/consumer.ts:use']);
  expect(importers('packages/pkg/index.ts')).toEqual(['apps/web/consumer.ts:apps/web/consumer.ts']);
});

it('prefers a non-declaration export condition and maps it onto src/', async () => {
  await index({
    'pnpm-workspace.yaml': PNPM,
    'packages/pkg/package.json': JSON.stringify({
      name: '@acme/pkg',
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
    }),
    'packages/pkg/src/index.ts': `export { Thing as Widget } from './thing';\n`,
    'packages/pkg/src/thing.ts': 'export function Thing() {}\n',
    'apps/web/consumer.ts': `import { Widget } from '@acme/pkg';\nexport function use() { Widget(); }\n`,
  });

  expect(callers('packages/pkg/src/thing.ts', 'Thing')).toEqual(['apps/web/consumer.ts:use']);
  expect(importers('packages/pkg/src/index.ts')).toEqual(['apps/web/consumer.ts:apps/web/consumer.ts']);
});

it('maps a declared dist subpath onto src/ and falls back to the subpath directory', async () => {
  await index({
    'pnpm-workspace.yaml': PNPM,
    'packages/pkg/package.json': JSON.stringify({
      name: '@acme/pkg',
      exports: { './nodes': './dist/nodes/index.js', './legacy': './dist/legacy/index.js' },
    }),
    'packages/pkg/src/nodes/index.ts': `export { Node } from './node';\n`,
    'packages/pkg/src/nodes/node.ts': 'export function Node() {}\n',
    'packages/pkg/legacy/index.ts': 'export function Legacy() {}\n',
    'apps/web/consumer-nodes.ts': `import { Node } from '@acme/pkg/nodes';\nexport function useNode() { Node(); }\n`,
    'apps/web/consumer-legacy.ts': `import { Legacy } from '@acme/pkg/legacy';\nexport function useLegacy() { Legacy(); }\n`,
  });

  expect(importers('packages/pkg/src/nodes/index.ts')).toEqual(['apps/web/consumer-nodes.ts:apps/web/consumer-nodes.ts']);
  expect(importers('packages/pkg/legacy/index.ts')).toEqual(['apps/web/consumer-legacy.ts:apps/web/consumer-legacy.ts']);
});

it('leaves an external npm import external while a relative import keeps working', async () => {
  await index({
    'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
    'packages/ui/package.json': JSON.stringify({ name: '@acme/ui' }),
    'packages/ui/src/index.ts': 'export function Widget() {}\n',
    'src/helper.ts': 'export function helper() {}\n',
    'src/app.ts': [
      `import React from 'react';`,
      `import { helper } from './helper';`,
      `export function go() { helper(); return React.createElement('div', null); }`,
      '',
    ].join('\n'),
  });

  expect(callers('src/helper.ts', 'helper')).toEqual(['src/app.ts:go']);

  const appFile = cg!.getNodesInFile('src/app.ts').find((n) => n.kind === 'file')!;
  const targetPaths = cg!.getOutgoingEdges(appFile.id)
    .filter((e) => e.kind === 'imports')
    .map((e) => cg!.getNode(e.target)?.filePath);
  expect(targetPaths).toContain('src/helper.ts');
  // `react` is not a workspace member: it must not resolve into the project.
  expect(targetPaths).not.toContain('packages/ui/src/index.ts');
});
