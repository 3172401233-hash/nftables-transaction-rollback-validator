import { applyCommand, createCommandContext, normalizeCommand } from './commands.js';
import { CommitInterruptedError, TransactionValidationError } from './errors.js';
import { splitScriptCommands } from './parser.js';
import { cloneState, normalizeRuleset, summarizeRules } from './normalize.js';
import { applyRecoveryOrder, buildInverseOrder, withVerification } from './recovery.js';

const DETERMINISTIC_FAILURE_CODES = new Set([
  'STALE_HANDLE',
  'RULE_HANDLE_NOT_FOUND',
  'HANDLE_REQUIRED',
  'HANDLE_EXISTS',
  'HANDLE_REUSED',
  'INVALID_RULE_POSITION',
  'CHAIN_NOT_FOUND',
  'CHAIN_EXISTS',
  'CHAIN_REFERENCED',
  'TABLE_NOT_FOUND',
  'TABLE_EXISTS',
  'SET_NOT_FOUND',
  'SET_EXISTS',
  'SET_REFERENCED',
  'ELEMENT_CONFLICT',
  'ELEMENT_NOT_FOUND',
  'SET_TYPE_CONFLICT',
  'INVALID_SNAPSHOT',
  'UNPARSED_COMMAND',
  'UNSUPPORTED_COMMAND',
]);

export function buildDefaults(input = {}) {
  return {
    family: input.family ?? input.defaults?.family,
    table: input.table ?? input.defaults?.table,
    chain: input.chain ?? input.chainName ?? input.defaults?.chain,
    priority: input.priority ?? input.defaults?.priority,
    handle: input.ruleHandle ?? input.handle ?? input.defaults?.handle,
    set: input.setName ?? input.set ?? input.defaults?.set,
    elements: input.elements ?? input.setElements ?? input.defaults?.elements,
  };
}

function rawCommandList(batch) {
  let raw = batch ?? [];
  if (raw && !Array.isArray(raw) && typeof raw === 'object') raw = raw.commands ?? raw.batch ?? [];
  if (typeof raw === 'string') return splitScriptCommands(raw);
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => (typeof item === 'string' ? splitScriptCommands(item) : [item]));
}

export function buildCommands(input, defaults = buildDefaults(input)) {
  return rawCommandList(input.batch ?? input.commands).map((command, index) => normalizeCommand(command, index, defaults));
}

function normalizeMode(input, hasSubtransactions) {
  const mode = input.commitStrategy ?? input.transactionMode ?? input.mode ?? (hasSubtransactions ? 'subtransaction' : 'atomic');
  const aliases = {
    batch: 'atomic',
    'all-or-nothing': 'atomic',
    nft: 'atomic',
    sequential: 'per-command',
    'per-command': 'per-command',
    command: 'per-command',
    groups: 'subtransaction',
    subtransactions: 'subtransaction',
  };
  return aliases[mode] ?? mode;
}

export function normalizeFailure(input = {}) {
  const source = input.failure && typeof input.failure === 'object' ? input.failure : {};
  const active = input.failure !== undefined
    || input.failureLocation !== undefined
    || input.failureAt !== undefined
    || source.active === true;

  let index = source.index ?? input.failureIndex;
  let position = source.position ?? input.failurePosition;
  let id = source.id ?? source.commandId ?? input.failureCommandId;
  const at = source.at ?? input.failureAt;
  const location = source.location ?? input.failureLocation;

  if (index === undefined && typeof at === 'number') index = at;
  if (id === undefined && typeof at === 'string' && at !== 'commit') id = at;
  if (index === undefined && typeof location === 'number') index = location - 1;
  if (id === undefined && typeof location === 'string' && location !== 'commit') {
    if (/^-?\d+$/.test(location)) index = Number(location) - 1;
    else id = location;
  }

  const phase = source.phase
    ?? input.failurePhase
    ?? (at === 'commit' || location === 'commit' || source.commit === true ? 'commit' : source.phase ?? 'before');

  return {
    active,
    index,
    position,
    id,
    phase,
    type: source.type ?? input.failureType ?? source.code ?? input.failureCode ?? 'SIMULATED_FAILURE',
    outcome: source.outcome ?? input.commitOutcome ?? 'aborted',
    message: source.message ?? input.failureMessage,
    retryable: source.retryable ?? input.failureRetryable,
    subtransactionId: source.subtransactionId ?? input.failureSubtransactionId,
    subtransactionIndex: source.subtransactionIndex ?? input.failureSubtransactionIndex,
  };
}

