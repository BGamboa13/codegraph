/**
 * Cross-crate references in a Cargo workspace: a path written from one member
 * crate into another (`sim::items::ItemPool::for_def(…)`), through a re-export
 * (`pub use rng::Rng`), through a renamed or non-member path dependency, and
 * the `crate::` / `super::` paths inside a member crate.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

let root: string;
let cg: CodeGraph | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-cross-crate-')); });
afterEach(() => { cg?.close(); cg = undefined; fs.rmSync(root, { recursive: true, force: true }); });

async function index(files: Record<string, string>) {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  cg = await CodeGraph.init(root, { index: true });
}

/** `file:qualifiedName` of everything that has an edge of `kind` into the named symbol. */
function sources(file: string, qualifiedName: string, kind = 'calls'): string[] {
  const target = cg!.getNodesInFile(file).find((n) => n.qualifiedName === qualifiedName);
  expect(target, `${file}:${qualifiedName}`).toBeDefined();
  return cg!.getIncomingEdges(target!.id).filter((e) => e.kind === kind).map((e) => {
    const src = cg!.getNode(e.source)!;
    return `${src.filePath}:${src.qualifiedName}`;
  }).sort();
}

const WORKSPACE = `[workspace]
resolver = "2"
members = ["crates/sim", "crates/server", "crates/client"]

[workspace.dependencies]
sim = { path = "crates/sim" }
`;
const SIM_TOML = '[package]\nname = "sim"\nversion = "0.1.0"\nedition = "2021"\n';
const SIM_LIB = `pub mod items;
mod rng;
pub use rng::Rng;
pub const RANK_COUNT: usize = 6;
pub fn median_u32(v: &[u32]) -> u32 { v[0] }
`;
const SIM_ITEMS = `pub struct ItemPool { pub n: u32 }
impl ItemPool {
    pub fn for_def(def: u32) -> ItemPool { ItemPool { n: def } }
}
pub enum Drop { Gold(u32), Nothing }
pub fn roll_item(p: &ItemPool) -> u32 { p.n }
`;
const SIM_RNG = 'pub struct Rng { s: u64 }\nimpl Rng {\n    pub fn new(s: u64) -> Rng { Rng { s } }\n}\n';

const base = (server: Record<string, string>, serverToml = '[package]\nname = "server"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nsim.workspace = true\n') => ({
  'Cargo.toml': WORKSPACE,
  'crates/sim/Cargo.toml': SIM_TOML,
  'crates/sim/src/lib.rs': SIM_LIB,
  'crates/sim/src/items.rs': SIM_ITEMS,
  'crates/sim/src/rng.rs': SIM_RNG,
  // A decoy: the same type and method names in another member crate.
  'crates/client/Cargo.toml': '[package]\nname = "client"\nversion = "0.1.0"\nedition = "2021"\n',
  'crates/client/src/lib.rs': 'pub mod items;\n',
  'crates/client/src/items.rs': 'pub struct ItemPool;\nimpl ItemPool {\n    pub fn for_def(def: u32) -> ItemPool { ItemPool }\n}\npub fn roll_item() -> u32 { 0 }\n',
  'crates/server/Cargo.toml': serverToml,
  ...Object.fromEntries(Object.entries(server).map(([f, t]) => [`crates/server/src/${f}`, t])),
});

it('resolves a fully qualified call into another workspace crate to that crate', async () => {
  await index(base({
    'lib.rs': 'pub mod rift;\npub mod econ;\n',
    'rift.rs': 'pub fn open() -> u32 {\n    let pool = sim::items::ItemPool::for_def(3);\n    sim::items::roll_item(&pool)\n}\n',
    'econ/mod.rs': 'pub mod offline;\n',
    'econ/offline.rs': 'pub fn tick() {\n    let _ = sim::items::ItemPool::for_def(\n        4,\n    );\n}\n',
  }));
  expect(sources('crates/sim/src/items.rs', 'ItemPool::for_def')).toEqual([
    'crates/server/src/econ/offline.rs:tick',
    'crates/server/src/rift.rs:open',
  ]);
  expect(sources('crates/sim/src/items.rs', 'roll_item')).toEqual(['crates/server/src/rift.rs:open']);
  expect(sources('crates/client/src/items.rs', 'ItemPool::for_def')).toEqual([]);
});

