import { TransactionValidationError } from './errors.js';
import { normalizeOp, parseNftCommand } from './parser.js';
import {
  chainKey,
  chainRules,
  cloneState,
  findRuleByHandle,
  getChain,
  getSet,
  getTable,
  handleKey,
  normalizeElement,
  normalizeHandle,
  reindexChain,
  requireChain,
  requireSet,
  requireTable,
  ruleReferencesChain,
  ruleReferencesSet,
  setKey,
  tableKey,
} from './normalize.js';

export function normalizeCommand(raw, index, defaults = {}) {
  const parsed = typeof raw === 'string' ? parseNftCommand(raw, defaults) : cloneState(raw ?? {});
  const command = typeof raw === 'string' ? parsed : { ...parsed };
  command.op = normalizeOp(command.op);
  command.id = command.id ?? command.commandId ?? `cmd-${index + 1}`;
  command.index = index;
  command.family = command.family ?? defaults.family ?? 'inet';

  if (command.op?.endsWith('-table') && !command.table) command.table = defaults.table;
  if (command.op?.endsWith('-chain') || command.op === 'set-chain-priority' || command.op === 'update-chain') {
    command.table = command.table ?? defaults.table;
    command.chain = command.chain ?? command.name ?? defaults.chain;
    if (command.priority === undefined && defaults.priority !== undefined && (command.op === 'add-chain' || command.op === 'create-chain')) {
      command.priority = defaults.priority;
    }
  }
  if (command.op?.endsWith('-rule')) {
    command.table = command.table ?? defaults.table;
    command.chain = command.chain ?? command.name ?? defaults.chain;
    if ((command.op === 'delete-rule' || command.op === 'replace-rule') && command.handle === undefined) {
      command.handle = defaults.handle;
    }
  }
  if (command.op?.endsWith('-set') || command.op?.endsWith('-element')) {
    command.table = command.table ?? defaults.table;
    command.set = command.set ?? command.name ?? defaults.set;
    command.name = command.set;
  }
  if (command.op === 'add-element' || command.op === 'delete-element') {
    if ((!command.elements || command.elements.length === 0) && defaults.elements) {
      command.elements = defaults.elements;
    }
  }
  return command;
}

export function createCommandContext(state, options = {}) {
  const maxHandle = state.rules.reduce((max, rule) => (typeof rule.handle === 'number' ? Math.max(max, rule.handle) : max), 0);
  return {
    commandIndex: -1,
    commandId: null,
    nextHandle: Math.max(state.nextHandle ?? 1, maxHandle + 1),
    deletedHandles: new Map(),
    elementConflict: options.elementConflict ?? 'ignore',
    ...options,
  };
}

function commandError(code, message, command, details = {}) {
  return new TransactionValidationError(code, message, {
    commandIndex: command.index,
    commandId: command.id,
    ...details,
  });
}

function allocateHandle(state, command, context, requested = null) {
  const handle = normalizeHandle(requested);
  if (handle !== null) {
    const existing = findRuleByHandle(state, handle);
    if (existing) {
      throw commandError('HANDLE_EXISTS', `Rule handle ${handle} already exists.`, command, { handle });
    }
    if (!context.allowHandleReuse && context.deletedHandles.has(handleKey(handle))) {
      throw commandError('HANDLE_REUSED', `Rule handle ${handle} was deleted earlier in this batch and cannot be reused.`, command, {
        handle,
        deletedAt: context.deletedHandles.get(handleKey(handle)),
      });
    }
    return handle;
  }

  let next = context.nextHandle;
  while (findRuleByHandle(state, next) || context.deletedHandles.has(handleKey(next))) next += 1;
  context.nextHandle = next + 1;
  state.nextHandle = context.nextHandle;
  return next;
}