function failureScopeMatches(failure, scope = {}) {
  if (failure.subtransactionId !== undefined && String(failure.subtransactionId) !== String(scope.unitId)) return false;
  if (failure.subtransactionIndex !== undefined && failure.subtransactionIndex !== scope.unitIndex) return false;
  return true;
}

function failureMatchesCommand(failure, command, index, scope) {
  if (!failure.active || failure.phase === 'commit' || !failureScopeMatches(failure, scope)) return false;
  if (failure.id !== undefined) return String(command.id) === String(failure.id);
  if (failure.index !== undefined) return failure.index === index;
  if (failure.position !== undefined) return failure.position === index + 1;
  return false;
}

function injectedError(failure, scope = {}) {
  const details = {
    injected: true,
    outcome: failure.outcome,
    phase: failure.phase,
    ...scope,
  };
  if (failure.phase === 'commit') {
    return new CommitInterruptedError(
      failure.message ?? `Simulated commit interruption (outcome: ${failure.outcome}).`,
      { ...details, retryable: failure.retryable ?? failure.outcome === 'aborted' },
    );
  }
  const retryable = failure.retryable ?? (failure.type === 'TRANSIENT_FAILURE' && failure.outcome !== 'unknown');
  return new TransactionValidationError(
    failure.type,
    failure.message ?? `Simulated failure ${failure.type} at command ${scope.commandIndex + 1}.`,
    { ...details, retryable },
  );
}

function sanitizeCommand(command) {
  if (!command) return null;
  const clean = cloneState(command);
  delete clean.__context;
  return clean;
}

function enrichError(error, command, index) {
  if (!(error instanceof TransactionValidationError)) {
    const wrapped = new TransactionValidationError('INTERNAL_SIMULATOR_ERROR', error.message, { cause: String(error) });
    wrapped.command = sanitizeCommand(command);
    wrapped.commandIndex = index;
    return wrapped;
  }
  error.command = sanitizeCommand(command);
  error.commandIndex = index;
  if (error.details && typeof error.details === 'object') {
    error.details.commandIndex ??= index;
    error.details.commandId ??= command?.id;
  }
  return error;
}

function dryValidate(state, command, context) {
  const dryState = cloneState(state);
  const dryContext = createCommandContext(dryState, {
    ...context,
    deletedHandles: new Map(context.deletedHandles),
  });
  applyCommand(dryState, command, dryContext);
}

function summarizeCommandResult(command, index, result) {
  return {
    commandIndex: index,
    id: command.id,
    op: command.op,
    status: result.status,
    duplicateFlush: result.duplicate ?? false,
    handle: result.handle ?? result.effects?.handle ?? null,
    effects: result.effects ?? {},
  };
}

function executeUnit(baseState, commands, options = {}) {
  const state = cloneState(baseState);
  const context = createCommandContext(state, { elementConflict: options.elementConflict });
  const commandResults = [];
  const journal = [];
  const failure = options.failure;
  const scope = { unitId: options.unitId, unitIndex: options.unitIndex };

  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    command.index = index;
    try {
      if (failureMatchesCommand(failure, command, index, scope) && failure.phase === 'before') {
        dryValidate(state, command, context);
        throw injectedError(failure, { commandIndex: index, commandId: command.id, ...scope });
      }

      const result = applyCommand(state, command, context);
      commandResults.push(summarizeCommandResult(command, index, result));
      journal.push({
        commandIndex: index,
        commandId: command.id,
        op: command.op,
        status: result.status,
        handle: result.handle ?? null,
        undo: result.undo ?? [],
        subtransactionId: options.unitId,
      });

      if (failureMatchesCommand(failure, command, index, scope) && failure.phase === 'after') {
        throw injectedError(failure, { commandIndex: index, commandId: command.id, ...scope });
      }
    } catch (error) {
      const enriched = enrichError(error, command, index);
      return { ok: false, error: enriched, state, commandResults, journal, commands };
    }
  }

  if (failure?.active && failure.phase === 'commit' && failureScopeMatches(failure, scope)) {
    const error = injectedError(failure, { commandIndex: commands.length ? commands.length - 1 : 0, ...scope });
    return { ok: false, error, state, commandResults, journal, commands };
  }

  return { ok: true, state, commandResults, journal, commands };
}

