import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRecoveryOrder, verifyTransaction } from '../src/index.js';
import { snapshotWithRules } from './helpers.js';

function addRule(id, handle) {
  return {
    id,
    op: 'add-rule',
    family: 'inet',
    table: 'filter',
    chain: 'input',
    newHandle: handle,
    expression: `comment "${id}" accept`,
    action: 'accept',
  };
}

test('failureLocation injects a before-command failure and atomic rollback restores snapshot', () => {
  const report = verifyTransaction({
    snapshot: snapshotWithRules(),
    failureLocation: 2,
    batch: [addRule('first', 100), addRule('second', 101), addRule('third', 102)],
  });

  assert.equal(report.ok, false);
  assert.equal(report.failedCommands[0].commandId, 'second');
  assert.equal(report.failedCommands[0].injected, true);
  assert.equal(report.status, 'rolled-back');
  assert.deepEqual(report.committedRules.map((rule) => rule.handle), [10, 20, 99]);
  assert.equal(report.retry.safeToRetry, true);
});

test('aborted atomic commit is safe to retry and snapshot recovery verifies', () => {
  const input = {
    snapshot: snapshotWithRules(),
    failure: { phase: 'commit', outcome: 'aborted' },
    batch: [addRule('first', 100), addRule('second', 101)],
  };
  const report = verifyTransaction(input);
  assert.equal(report.status, 'rolled-back');
  assert.equal(report.failedCommands[0].phase, 'commit');
  assert.equal(report.retry.safeToRetry, true);
  assert.equal(report.recovery.strategy, 'snapshot-restore');

  const restored = applyRecoveryOrder(report.finalRuleset, report.recoveryOrder, report.snapshot);
  assert.deepEqual(restored.rules.map((rule) => rule.handle), [10, 20, 99]);
});

test('unknown commit outcome is not blindly retryable and exposes both possible states', () => {
  const report = verifyTransaction({
    snapshot: snapshotWithRules(),
    failure: { phase: 'commit', outcome: 'unknown' },
    batch: [addRule('first', 100)],
  });

  assert.equal(report.ok, false);
  assert.equal(report.uncertain, true);
  assert.equal(report.finalRuleset, null);
  assert.equal(report.status, 'commit-outcome-unknown');
  assert.equal(report.retry.safeToRetry, false);
  assert.match(report.retry.strategy, /reconcile/);
  assert.equal(report.recovery.strategy, 'reconcile-first');
  assert.deepEqual(report.possibleRulesets.lastKnownGood.rules.map((rule) => rule.handle), [10, 20, 99]);
  assert.deepEqual(report.possibleRulesets.tentativeCommitted.rules.map((rule) => rule.handle), [10, 20, 99, 100]);
});

test('applied-after-interruption reports committed tentative state and compensating recovery', () => {
  const report = verifyTransaction({
    snapshot: snapshotWithRules(),
    failure: { phase: 'commit', outcome: 'applied' },
    batch: [addRule('first', 100)],
  });

  assert.equal(report.status, 'committed-before-interruption-reported');
  assert.equal(report.committed, true);
  assert.deepEqual(report.committedRules.map((rule) => rule.handle), [10, 20, 99, 100]);
  assert.equal(report.retry.safeToRetry, false);

  const restored = applyRecoveryOrder(report.finalRuleset, report.recoveryOrder, report.snapshot);
  assert.deepEqual(restored.rules.map((rule) => rule.handle), [10, 20, 99]);
});

test('failed subtransaction rolls back only its own unit while prior units remain', () => {
  const report = verifyTransaction({
    snapshot: snapshotWithRules(),
    failure: { phase: 'commit', subtransactionId: 'second', outcome: 'aborted' },
    subtransactions: [
      { id: 'first', commands: [addRule('first-rule', 100)] },
      { id: 'second', commands: [addRule('second-rule', 200)] },
      { id: 'third', commands: [addRule('third-rule', 300)] },
    ],
  });

  assert.equal(report.ok, false);
  assert.equal(report.mode, 'subtransaction');
  assert.equal(report.rollbackScope, 'subtransaction:second');
  assert.equal(report.classification.isolatedSubtransactionFailure, true);
  assert.equal(report.classification.safeRetryableSubtransaction, true);
  assert.deepEqual(report.classification.skippedSubtransactionIds, ['third']);
  assert.deepEqual(report.committedRules.map((rule) => rule.handle), [10, 20, 99, 100]);
  assert.equal(report.retry.subtransactionId, 'second');
  assert.equal(report.retry.commands.length, 1);

  const restored = applyRecoveryOrder(report.finalRuleset, report.recoveryOrder, report.snapshot);
  assert.deepEqual(restored.rules.map((rule) => rule.handle), [10, 20, 99]);
});

