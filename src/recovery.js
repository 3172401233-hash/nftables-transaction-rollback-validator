import { applyInverseStep } from './commands.js';
import { cloneState, normalizeRuleset } from './normalize.js';

export function buildInverseOrder(journal) {
  const steps = [];
  for (const entry of [...journal].reverse()) {
    for (const undo of entry.undo ?? []) {
      steps.push({
        ...cloneState(undo),
        inverseOfCommandIndex: entry.commandIndex,
        inverseOfCommandId: entry.commandId,
        inverseOfSubtransactionId: entry.subtransactionId,
      });
    }
  }
  return steps.map((step, index) => ({ order: index + 1, ...step }));
}

export function withVerification(steps) {
  const numbered = steps.map((step, index) => ({ ...step, order: index + 1 }));
  return [
    ...numbered,
    { order: numbered.length + 1, op: 'verify-ruleset', expected: 'input.snapshot' },
  ];
}

export function applyRecoveryOrder(currentState, order, snapshot) {
  let state = cloneState(currentState);
  const normalizedSnapshot = normalizeRuleset(snapshot);
  for (const step of order ?? []) {
    if (step.op === 'verify-ruleset') {
      const current = JSON.stringify(serializeForCompare(state));
      const expected = JSON.stringify(serializeForCompare(normalizedSnapshot));
      if (current !== expected) {
        throw new Error(`Recovery verification failed at step ${step.order}`);
      }
      continue;
    }
    if (step.op === 'restore-snapshot') {
      state = cloneState(normalizedSnapshot);
      continue;
    }
    applyInverseStep(state, step);
  }
  return state;
}

export function serializeForCompare(state) {
  return {
    tables: state.tables,
    chains: state.chains,
    rules: state.rules,
    sets: state.sets,
  };
}