function formatFailedCommands(unit, mode) {
  if (!unit?.error) return [];
  const error = unit.error;
  const index = error.commandIndex ?? error.details?.commandIndex;
  const command = index !== undefined ? sanitizeCommand(unit.commands[index]) : error.command ?? null;
  return [{
    mode,
    phase: error.code === 'COMMIT_INTERRUPTED' ? 'commit' : 'command',
    commandIndex: index ?? null,
    position: typeof index === 'number' ? index + 1 : null,
    commandId: error.commandId ?? error.details?.commandId ?? command?.id ?? null,
    code: error.code,
    message: error.message,
    retryable: error.retryable ?? false,
    injected: error.details?.injected ?? false,
    stale: error.details?.stale ?? error.code === 'STALE_HANDLE',
    outcome: error.details?.outcome ?? null,
    command,
    details: error.details ?? {},
  }];
}

function classifyRetry({ mode, error, outcome, unitId }) {
  const boundary = mode === 'atomic' ? 'whole-batch' : mode === 'subtransaction' ? 'subtransaction' : 'command';
  if (!error) {
    return { boundary, scope: boundary, safeToRetry: false, needed: false };
  }
  const code = error.code;
  const deterministic = DETERMINISTIC_FAILURE_CODES.has(code) && !error.details?.injected;
  let strategy = 'idempotent-retry';
  let safeToRetry = true;

  if (outcome === 'unknown') {
    strategy = 'reconcile-live-ruleset-before-retry';
    safeToRetry = false;
  } else if (outcome === 'applied') {
    strategy = 'use-checkpoint-or-compensate-before-retry';
    safeToRetry = false;
  } else if (deterministic) {
    safeToRetry = false;
    if (code === 'STALE_HANDLE' || code === 'RULE_HANDLE_NOT_FOUND' || code === 'HANDLE_REUSED' || code === 'INVALID_RULE_POSITION') {
      strategy = 'refresh-snapshot-rebuild-handles-then-retry-subtransaction';
    } else if (code === 'ELEMENT_CONFLICT' || code === 'SET_TYPE_CONFLICT') {
      strategy = 'resolve-set-conflict-then-retry-subtransaction';
    } else if (code === 'CHAIN_REFERENCED') {
      strategy = 'delete-or-move-referencing-rules-then-retry-subtransaction';
    } else {
      strategy = 'fix-batch-input-then-retry';
    }
  }

  return {
    boundary,
    scope: unitId ? `subtransaction:${unitId}` : boundary,
    subtransactionId: unitId ?? null,
    safeToRetry,
    safeAtomicBoundary: outcome === 'aborted',
    safeToRetryAfterRefresh: outcome === 'aborted',
    strategy,
    deterministic,
  };
}

function makeRecovery({ strategy, scope, journal = [], snapshot, outcome, unitId }) {
  if (strategy === 'none') {
    return {
      scope: 'none',
      strategy: 'none',
      inverseCommands: [],
      order: [{ order: 1, op: 'verify-ruleset', expected: 'input.snapshot-or-intended-state' }],
    };
  }

  if (strategy === 'reconcile-first') {
    return {
      scope,
      strategy,
      outcome,
      subtransactionId: unitId ?? null,
      inverseCommands: [],
      order: [
        { order: 1, op: 'reconcile-ruleset', source: 'nft-list-ruleset-or-supplied-observedSnapshot' },
        { order: 2, op: 'resolve-commit-outcome', possibleOutcomes: ['aborted', 'applied'] },
        { order: 3, op: 'restore-snapshot-if-full-rollback-is-required' },
        { order: 4, op: 'verify-ruleset', expected: 'desired-state' },
      ],
    };
  }

  if (strategy === 'snapshot-restore') {
    const inverseCommands = [{ op: 'restore-snapshot', source: 'input.snapshot' }];
    return {
      scope,
      strategy,
      subtransactionId: unitId ?? null,
      inverseCommands,
      order: withVerification(inverseCommands),
      stagedInverseOrder: buildInverseOrder(journal),
    };
  }

  const inverseCommands = buildInverseOrder(journal);
  return {
    scope,
    strategy: 'compensating-commands',
    subtransactionId: unitId ?? null,
    inverseCommands,
    order: withVerification(inverseCommands),
  };
}

function publicRuleset(state) {
  if (!state) return null;
  return {
    tables: state.tables,
    chains: state.chains,
    sets: state.sets,
    rules: state.rules,
    nextHandle: state.nextHandle,
  };
}