test('stale handle in a subtransaction is not retryable as-is but its boundary can be rebuilt and resumed', () => {
  const report = verifyTransaction({
    snapshot: snapshotWithRules(),
    subtransactions: [
      { id: 'first', commands: [addRule('first-rule', 100)] },
      {
        id: 'second',
        commands: [
          { id: 'delete-once', op: 'delete-rule', family: 'inet', table: 'filter', chain: 'input', handle: 99 },
          { id: 'delete-twice', op: 'delete-rule', family: 'inet', table: 'filter', chain: 'input', handle: 99 },
        ],
      },
      { id: 'third', commands: [addRule('third-rule', 300)] },
    ],
  });

  assert.equal(report.failedCommands[0].code, 'STALE_HANDLE');
  assert.equal(report.classification.isolatedSubtransactionFailure, true);
  assert.equal(report.classification.safeRetryableSubtransaction, false);
  assert.equal(report.classification.safeRetryableSubtransactionAfterRefresh, true);
  assert.equal(report.retry.safeAtomicBoundary, true);
  assert.deepEqual(report.committedRules.map((rule) => rule.handle), [10, 20, 99, 100]);

  const rebuilt = verifyTransaction({
    snapshot: report.finalRuleset,
    mode: 'subtransaction',
    subtransactions: [
      {
        id: 'second-rebuilt',
        commands: [
          { id: 'delete-once-only', op: 'delete-rule', family: 'inet', table: 'filter', chain: 'input', handle: 99 },
        ],
      },
    ],
  });
  assert.equal(rebuilt.ok, true);
  assert.deepEqual(rebuilt.committedRules.map((rule) => rule.handle), [10, 20, 100]);
});

test('checkpoint snapshot lets a resumed run skip committed subtransactions', () => {
  const first = verifyTransaction({
    snapshot: snapshotWithRules(),
    failure: { phase: 'commit', subtransactionId: 'second', outcome: 'aborted' },
    subtransactions: [
      { id: 'first', commands: [addRule('first-rule', 100)] },
      { id: 'second', commands: [addRule('second-rule', 200)] },
      { id: 'third', commands: [addRule('third-rule', 300)] },
    ],
  });

  const resumed = verifyTransaction({
    snapshot: first.finalRuleset,
    completedSubtransactions: ['first'],
    subtransactions: [
      { id: 'first', commands: [addRule('first-rule', 100)] },
      { id: 'second', commands: [addRule('second-rule', 200)] },
      { id: 'third', commands: [addRule('third-rule', 300)] },
    ],
  });

  assert.equal(resumed.ok, true);
  assert.deepEqual(resumed.subtransactions[0].status, 'skipped-checkpoint-committed');
  assert.deepEqual(resumed.committedRules.map((rule) => rule.handle), [10, 20, 99, 100, 200, 300]);
});

test('unknown subtransaction commit requires reconciliation rather than blind retry', () => {
  const report = verifyTransaction({
    snapshot: snapshotWithRules(),
    failure: { phase: 'commit', subtransactionId: 'second', outcome: 'unknown' },
    subtransactions: [
      { id: 'first', commands: [addRule('first-rule', 100)] },
      { id: 'second', commands: [addRule('second-rule', 200)] },
    ],
  });

  assert.equal(report.uncertain, true);
  assert.equal(report.finalRuleset, null);
  assert.equal(report.retry.safeToRetry, false);
  assert.equal(report.recovery.strategy, 'reconcile-first');
});
