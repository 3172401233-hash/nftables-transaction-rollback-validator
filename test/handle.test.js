import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRecoveryOrder, verifyTransaction } from '../src/index.js';
import { duplicateHandleBatch, snapshotWithRules } from './helpers.js';

test('atomic batch rolls everything back when a deleted handle is deleted again', () => {
  const input = { snapshot: snapshotWithRules(), batch: duplicateHandleBatch() };
  const report = verifyTransaction(input);

  assert.equal(report.ok, false);
  assert.equal(report.status, 'rolled-back');
  assert.equal(report.committed, false);
  assert.equal(report.rollbackScope, 'whole-batch');
  assert.equal(report.classification.wholeBatchFailure, true);
  assert.equal(report.failedCommands.length, 1);

  const failure = report.failedCommands[0];
  assert.equal(failure.code, 'STALE_HANDLE');
  assert.equal(failure.commandId, 'delete-obsolete-twice');
  assert.equal(failure.position, 3);
  assert.equal(failure.stale, true);
  assert.equal(failure.details.deletedAt, 1);
  assert.equal(failure.details.deletedCommandId, 'delete-obsolete-once');

  assert.deepEqual(report.committedRules.map((rule) => rule.handle), [10, 20, 99]);
  assert.equal(report.finalRuleset.chains.some((chain) => chain.name === 'web'), true);
  assert.equal(report.retry.safeToRetry, false);
  assert.match(report.retry.strategy, /refresh-snapshot/);
  assert.equal(report.recoveryOrder[0].op, 'restore-snapshot');
});

test('a rule positioned after a handle deleted earlier in the batch is stale', () => {
  const report = verifyTransaction({
    snapshot: snapshotWithRules(),
    batch: [
      { id: 'delete-anchor', op: 'delete-rule', family: 'inet', table: 'filter', chain: 'input', handle: 10 },
      {
        id: 'insert-after-anchor',
        op: 'add-rule',
        family: 'inet',
        table: 'filter',
        chain: 'input',
        afterHandle: 10,
        newHandle: 101,
        expression: 'tcp dport 22 accept',
        action: 'accept',
      },
    ],
  });

  assert.equal(report.ok, false);
  assert.equal(report.failedCommands[0].code, 'STALE_HANDLE');
  assert.equal(report.failedCommands[0].commandId, 'insert-after-anchor');
  assert.deepEqual(report.committedRules.map((rule) => rule.handle), [10, 20, 99]);
});

test('valid before/after handle placement determines final rule order', () => {
  const report = verifyTransaction({
    snapshot: snapshotWithRules(),
    batch: [
      {
        id: 'before-20',
        op: 'add-rule',
        family: 'inet',
        table: 'filter',
        chain: 'input',
        beforeHandle: 20,
        newHandle: 101,
        expression: 'tcp dport 22 accept',
      },
      {
        id: 'after-20',
        op: 'add-rule',
        family: 'inet',
        table: 'filter',
        chain: 'input',
        afterHandle: 20,
        newHandle: 102,
        expression: 'tcp dport 443 accept',
      },
    ],
  });

  assert.equal(report.ok, true);
  const inputRules = report.committedRules.filter((rule) => rule.chain === 'input');
  assert.deepEqual(inputRules.map((rule) => rule.handle), [10, 101, 20, 102, 99]);
});

test('deleting a chain referenced by jump rules fails until referencing rules are removed', () => {
  const referencedSnapshot = snapshotWithRules();
  referencedSnapshot.rules.push({
    handle: 77,
    chain: 'input',
    expression: 'tcp dport 80 jump web',
    verdict: { jump: 'web' },
  });

  const blocked = verifyTransaction({
    snapshot: referencedSnapshot,
    batch: [
      { id: 'delete-web', op: 'delete-chain', family: 'inet', table: 'filter', chain: 'web' },
    ],
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.failedCommands[0].code, 'CHAIN_REFERENCED');
  assert.deepEqual(blocked.failedCommands[0].details.references.map((ref) => ref.handle), [77]);
  assert.ok(blocked.finalRuleset.chains.some((chain) => chain.name === 'web'));

  const freed = verifyTransaction({
    snapshot: referencedSnapshot,
    batch: [
      { id: 'delete-jump', op: 'delete-rule', family: 'inet', table: 'filter', chain: 'input', handle: 77 },
      { id: 'delete-web', op: 'delete-chain', family: 'inet', table: 'filter', chain: 'web' },
    ],
  });
  assert.equal(freed.ok, true);
  assert.equal(freed.finalRuleset.chains.some((chain) => chain.name === 'web'), false);
});

test('per-command commit exposes simultaneous accept and drop rules but reverse recovery restores snapshot', () => {
  const input = { snapshot: snapshotWithRules(), batch: duplicateHandleBatch(), mode: 'per-command' };
  const report = verifyTransaction(input);

  assert.equal(report.status, 'partially-committed');
  assert.equal(report.rollbackScope, 'applied-commands');
  assert.equal(report.mixedState.simultaneousAllowAndDeny, true);
  assert.deepEqual(report.mixedState.groups[0].accept, [100]);
  assert.deepEqual(report.mixedState.groups[0].deny, [20]);
  assert.deepEqual(report.committedRules.map((rule) => rule.handle), [10, 20, 100]);

  const inverse = report.recovery.inverseCommands;
  assert.equal(inverse[0].op, 'restore-rule');
  assert.equal(inverse[0].rule.handle, 99);
  assert.equal(inverse[1].order, 2);
  assert.equal(inverse[1].op, 'delete-rule');
  assert.equal(inverse[1].handle, 100);
  assert.equal(inverse[1].inverseOfCommandIndex, 0);
  assert.equal(inverse[1].inverseOfCommandId, 'allow-http');

  const restored = applyRecoveryOrder(report.finalRuleset, report.recoveryOrder, report.snapshot);
  assert.deepEqual(restored.rules.map((rule) => rule.handle), [10, 20, 99]);
  assert.deepEqual(restored.sets[0].elements.map((element) => element.value), ['198.51.100.10']);
});
