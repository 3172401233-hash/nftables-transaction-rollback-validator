import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { verifyTransaction } from '../src/index.js';

test('top-level table, chain, priority, ruleHandle and elements fill commands', () => {
  const report = verifyTransaction({
    family: 'inet',
    table: 'filter',
    chain: 'input',
    priority: -10,
    ruleHandle: 7,
    elements: ['203.0.113.9'],
    snapshot: {
      tables: ['filter'],
      chains: [
        { name: 'input', priority: 0 },
        { name: 'tokens', type: 'filter', hook: 'input', priority: 0 },
      ],
      sets: [{ name: 'blocklist', type: 'ipv4_addr' }],
      rules: [{ handle: 7, expression: 'tcp dport 23 accept', action: 'accept' }],
    },
    batch: [
      { op: 'add-chain', chain: 'management' },
      { op: 'set-chain-priority', chain: 'tokens', priority: 22 },
      { op: 'delete-rule' },
      { op: 'add-element', set: 'blocklist' },
    ],
  });

  assert.equal(report.ok, true);
  const management = report.finalRuleset.chains.find((chain) => chain.name === 'management');
  assert.equal(management.priority, -10);
  assert.equal(report.finalRuleset.chains.find((chain) => chain.name === 'tokens').priority, 22);
  assert.deepEqual(report.committedRules.map((rule) => rule.handle), []);
  assert.deepEqual(report.finalRuleset.sets[0].elements.map((element) => element.value), ['203.0.113.9']);
});

test('parses nft-like batch strings including chain priority', () => {
  const report = verifyTransaction({
    family: 'inet',
    table: 'filter',
    snapshot: { tables: ['filter'] },
    batch: [
      'add chain inet filter input { type filter hook input priority -10; policy drop; }',
      'add rule inet filter input tcp dport 22 accept',
    ],
  });
  assert.equal(report.ok, true);
  assert.equal(report.finalRuleset.chains[0].hook, 'input');
  assert.equal(report.finalRuleset.chains[0].priority, -10);
  assert.equal(report.committedRules[0].handle, 1);
  assert.match(report.committedRules[0].expression, /tcp dport 22 accept/);
});

test('CLI prints JSON report for example and strict mode fails on unsuccessful transaction', () => {
  const run = spawnSync(process.execPath, ['bin/nft-tx-verify.js', 'examples/handle-stale-batch.json'], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.executesRealNft, false);
  assert.equal(report.failedCommands[0].code, 'STALE_HANDLE');
  assert.ok(Array.isArray(report.recoveryOrder));

  const strict = spawnSync(process.execPath, ['bin/nft-tx-verify.js', '--strict', 'examples/handle-stale-batch.json'], {
    encoding: 'utf8',
  });
  assert.equal(strict.status, 1);
});