function missingHandleError(state, command, handle) {
  const deleted = command.__context?.deletedHandles?.get(handleKey(handle));
  if (deleted) {
    return commandError('STALE_HANDLE', `Rule handle ${handle} was deleted at command ${deleted.commandIndex + 1} and is no longer valid.`, command, {
      handle,
      stale: true,
      deletedAt: deleted.commandIndex,
      deletedCommandId: deleted.commandId,
    });
  }
  return commandError('RULE_HANDLE_NOT_FOUND', `Rule handle ${handle} does not exist in the current transaction state.`, command, {
    handle,
    stale: false,
  });
}

function findHandleOrThrow(state, command, handle, scope) {
  const normalized = normalizeHandle(handle ?? command.handle);
  if (normalized === null) {
    throw commandError('HANDLE_REQUIRED', `${command.op} requires a numeric rule handle.`, command);
  }
  const rule = findRuleByHandle(state, normalized, scope);
  if (!rule) throw missingHandleError(state, command, normalized);
  return rule;
}

function buildRule(command, handle) {
  const source = command.rule ?? {};
  const rule = { ...source };
  const fields = [
    'expression', 'expr', 'exprText', 'action', 'protocol', 'family', 'dport', 'sport',
    'source', 'destination', 'saddr', 'daddr', 'setName', 'verdict', 'jump', 'goto',
    'comment', 'counter', 'bytes', 'packets',
  ];
  for (const field of fields) {
    if (command[field] !== undefined) rule[field] = command[field];
  }
  rule.handle = handle;
  rule.expression = rule.expression ?? rule.exprText ?? source.expression ?? '';
  if (!rule.expression && (rule.protocol || rule.dport !== undefined)) {
    rule.expression = [rule.protocol, rule.dport !== undefined ? `dport ${rule.dport}` : null, rule.action].filter(Boolean).join(' ');
  }
  if (!rule.action && rule.expression) {
    rule.action = rule.expression.match(/\b(accept|drop|reject|return|continue|queue)\b\s*$/)?.[1] ?? null;
  }
  return rule;
}

function placementOrder(state, command) {
  const rules = chainRules(state, command.family, command.table, command.chain);
  const refHandle = command.beforeHandle ?? command.afterHandle ?? command.positionHandle;
  if (refHandle !== undefined) {
    const normalized = normalizeHandle(refHandle);
    const reference = rules.find((rule) => handleKey(rule.handle) === handleKey(normalized));
    if (!reference) {
      const deleted = command.__context?.deletedHandles?.get(handleKey(normalized));
      if (deleted) {
        throw commandError('STALE_HANDLE', `Position handle ${normalized} was deleted earlier in this batch.`, command, {
          handle: normalized,
          stale: true,
          deletedAt: deleted.commandIndex,
          deletedCommandId: deleted.commandId,
        });
      }
      throw commandError('INVALID_RULE_POSITION', `Position handle ${normalized} does not exist.`, command, { handle: normalized });
    }
    if (command.beforeHandle !== undefined) return reference.order - 0.5;
    return reference.order + 0.5;
  }
  if (command.op === 'insert-rule') return rules.length ? Math.min(...rules.map((rule) => rule.order)) - 1 : 0;
  return rules.length ? Math.max(...rules.map((rule) => rule.order)) + 1 : 0;
}

function findChainReferences(state, command) {
  return state.rules
    .filter((rule) => rule.family === command.family && rule.table === command.table)
    .filter((rule) => ruleReferencesChain(rule, command.chain))
    .map((rule) => ({ handle: rule.handle, chain: rule.chain, expression: rule.expression }));
}

function findSetReferences(state, command) {
  return state.rules
    .filter((rule) => rule.family === command.family && rule.table === command.table)
    .filter((rule) => ruleReferencesSet(rule, command.set))
    .map((rule) => ({ handle: rule.handle, chain: rule.chain }));
}

