import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyTransaction } from '../src/index.js';

test('one batch can touch table, chain priority, set elements and handles before stale failure', () => {
  const report = verifyTransaction({
    family: 'inet',
    table: 'filter',
    chain: 'input',
    priority: -10,
    ruleHandle: 30,
    elements: ['203.0.113.10'],
    snapshot: {
      tables: [{ family: 'inet', name: 'filter' }],
      chains: [{ family: 'inet', table: 'filter', name: 'input', hook: 'input', priority: 0 }],
      rules: [{ handle: 30, chain: 'input', expression: 'tcp dport 22 accept', action: 'accept' }],
    },
    batch: [
      { id: 'new-table', op: 'add-table', family: 'inet', table: 'raw' },
      { id: 'new-chain', op: 'add-chain', family: 'inet', table: 'raw', chain: 'counters', priority: -150 },
      { id: 'priority', op: 'set-chain-priority', chain: 'input', priority: -1 },
      { id: 'new-set', op: 'add-set', set: 'operators', type: 'ipv4_addr' },
      { id: 'set-element', op: 'add-element', set: 'operators' },
      { id: 'new-rule', op: 'add-rule', newHandle: 100, expression: 'ip saddr @operators accept', action: 'accept' },
      { id: 'delete-old-rule', op: 'delete-rule' },
      { id: 'replace-deleted-rule', op: 'replace-rule', expression: 'tcp dport 22 drop', action: 'drop' },
    ],
  });

  assert.equal(report.ok, false);
  assert.equal(report.failedCommands[0].code, 'STALE_HANDLE');
  assert.equal(report.failedCommands[0].commandId, 'replace-deleted-rule');
  assert.equal(report.failedCommands[0].details.deletedCommandId, 'delete-old-rule');
  assert.equal(report.rollbackScope, 'whole-batch');

  assert.deepEqual(report.committedRules.map((rule) => rule.handle), [30]);
  assert.equal(report.finalRuleset.tables.some((table) => table.name === 'raw'), false);
  assert.equal(report.finalRuleset.sets.some((set) => set.name === 'operators'), false);
  assert.equal(report.finalRuleset.chains.find((chain) => chain.name === 'input').priority, 0);
  assert.equal(report.recoveryOrder[0].op, 'restore-snapshot');
});
