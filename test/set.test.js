import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRecoveryOrder, verifyTransaction } from '../src/index.js';
import { snapshotWithRules } from './helpers.js';

test('strict set element conflict fails the whole atomic batch and rolls earlier rule back', () => {
  const report = verifyTransaction({
    snapshot: snapshotWithRules(),
    batch: [
      {
        id: 'allow-from-set',
        op: 'add-rule',
        family: 'inet',
        table: 'filter',
        chain: 'input',
        newHandle: 110,
        expression: 'ip saddr @trusted_v4 accept',
        action: 'accept',
      },
      {
        id: 'duplicate-element',
        op: 'add-element',
        family: 'inet',
        table: 'filter',
        set: 'trusted_v4',
        elements: ['198.51.100.10'],
        conflict: 'fail',
      },
    ],
  });

  assert.equal(report.ok, false);
  assert.equal(report.failedCommands[0].code, 'ELEMENT_CONFLICT');
  assert.equal(report.rollbackScope, 'whole-batch');
  assert.deepEqual(report.committedRules.map((rule) => rule.handle), [10, 20, 99]);
  assert.deepEqual(report.finalRuleset.sets[0].elements.map((element) => element.value), ['198.51.100.10']);
  assert.equal(report.retry.safeToRetry, false);
  assert.match(report.retry.strategy, /resolve-set-conflict/);
});

test('duplicate element is ignored by default but invalid set type still fails', () => {
  const idempotent = verifyTransaction({
    snapshot: snapshotWithRules(),
    batch: [
      {
        op: 'add-element',
        family: 'inet',
        table: 'filter',
        set: 'trusted_v4',
        elements: ['198.51.100.10', '203.0.113.8'],
      },
    ],
  });
  assert.equal(idempotent.ok, true);
  assert.deepEqual(
    idempotent.finalRuleset.sets[0].elements.map((element) => element.value),
    ['198.51.100.10', '203.0.113.8'],
  );
  assert.equal(idempotent.commandResults[0].effects.skipped[0], '198.51.100.10');

  const invalid = verifyTransaction({
    snapshot: snapshotWithRules(),
    batch: [
      {
        id: 'bad-ip',
        op: 'add-element',
        family: 'inet',
        table: 'filter',
        set: 'trusted_v4',
        elements: ['not-an-ip'],
      },
    ],
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.failedCommands[0].code, 'SET_TYPE_CONFLICT');
});

test('duplicate flush is safe and creates only one effective element restore step', () => {
  const doubleFlush = verifyTransaction({
    snapshot: snapshotWithRules(),
    batch: [
      { id: 'flush-1', op: 'flush-set', family: 'inet', table: 'filter', set: 'trusted_v4' },
      { id: 'flush-2', op: 'flush-set', family: 'inet', table: 'filter', set: 'trusted_v4' },
    ],
  });
  assert.equal(doubleFlush.ok, true);
  assert.equal(doubleFlush.commandResults[0].status, 'applied');
  assert.equal(doubleFlush.commandResults[1].status, 'unchanged');
  assert.equal(doubleFlush.commandResults[1].duplicateFlush, true);
  assert.deepEqual(doubleFlush.finalRuleset.sets[0].elements, []);

  const partial = verifyTransaction({
    snapshot: snapshotWithRules(),
    mode: 'per-command',
    batch: [
      { id: 'flush-1', op: 'flush-set', family: 'inet', table: 'filter', set: 'trusted_v4' },
      { id: 'flush-2', op: 'flush-set', family: 'inet', table: 'filter', set: 'trusted_v4' },
      { id: 'missing-rule', op: 'delete-rule', family: 'inet', table: 'filter', chain: 'input', handle: 404 },
    ],
  });
  assert.equal(partial.ok, false);
  assert.equal(partial.failedCommands[0].code, 'RULE_HANDLE_NOT_FOUND');
  assert.equal(partial.finalRuleset.sets[0].elements.length, 0);

  const restoreSteps = partial.recovery.inverseCommands.filter((step) => step.op === 'restore-elements');
  assert.equal(restoreSteps.length, 1);
  assert.deepEqual(restoreSteps[0].elements.map((element) => element.value), ['198.51.100.10']);

  const restored = applyRecoveryOrder(partial.finalRuleset, partial.recoveryOrder, partial.snapshot);
  assert.deepEqual(restored.sets[0].elements.map((element) => element.value), ['198.51.100.10']);
});

test('flush table clears rules and set elements but duplicate flush remains idempotent', () => {
  const report = verifyTransaction({
    snapshot: snapshotWithRules(),
    batch: [
      { id: 'flush-table-1', op: 'flush-table', family: 'inet', table: 'filter' },
      { id: 'flush-table-2', op: 'flush-table', family: 'inet', table: 'filter' },
    ],
  });
  assert.equal(report.ok, true);
  assert.equal(report.finalRuleset.rules.length, 0);
  assert.equal(report.finalRuleset.sets[0].elements.length, 0);
  assert.equal(report.commandResults[1].duplicateFlush, true);
});