function validateElement(set, candidate, command) {
  const type = set.type ?? candidate.type;
  const value = String(candidate.value);
  if (!type) return;
  if (type === 'ipv4_addr') {
    const parts = value.split('/')[0].split('.');
    const valid = parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
    if (!valid) throw commandError('SET_TYPE_CONFLICT', `Element ${value} is not a valid ipv4_addr.`, command, { set: set.name, type, value });
  } else if (type === 'inet_service') {
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
      throw commandError('SET_TYPE_CONFLICT', `Element ${value} is not a valid inet_service.`, command, { set: set.name, type, value });
    }
  } else if (type === 'ether_addr') {
    if (!/^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(value)) {
      throw commandError('SET_TYPE_CONFLICT', `Element ${value} is not a valid ether_addr.`, command, { set: set.name, type, value });
    }
  } else if (type === 'ipv6_addr' && !value.includes(':')) {
    throw commandError('SET_TYPE_CONFLICT', `Element ${value} is not a valid ipv6_addr.`, command, { set: set.name, type, value });
  }
}

function restoreRule(state, rule) {
  if (!getChain(state, rule.family, rule.table, rule.chain)) {
    state.chains.push({
      family: rule.family,
      table: rule.table,
      name: rule.chain,
      priority: 0,
      type: null,
      hook: null,
      policy: null,
      restored: true,
    });
  }
  const existingIndex = state.rules.findIndex((item) => handleKey(item.handle) === handleKey(rule.handle));
  if (existingIndex >= 0) state.rules[existingIndex] = cloneState(rule);
  else state.rules.push(cloneState(rule));
  reindexChain(state, rule.family, rule.table, rule.chain);
}

function restoreElements(state, family, table, setName, elements) {
  const set = requireSet(state, family, table, setName);
  for (const rawElement of elements) {
    const element = normalizeElement(rawElement);
    const index = set.elements.findIndex((item) => item.key === element.key);
    if (index >= 0) set.elements[index] = element;
    else set.elements.push(element);
  }
}

export function applyInverseStep(state, step) {
  const context = createCommandContext(state, { allowHandleReuse: true });
  if (step.op === 'restore-rule') return restoreRule(state, step.rule);
  if (step.op === 'restore-elements') {
    return restoreElements(state, step.family, step.table, step.set, step.elements);
  }
  if (step.op === 'restore-chain') {
    if (!getChain(state, step.chain.family, step.chain.table, step.chain.name)) state.chains.push(cloneState(step.chain));
    return { status: 'applied' };
  }
  if (step.op === 'restore-set') {
    if (!getSet(state, step.set.family, step.set.table, step.set.name)) state.sets.push(cloneState(step.set));
    return { status: 'applied' };
  }
  if (step.op === 'restore-table') {
    const fragment = step.fragment;
    if (!getTable(state, fragment.table.family, fragment.table.name)) state.tables.push(cloneState(fragment.table));
    for (const chain of fragment.chains ?? []) if (!getChain(state, chain.family, chain.table, chain.name)) state.chains.push(cloneState(chain));
    for (const set of fragment.sets ?? []) if (!getSet(state, set.family, set.table, set.name)) state.sets.push(cloneState(set));
    for (const rule of fragment.rules ?? []) restoreRule(state, cloneState(rule));
    return { status: 'applied' };
  }
  return applyCommand(state, step, context);
}