it('resolves a crate-root item, a re-export, a constant, and an enum variant across crates', async () => {
  await index(base({
    'lib.rs': 'pub mod rift;\n',
    'rift.rs': `use sim::RANK_COUNT;
pub fn open(v: &[u32]) -> usize {
    let _r = sim::Rng::new(7);
    let _m = sim::median_u32(v);
    let _d = sim::items::Drop::Gold(3);
    RANK_COUNT
}
`,
  }));
  expect(sources('crates/sim/src/rng.rs', 'Rng::new')).toEqual(['crates/server/src/rift.rs:open']);
  expect(sources('crates/sim/src/lib.rs', 'median_u32')).toEqual(['crates/server/src/rift.rs:open']);
  expect(sources('crates/sim/src/items.rs', 'Drop::Gold')).toEqual(['crates/server/src/rift.rs:open']);
  expect(sources('crates/sim/src/lib.rs', 'RANK_COUNT', 'imports')).toEqual(['crates/server/src/rift.rs:crates/server/src/rift.rs']);
});

it('resolves `use` imports of another crate and the calls through them', async () => {
  await index(base({
    'lib.rs': 'pub mod rift;\n',
    'rift.rs': `use sim::items::{roll_item, ItemPool};
use sim::Rng;
pub fn open() -> u32 {
    let _r = Rng::new(1);
    roll_item(&ItemPool::for_def(2))
}
`,
  }));
  expect(sources('crates/sim/src/items.rs', 'ItemPool::for_def')).toEqual(['crates/server/src/rift.rs:open']);
  expect(sources('crates/sim/src/items.rs', 'roll_item')).toEqual(['crates/server/src/rift.rs:open']);
  expect(sources('crates/sim/src/rng.rs', 'Rng::new')).toEqual(['crates/server/src/rift.rs:open']);
  expect(sources('crates/sim/src/items.rs', 'ItemPool', 'imports').length).toBeGreaterThan(0);
  expect(sources('crates/sim/src/rng.rs', 'Rng', 'imports').length).toBeGreaterThan(0);
});

it('resolves a renamed path dependency and a path dependency outside the workspace members', async () => {
  await index({
    ...base(
      { 'lib.rs': 'pub fn open() -> u32 {\n    let p = core_sim::items::ItemPool::for_def(1);\n    vendored::helper(p.n)\n}\n' },
      '[package]\nname = "server"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\ncore_sim = { path = "../sim", package = "sim" }\nvendored = { path = "../../libs/vendored" }\n',
    ),
    'libs/vendored/Cargo.toml': '[package]\nname = "vendored"\nversion = "0.1.0"\nedition = "2021"\n',
    'libs/vendored/src/lib.rs': 'pub fn helper(n: u32) -> u32 { n }\n',
  });
  expect(sources('crates/sim/src/items.rs', 'ItemPool::for_def')).toEqual(['crates/server/src/lib.rs:open']);
  expect(sources('libs/vendored/src/lib.rs', 'helper')).toEqual(['crates/server/src/lib.rs:open']);
});

it('resolves `crate::` and `super::` paths inside a member crate, constants included', async () => {
  await index(base({
    'lib.rs': 'pub mod ledger;\npub mod econ;\n',
    'ledger.rs': 'pub const KEY_RANK_COUNT: usize = 6;\npub static LIMIT: u32 = 9;\npub fn persist() {}\n',
    'econ/mod.rs': 'pub mod sinks;\npub fn shared() {}\n',
    'econ/sinks.rs': `use crate::ledger::{KEY_RANK_COUNT, LIMIT};
pub fn drain() -> usize {
    crate::ledger::persist();
    super::shared();
    KEY_RANK_COUNT + LIMIT as usize
}
`,
  }));
  expect(sources('crates/server/src/ledger.rs', 'persist')).toEqual(['crates/server/src/econ/sinks.rs:drain']);
  expect(sources('crates/server/src/econ/mod.rs', 'shared')).toEqual(['crates/server/src/econ/sinks.rs:drain']);
  expect(sources('crates/server/src/ledger.rs', 'KEY_RANK_COUNT', 'imports').length).toBeGreaterThan(0);
  expect(sources('crates/server/src/ledger.rs', 'LIMIT', 'imports').length).toBeGreaterThan(0);
});