function finalizeReport(base) {
  const finalRuleset = publicRuleset(base.finalState);
  const committedRules = base.finalState ? summarizeRules(base.finalState) : null;
  const recoveryOrder = base.recovery?.order ?? [];
  return {
    ok: base.ok,
    simulator: 'nftables-transaction-validator',
    executesRealNft: false,
    mode: base.mode,
    status: base.status,
    snapshot: publicRuleset(base.snapshot),
    defaults: base.defaults,
    commandCount: base.commands.length,
    commands: base.commands.map(sanitizeCommand),
    subtransactions: base.subtransactions ?? undefined,
    committed: base.committed,
    uncertain: base.uncertain ?? false,
    rollbackScope: base.rollbackScope,
    classification: base.classification,
    commandResults: base.commandResults ?? [],
    failedCommands: base.failedCommands ?? [],
    failure: base.failureSummary ?? null,
    finalRuleset,
    committedRules,
    rules: committedRules,
    finalRules: committedRules,
    possibleRulesets: base.possibleRulesets,
    recovery: base.recovery,
    recoveryOrder,
    rollbackOrder: recoveryOrder,
    retry: base.retry,
    mixedState: base.mixedState ?? undefined,
  };
}

function runAtomic(input, defaults, snapshot, commands, failure) {
  const unit = executeUnit(snapshot, commands, { failure, unitId: 'atomic-batch' });
  const failedCommands = formatFailedCommands(unit, 'atomic');
  const outcome = unit.error?.details?.outcome ?? 'aborted';
  let finalState = snapshot;
  let status = 'rolled-back';
  let committed = false;
  let uncertain = false;
  let possibleRulesets;
  let recovery;

  if (unit.ok) {
    finalState = unit.state;
    status = 'committed';
    committed = true;
    recovery = makeRecovery({ strategy: 'none', scope: 'none' });
  } else if (unit.error.code === 'COMMIT_INTERRUPTED' && outcome === 'unknown') {
    finalState = null;
    uncertain = true;
    status = 'commit-outcome-unknown';
    possibleRulesets = { lastKnownGood: publicRuleset(snapshot), tentativeCommitted: publicRuleset(unit.state) };
    recovery = makeRecovery({ strategy: 'reconcile-first', scope: 'whole-batch', outcome });
  } else if (unit.error.code === 'COMMIT_INTERRUPTED' && outcome === 'applied') {
    finalState = unit.state;
    status = 'committed-before-interruption-reported';
    committed = true;
    recovery = makeRecovery({ strategy: 'compensating', scope: 'whole-batch', journal: unit.journal, outcome });
  } else {
    finalState = snapshot;
    status = 'rolled-back';
    recovery = makeRecovery({ strategy: 'snapshot-restore', scope: 'whole-batch', journal: unit.journal, outcome });
  }

  const retry = classifyRetry({ mode: 'atomic', error: unit.error, outcome });
  const failureSummary = unit.error ? failedCommands[0] : null;
  return finalizeReport({
    ok: unit.ok,
    mode: 'atomic',
    status,
    defaults,
    snapshot,
    commands,
    finalState,
    committed,
    uncertain,
    possibleRulesets,
    rollbackScope: unit.ok ? 'none' : 'whole-batch',
    classification: {
      wholeBatchFailure: !unit.ok && outcome === 'aborted',
      atomicAbort: !unit.ok && outcome === 'aborted',
      isolatedSubtransactionFailure: false,
      safeRetryableSubtransaction: false,
    },
    commandResults: unit.commandResults,
    failedCommands,
    failureSummary,
    recovery,
    retry,
  });
}

function detectMixedState(state) {
  const rules = summarizeRules(state);
  const byPort = new Map();
  for (const rule of rules) {
    const port = rule.expression.match(/dport\s+(\d+)/)?.[1];
    if (!port) continue;
    const verdict = rule.action ?? rule.expression.match(/\b(accept|drop|reject)\b/)?.[1];
    if (!verdict || !['accept', 'drop', 'reject'].includes(verdict)) continue;
    const key = `${rule.family}/${rule.table}/${rule.chain}/${rule.protocol ?? 'tcp'}/${port}`;
    const group = byPort.get(key) ?? { key, accept: [], deny: [] };
    if (verdict === 'accept') group.accept.push(rule.handle);
    else group.deny.push(rule.handle);
    byPort.set(key, group);
  }
  const simultaneous = [...byPort.values()].filter((group) => group.accept.length && group.deny.length);
  return {
    simultaneousAllowAndDeny: simultaneous.length > 0,
    groups: simultaneous,
    note: 'Order still matters in nftables; this only proves contradictory verdict rules coexist in a non-atomic prefix.',
  };
}