export function applyCommand(state, command, context = createCommandContext(state)) {
  context.commandIndex = command.index;
  context.commandId = command.id;
  command.__context = context;
  const result = { status: 'applied', undo: [], effects: {} };

  switch (command.op) {
    case 'add-table':
    case 'create-table': {
      const existing = getTable(state, command.family, command.table);
      if (existing) {
        if (command.op === 'create-table') throw commandError('TABLE_EXISTS', `Table ${command.family} ${command.table} already exists.`, command);
        return { status: 'unchanged', undo: [], effects: { table: command.table } };
      }
      state.tables.push({ family: command.family, name: command.table });
      return { status: 'applied', undo: [{ op: 'delete-table', family: command.family, table: command.table, id: `undo-${command.id}` }], effects: { created: true } };
    }

    case 'delete-table': {
      const table = requireTable(state, command.family, command.table);
      const fragment = {
        table: cloneState(table),
        chains: cloneState(state.chains.filter((item) => tableKey(item.family, item.table) === tableKey(command.family, command.table))),
        rules: cloneState(state.rules.filter((item) => tableKey(item.family, item.table) === tableKey(command.family, command.table))),
        sets: cloneState(state.sets.filter((item) => tableKey(item.family, item.table) === tableKey(command.family, command.table))),
      };
      state.tables = state.tables.filter((item) => tableKey(item.family, item.name) !== tableKey(command.family, command.table));
      state.chains = state.chains.filter((item) => tableKey(item.family, item.table) !== tableKey(command.family, command.table));
      state.rules = state.rules.filter((item) => tableKey(item.family, item.table) !== tableKey(command.family, command.table));
      state.sets = state.sets.filter((item) => tableKey(item.family, item.table) !== tableKey(command.family, command.table));
      return { status: 'applied', undo: [{ op: 'restore-table', fragment, id: `undo-${command.id}` }], effects: { deleted: true } };
    }

    case 'flush-table': {
      requireTable(state, command.family, command.table);
      const rules = state.rules.filter((item) => tableKey(item.family, item.table) === tableKey(command.family, command.table));
      const sets = state.sets.filter((item) => tableKey(item.family, item.table) === tableKey(command.family, command.table));
      const undo = rules.map((rule) => ({ op: 'restore-rule', rule: cloneState(rule) }));
      for (const set of sets) {
        if (set.elements?.length) undo.push({ op: 'restore-elements', family: set.family, table: set.table, set: set.name, elements: cloneState(set.elements) });
        set.elements = [];
      }
      state.rules = state.rules.filter((rule) => tableKey(rule.family, rule.table) !== tableKey(command.family, command.table));
      context.flushCounts ??= new Map();
      const flushKey = tableKey(command.family, command.table);
      const count = (context.flushCounts.get(flushKey) ?? 0) + 1;
      context.flushCounts.set(flushKey, count);
      return {
        status: undo.length ? 'applied' : 'unchanged',
        duplicate: count > 1,
        undo,
        effects: { flushedRules: rules.length, flushedSets: sets.length, flushCount: count },
      };
    }

    case 'add-chain':
    case 'create-chain': {
      requireTable(state, command.family, command.table);
      const existing = getChain(state, command.family, command.table, command.chain);
      if (existing) {
        if (command.op === 'create-chain') throw commandError('CHAIN_EXISTS', `Chain ${command.chain} already exists.`, command);
        return { status: 'unchanged', undo: [], effects: { chain: command.chain } };
      }
      const chain = {
        ...cloneState(command.chainConfig ?? {}),
        family: command.family,
        table: command.table,
        name: command.chain,
        type: command.type ?? null,
        hook: command.hook ?? null,
        priority: command.priority ?? 0,
        policy: command.policy ?? null,
      };
      state.chains.push(chain);
      return { status: 'applied', undo: [{ op: 'delete-chain', family: command.family, table: command.table, chain: command.chain, id: `undo-${command.id}` }], effects: { created: true, priority: chain.priority } };
    }

    case 'set-chain-priority':
    case 'update-chain': {
      const chain = requireChain(state, command.family, command.table, command.chain);
      const before = chain.priority;
      chain.priority = command.priority;
      return { status: 'applied', undo: [{ op: 'set-chain-priority', family: command.family, table: command.table, chain: command.chain, priority: before }], effects: { before, after: command.priority } };
    }

    case 'delete-chain': {
      requireChain(state, command.family, command.table, command.chain);
      const references = findChainReferences(state, command);
      if (references.length) {
        throw commandError('CHAIN_REFERENCED', `Chain ${command.chain} is referenced by ${references.length} rule(s); delete or change those rules first.`, command, { references });
      }
      const chain = cloneState(getChain(state, command.family, command.table, command.chain));
      const rules = chainRules(state, command.family, command.table, command.chain).map((rule) => cloneState(rule));
      state.rules = state.rules.filter((rule) => chainKey(rule.family, rule.table, rule.chain) !== chainKey(command.family, command.table, command.chain));
      state.chains = state.chains.filter((item) => chainKey(item.family, item.table, item.name) !== chainKey(command.family, command.table, command.chain));
      return {
        status: 'applied',
        undo: [
          { op: 'restore-chain', chain, id: `undo-chain-${command.id}` },
          ...rules.map((rule) => ({ op: 'restore-rule', rule })),
        ],
        effects: { deletedRules: rules.length },
      };
    }

    case 'flush-chain': {
      requireChain(state, command.family, command.table, command.chain);
      const rules = chainRules(state, command.family, command.table, command.chain).map((rule) => cloneState(rule));
      state.rules = state.rules.filter((rule) => chainKey(rule.family, rule.table, rule.chain) !== chainKey(command.family, command.table, command.chain));
      context.flushCounts ??= new Map();
      const flushKey = chainKey(command.family, command.table, command.chain);
      const count = (context.flushCounts.get(flushKey) ?? 0) + 1;
      context.flushCounts.set(flushKey, count);
      return {
        status: rules.length ? 'applied' : 'unchanged',
        duplicate: count > 1,
        undo: rules.map((rule) => ({ op: 'restore-rule', rule: cloneState(rule) })),
        effects: { flushedRules: rules.length, flushCount: count },
      };
    }

    case 'add-rule':
    case 'insert-rule': {
      requireChain(state, command.family, command.table, command.chain);
      const order = placementOrder(state, command);
      const requested = command.newHandle ?? command.allocatedHandle ?? command.handle ?? null;
      const handle = allocateHandle(state, command, context, requested);
      const rule = buildRule(command, handle);
      rule.family = command.family;
      rule.table = command.table;
      rule.chain = command.chain;
      rule.order = order;
      state.rules.push(rule);
      reindexChain(state, command.family, command.table, command.chain);
      return {
        status: 'applied',
        handle,
        undo: [{ op: 'delete-rule', family: command.family, table: command.table, chain: command.chain, handle, id: `undo-${command.id}` }],
        effects: { handle, order: rule.order },
      };
    }

    case 'replace-rule': {
      const rule = findHandleOrThrow(state, command, command.handle, { family: command.family, table: command.table, chain: command.chain });
      const before = cloneState(rule);
      const replacement = buildRule(command, rule.handle);
      Object.assign(rule, replacement, {
        handle: before.handle,
        family: before.family,
        table: before.table,
        chain: before.chain,
        order: before.order,
      });
      return { status: 'applied', handle: rule.handle, undo: [{ op: 'restore-rule', rule: before, id: `undo-${command.id}` }], effects: { handle: rule.handle } };
    }

    case 'delete-rule': {
      const rule = findHandleOrThrow(state, command, command.handle, { family: command.family, table: command.table, chain: command.chain });
      const before = cloneState(rule);
      state.rules = state.rules.filter((item) => handleKey(item.handle) !== handleKey(rule.handle));
      reindexChain(state, command.family, command.table, command.chain);
      context.deletedHandles.set(handleKey(rule.handle), {
        commandIndex: command.index,
        commandId: command.id,
        family: command.family,
        table: command.table,
        chain: command.chain,
      });
      return { status: 'applied', handle: rule.handle, undo: [{ op: 'restore-rule', rule: before, id: `undo-${command.id}` }], effects: { handle: rule.handle } };
    }

    case 'add-set':
    case 'create-set': {
      requireTable(state, command.family, command.table);
      const existing = getSet(state, command.family, command.table, command.set);
      if (existing) {
        if (command.op === 'create-set') throw commandError('SET_EXISTS', `Set ${command.set} already exists.`, command);
        return { status: 'unchanged', undo: [] };
      }
      const set = {
        ...cloneState(command.setConfig ?? {}),
        family: command.family,
        table: command.table,
        name: command.set,
        type: command.type ?? null,
        flags: command.flags ?? [],
        elements: (command.elements ?? []).map(normalizeElement).filter(Boolean),
      };
      state.sets.push(set);
      return { status: 'applied', undo: [{ op: 'delete-set', family: command.family, table: command.table, set: command.set }], effects: { created: true } };
    }

    case 'delete-set': {
      const set = requireSet(state, command.family, command.table, command.set);
      const references = findSetReferences(state, command);
      if (!command.force && references.length) {
        throw commandError('SET_REFERENCED', `Set @${command.set} is referenced by a rule.`, command, { references });
      }
      const snapshot = cloneState(set);
      state.sets = state.sets.filter((item) => setKey(item.family, item.table, item.name) !== setKey(command.family, command.table, command.set));
      return { status: 'applied', undo: [{ op: 'restore-set', set: snapshot }] };
    }

    case 'flush-set': {
      const set = requireSet(state, command.family, command.table, command.set);
      const oldElements = cloneState(set.elements);
      set.elements = [];
      context.flushCounts ??= new Map();
      const flushKey = setKey(command.family, command.table, command.set);
      const count = (context.flushCounts.get(flushKey) ?? 0) + 1;
      context.flushCounts.set(flushKey, count);
      return {
        status: oldElements.length ? 'applied' : 'unchanged',
        duplicate: count > 1,
        undo: oldElements.length ? [{ op: 'restore-elements', family: command.family, table: command.table, set: command.set, elements: oldElements }] : [],
        effects: { flushedElements: oldElements.length, flushCount: count },
      };
    }

    case 'add-element': {
      const set = requireSet(state, command.family, command.table, command.set);
      const candidates = (command.elements ?? []).map(normalizeElement).filter(Boolean);
      if (!candidates.length) throw commandError('ELEMENTS_REQUIRED', 'add-element requires elements.', command);
      const policy = command.conflict ?? command.onConflict ?? context.elementConflict;
      const added = [];
      const skipped = [];
      const replaced = [];
      for (const candidate of candidates) validateElement(set, candidate, command);
      for (const candidate of candidates) {
        const index = set.elements.findIndex((item) => item.key === candidate.key);
        if (index >= 0) {
          if (policy === 'fail') {
            throw commandError('ELEMENT_CONFLICT', `Element ${candidate.value} already exists in set ${set.name}.`, command, {
              set: set.name,
              element: candidate.value,
              existing: set.elements[index],
            });
          }
          if (policy === 'replace') {
            replaced.push(cloneState(set.elements[index]));
            set.elements[index] = candidate;
          } else {
            skipped.push(candidate.value);
          }
        } else {
          set.elements.push(candidate);
          added.push(candidate.value);
        }
      }
      const undo = [];
      if (added.length) undo.push({ op: 'delete-element', family: command.family, table: command.table, set: command.set, elements: added, missingOk: true });
      if (replaced.length) undo.push({ op: 'restore-elements', family: command.family, table: command.table, set: command.set, elements: replaced });
      return { status: added.length || replaced.length ? 'applied' : 'unchanged', undo, effects: { added, skipped, replaced: replaced.map((item) => item.value) } };
    }

    case 'delete-element': {
      const set = requireSet(state, command.family, command.table, command.set);
      const candidates = (command.elements ?? []).map(normalizeElement).filter(Boolean);
      const removed = [];
      for (const candidate of candidates) {
        const index = set.elements.findIndex((item) => item.key === candidate.key);
        if (index < 0) {
          if (command.missingOk) continue;
          throw commandError('ELEMENT_NOT_FOUND', `Element ${candidate.value} does not exist in set ${set.name}.`, command, { element: candidate.value });
        }
        removed.push(cloneState(set.elements[index]));
        set.elements.splice(index, 1);
      }
      return {
        status: removed.length ? 'applied' : 'unchanged',
        undo: removed.length ? [{ op: 'restore-elements', family: command.family, table: command.table, set: command.set, elements: removed }] : [],
        effects: { removed: removed.map((item) => item.value) },
      };
    }

    case 'raw':
      throw commandError('UNPARSED_COMMAND', `Could not parse nft command: ${command.raw}`, command);

    default:
      throw commandError('UNSUPPORTED_COMMAND', `Unsupported command op: ${command.op}`, command);
  }
}
