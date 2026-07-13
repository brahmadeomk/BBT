'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FLOWS_PATH = path.join(__dirname, '..', 'flows', 'flows_BBT.json');

describe('flows_BBT.json integrity', () => {
  test('is valid JSON', () => {
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8')));
  });

  test('every wires/links reference points at a real node id', () => {
    const nodes = JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));
    const ids = new Set(nodes.map((n) => n.id));
    const dangling = [];

    for (const n of nodes) {
      for (const out of n.wires || []) {
        for (const target of out) {
          if (!ids.has(target)) dangling.push(`${n.id} (${n.type} ${n.name || ''}) wires -> missing '${target}'`);
        }
      }
      for (const linked of n.links || []) {
        if (!ids.has(linked)) dangling.push(`${n.id} (${n.type} ${n.name || ''}) links -> missing '${linked}'`);
      }
    }

    assert.deepEqual(dangling, []);
  });

  test('link in/out nodes are mutually paired', () => {
    const nodes = JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const mismatches = [];

    for (const n of nodes) {
      if (n.type !== 'link in' && n.type !== 'link out') continue;
      for (const otherId of n.links || []) {
        const other = byId.get(otherId);
        if (!other) continue; // already reported by the dangling-reference test
        if (!(other.links || []).includes(n.id)) {
          mismatches.push(`${n.id} (${n.type} ${n.name || ''}) -> ${otherId} is not paired back`);
        }
      }
    }

    assert.deepEqual(mismatches, []);
  });
});