function runPerCommand(input, defaults, snapshot, commands, failure) {
  const state = cloneState(snapshot);
  const context = createCommandContext(state, { elementConflict: input.setConflict ?? 'ignore' });
  const commandResults = [];
  const journal = [];
  let error = null;
  let failedCommands = [];

  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    command.index = index;
    try {
      if (failureMatchesCommand(failure, command, index, { unitId: 'per-command' }) && failure.phase === 'before') {
        dryValidate(state, command, context);
        throw injectedError(failure, { commandIndex: index, commandId: command.id });
      }
      const result = applyCommand(state, command, context);
      commandResults.push(summarizeCommandResult(command, index, result));
      journal.push({ commandIndex: index, commandId: command.id, op: command.op, undo: result.undo ?? [] });
      if (failureMatchesCommand(failure, command, index, { unitId: 'per-command' }) && failure.phase === 'after') {
        throw injectedError(failure, { commandIndex: index, commandId: command.id });
      }
    } catch (caught) {
      error = enrichError(caught, command, index);
      failedCommands = formatFailedCommands({ error, commands }, 'per-command');
      break;
    }
  }

  const ok = !error;
  const recovery = ok
    ? makeRecovery({ strategy: 'none' })
    : makeRecovery({ strategy: 'compensating', scope: 'applied-commands', journal });
  const retry = classifyRetry({ mode: 'per-command', error, outcome: 'aborted' });
  return finalizeReport({
    ok,
    mode: 'per-command',
    status: ok ? 'committed-command-by-command' : 'partially-committed',
    defaults,
    snapshot,
    commands,
    finalState: state,
    committed: ok,
    rollbackScope: ok ? 'none' : 'applied-commands',
    classification: {
      wholeBatchFailure: false,
      atomicAbort: false,
      isolatedSubtransactionFailure: true,
      safeRetryableSubtransaction: retry.safeToRetry,
      warning: 'Per-command commits are not nftables batch atomicity and can expose mixed allow/deny state.',
    },
    commandResults,
    failedCommands,
    failureSummary: failedCommands[0] ?? null,
    recovery,
    retry,
    mixedState: detectMixedState(state),
  });
}

function buildSubtransactions(input, defaults, commands) {
  if (Array.isArray(input.subtransactions)) {
    return input.subtransactions.map((unit, unitIndex) => {
      const raw = rawCommandList(unit.commands ?? unit.batch ?? []);
      const unitDefaults = { ...defaults, ...(unit.defaults ?? {}) };
      const unitCommands = raw.map((command, index) => normalizeCommand(command, index, unitDefaults));
      return { id: unit.id ?? unit.name ?? `subtransaction-${unitIndex + 1}`, name: unit.name ?? null, commands: unitCommands };
    });
  }
  if (normalizeMode(input, false) === 'subtransaction') {
    const groups = new Map();
    for (const command of commands) {
      const id = command.subtransaction ?? command.group ?? command.tx ?? 'default';
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(command);
    }
    return [...groups.entries()].map(([id, groupedCommands], unitIndex) => ({
      id,
      commands: groupedCommands.map((command, index) => ({ ...command, index })),
    }));
  }
  return null;
}

function isCheckpointed(input, unit) {
  const completed = input.completedSubtransactions
    ?? input.checkpoint?.completedSubtransactions
    ?? input.checkpoint?.committed
    ?? [];
  return completed.some((id) => String(id) === String(unit.id));
}

function runSubtransactions(input, defaults, snapshot, allCommands, failure) {
  const units = buildSubtransactions(input, defaults, allCommands) ?? [];
  let state = cloneState(snapshot);
  const unitReports = [];
  const committedJournal = [];
  let failed = null;
  let finalState = state;
  let uncertain = false;
  let possibleRulesets;

  for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
    const unit = units[unitIndex];
    if (isCheckpointed(input, unit)) {
      unitReports.push({ id: unit.id, status: 'skipped-checkpoint-committed', commandResults: [] });
      continue;
    }

    const result = executeUnit(state, unit.commands, { failure, unitId: unit.id, unitIndex, elementConflict: input.setConflict ?? 'ignore' });
    if (result.ok) {
      state = result.state;
      finalState = state;
      committedJournal.push(...result.journal.map((entry) => ({ ...entry, subtransactionId: unit.id })));
      unitReports.push({ id: unit.id, status: 'committed', commandResults: result.commandResults });
      continue;
    }

    const outcome = result.error.details?.outcome ?? 'aborted';
    const failedCommands = formatFailedCommands(result, 'subtransaction');
    failed = { unit, result, failedCommands, outcome };
    unitReports.push({ id: unit.id, status: `failed-${outcome}`, commandResults: result.commandResults, failedCommands });

    if (result.error.code === 'COMMIT_INTERRUPTED' && outcome === 'unknown') {
      finalState = null;
      uncertain = true;
      possibleRulesets = { lastKnownGood: publicRuleset(state), tentativeCommitted: publicRuleset(result.state) };
    } else if (outcome === 'applied') {
      state = result.state;
      finalState = state;
      committedJournal.push(...result.journal.map((entry) => ({ ...entry, subtransactionId: unit.id })));
    } else {
      finalState = state;
    }
    break;
  }

  const ok = !failed;
  let recovery;
  let retry;
  let rollbackScope = 'none';

  if (failed) {
    const { unit, outcome, result, failedCommands } = failed;
    rollbackScope = outcome === 'aborted' ? `subtransaction:${unit.id}` : `committed-subtransactions:${unit.id}`;
    if (outcome === 'unknown') {
      recovery = makeRecovery({ strategy: 'reconcile-first', scope: 'committed-subtransactions', outcome, unitId: unit.id });
    } else {
      recovery = makeRecovery({ strategy: 'compensating', scope: 'committed-subtransactions', journal: committedJournal, outcome });
      recovery.failedSubtransactionRollback = {
        scope: `subtransaction:${unit.id}`,
        guaranteed: outcome === 'aborted',
        order: makeRecovery({ strategy: 'snapshot-restore', scope: `subtransaction:${unit.id}`, journal: result.journal, unitId: unit.id }).order,
      };
    }
    retry = classifyRetry({ mode: 'subtransaction', error: result.error, outcome, unitId: unit.id });
    retry.commands = unit.commands.map(sanitizeCommand);
    retry.failedCommands = failedCommands;
  } else {
    recovery = makeRecovery({ strategy: 'none' });
    retry = classifyRetry({ mode: 'subtransaction', error: null });
  }

  const failedCommands = failed?.failedCommands ?? [];
  return finalizeReport({
    ok,
    mode: 'subtransaction',
    status: ok ? 'all-subtransactions-committed' : uncertain ? 'commit-outcome-unknown' : 'partially-committed',
    defaults,
    snapshot,
    commands: allCommands,
    subtransactions: unitReports,
    finalState,
    committed: ok,
    uncertain,
    possibleRulesets,
    rollbackScope,
    classification: {
      wholeBatchFailure: false,
      atomicAbort: false,
      isolatedSubtransactionFailure: Boolean(failed && failed.outcome === 'aborted'),
      safeRetryableSubtransaction: retry?.safeToRetry ?? false,
      safeRetryableSubtransactionAfterRefresh: Boolean(failed && failed.outcome === 'aborted'),
      atomicBoundary: Boolean(failed && failed.outcome === 'aborted'),
      failedSubtransactionId: failed?.unit.id ?? null,
      skippedSubtransactionIds: failed ? units.slice(units.indexOf(failed.unit) + 1).map((unit) => unit.id) : [],
    },
    commandResults: unitReports.flatMap((unit) => unit.commandResults.map((result) => ({ ...result, subtransaction: unit.id }))),
    failedCommands,
    failureSummary: failedCommands[0] ?? null,
    recovery,
    retry,
  });
}

export function verifyTransaction(input = {}) {
  const defaults = buildDefaults(input);
  const snapshotInput = input.snapshot
    ?? input.initialState
    ?? input.initialRuleset
    ?? input.ruleset
    ?? {};
  const snapshot = normalizeRuleset(snapshotInput, defaults);
  const commands = buildCommands(input, defaults);
  const hasUnits = Array.isArray(input.subtransactions);
  const mode = normalizeMode(input, hasUnits);
  const failure = normalizeFailure(input);

  if (mode === 'per-command') return runPerCommand(input, defaults, snapshot, commands, failure);
  if (mode === 'subtransaction' || hasUnits) return runSubtransactions(input, defaults, snapshot, commands, failure);
  return runAtomic(input, defaults, snapshot, commands, failure);
}

export function compareStrategies(input = {}) {
  return {
    atomic: verifyTransaction({ ...input, mode: 'atomic' }),
    perCommand: verifyTransaction({ ...input, mode: 'per-command' }),
    subtransaction: Array.isArray(input.subtransactions)
      ? verifyTransaction({ ...input, mode: 'subtransaction' })
      : undefined,
  };
}

export { applyRecoveryOrder };
export * from './parser.js';
