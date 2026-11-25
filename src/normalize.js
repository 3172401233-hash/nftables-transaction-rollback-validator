import { TransactionValidationError } from './errors.js';

export const DEFAULT_FAMILY = 'inet';
export const NFT_FAMILIES = new Set(['inet', 'ip', 'ip6', 'arp', 'bridge', 'netdev']);

export function cloneState(value) {
  return structuredClone(value);
}

export function handleKey(handle) {
  if (handle === null || handle === undefined) return '';
  return String(handle);
}

export function normalizeHandle(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : String(value);
  if (typeof value === 'bigint') return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    const number = Number(text);
    return Number.isSafeInteger(number) ? number : text;
  }
  return text;
}

export function tableIdOf(value, defaults = {}) {
  if (!value) {
    return { family: defaults.family ?? DEFAULT_FAMILY, table: defaults.table };
  }
  if (typeof value === 'string') {
    const parts = value.trim().split(/\s+/);
    if (parts.length === 2 && NFT_FAMILIES.has(parts[0])) {
      return { family: parts[0], table: parts[1] };
    }
    if (parts.length >= 2 && NFT_FAMILIES.has(parts[0])) {
      return { family: parts[0], table: parts[1] };
    }
    return { family: defaults.family ?? DEFAULT_FAMILY, table: parts[0] };
  }
  const family = value.family ?? defaults.family ?? DEFAULT_FAMILY;
  const table = value.table ?? value.name ?? defaults.table;
  return { family, table };
}

export function chainIdOf(value, defaults = {}) {
  if (!value) {
    return { ...tableIdOf(defaults.tableRef ?? defaults, defaults), chain: defaults.chain };
  }
  if (typeof value === 'string') {
    const text = value.trim();
    const parts = text.split(/\s+/);
    if (parts.length >= 3 && NFT_FAMILIES.has(parts[0])) {
      return { family: parts[0], table: parts[1], chain: parts.slice(2).join(' ') };
    }
    if (parts.length >= 2 && !NFT_FAMILIES.has(parts[0])) {
      return { family: defaults.family ?? DEFAULT_FAMILY, table: parts[0], chain: parts.slice(1).join(' ') };
    }
    const table = defaults.table;
    return { family: defaults.family ?? DEFAULT_FAMILY, table, chain: text };
  }
  const tableId = tableIdOf(value, defaults);
  return { family: value.family ?? tableId.family, table: value.table ?? value.name ?? tableId.table, chain: value.chain ?? value.chainName ?? value.name ?? defaults.chain };
}

export const tableKey = (family, table) => `${family}/${table}`;
export const chainKey = (family, table, chain) => `${tableKey(family, table)}/${chain}`;
export const setKey = (family, table, name) => `${tableKey(family, table)}/${name}`;
export const ruleKey = (family, table, chain, handle) => `${chainKey(family, table, chain)}/${handleKey(handle)}`;

export function normalizeElement(element) {
  if (element === null || element === undefined) return null;
  if (typeof element === 'string' || typeof element === 'number' || typeof element === 'bigint') {
    const value = typeof element === 'bigint' ? element.toString() : element;
    return { value, key: String(value) };
  }
  const value = element.value ?? element.key ?? element.address ?? element.addr;
  if (value === undefined) return null;
  const normalized = { ...element, value };
  normalized.key = element.key ?? `${element.type ?? ''}:${String(value)}`;
  return normalized;
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function normalizeRuleset(snapshot = {}, inputDefaults = {}) {
  const defaults = {
    family: snapshot.family ?? inputDefaults.family ?? DEFAULT_FAMILY,
    table: inputDefaults.table,
    chain: inputDefaults.chain,
  };

  const state = {
    schemaVersion: 1,
    tables: [],
    chains: [],
    rules: [],
    sets: [],
  };

  for (const rawTable of asArray(snapshot.tables)) {
    const table = typeof rawTable === 'string'
      ? tableIdOf(rawTable, defaults)
      : { family: rawTable.family ?? defaults.family, name: rawTable.name ?? rawTable.table, ...rawTable };
    state.tables.push({ family: table.family, name: table.name ?? table.table });
  }

  if (snapshot.table) {
    const id = tableIdOf(snapshot.table, defaults);
    if (!state.tables.some((item) => tableKey(item.family, item.name) === tableKey(id.family, id.table))) {
      state.tables.push({ family: id.family, name: id.table });
    }
  }

  if (!defaults.table && state.tables.length === 1) {
    defaults.table = state.tables[0].name;
    defaults.family = inputDefaults.family ?? state.tables[0].family;
  }

  for (const rawChain of asArray(snapshot.chains)) {
    const chain = typeof rawChain === 'string'
      ? { ...chainIdOf(rawChain, defaults) }
      : rawChain;
    const family = chain.family ?? defaults.family;
    const table = chain.table ?? chain.tableName ?? defaults.table;
    const name = chain.name ?? chain.chain ?? chain.chainName;
    if (!table || !name) {
      throw new TransactionValidationError('INVALID_SNAPSHOT', 'Chain requires family/table/name.', { chain: rawChain });
    }
    state.chains.push({
      ...chain,
      family,
      table,
      name,
      type: chain.type ?? null,
      hook: chain.hook ?? null,
      priority: chain.priority ?? inputDefaults.priority ?? 0,
      policy: chain.policy ?? null,
    });
  }

  for (const rawSet of asArray(snapshot.sets)) {
    const family = rawSet.family ?? defaults.family;
    const table = rawSet.table ?? rawSet.tableName ?? defaults.table;
    const name = rawSet.name ?? rawSet.set;
    if (!table || !name) {
      throw new TransactionValidationError('INVALID_SNAPSHOT', 'Set requires family/table/name.', { set: rawSet });
    }
    state.sets.push({
      ...rawSet,
      family,
      table,
      name,
      type: rawSet.type ?? rawSet.setType ?? null,
      elements: asArray(rawSet.elements).map(normalizeElement).filter(Boolean),
    });
  }

  const rawRules = asArray(snapshot.rules ?? snapshot.handles);
  let autoHandle = 1;
  for (let index = 0; index < rawRules.length; index += 1) {
    const rawRule = rawRules[index];
    const family = rawRule.family ?? defaults.family;
    const table = rawRule.table ?? rawRule.tableName ?? defaults.table;
    const chain = rawRule.chain ?? rawRule.chainName ?? defaults.chain;
    if (!table || !chain) {
      throw new TransactionValidationError('INVALID_SNAPSHOT', 'Rule requires family/table/chain.', { rule: rawRule });
    }
    let handle = normalizeHandle(rawRule.handle ?? rawRule.handleId);
    if (handle === null) {
      while (state.rules.some((rule) => handleKey(rule.handle) === String(autoHandle))) autoHandle += 1;
      handle = autoHandle;
      autoHandle += 1;
    }
    const rule = {
      ...rawRule,
      handle,
      family,
      table,
      chain,
      order: rawRule.order ?? rawRule.index ?? index,
      expression: rawRule.expression ?? rawRule.exprText ?? '',
      action: rawRule.action ?? null,
    };
    delete rule.index;
    state.rules.push(rule);
  }

  for (const chain of state.chains) {
    reindexChain(state, chain.family, chain.table, chain.name);
  }

  const maxHandle = state.rules.reduce((max, rule) => {
    return typeof rule.handle === 'number' ? Math.max(max, rule.handle) : max;
  }, 0);
  state.nextHandle = maxHandle + 1;
  return state;
}

export function getTable(state, family, table) {
  return state.tables.find((item) => item.family === family && item.name === table) ?? null;
}

export function requireTable(state, family, table) {
  const item = getTable(state, family, table);
  if (!item) {
    throw new TransactionValidationError('TABLE_NOT_FOUND', `Table ${family} ${table} does not exist.`, { family, table });
  }
  return item;
}

export function getChain(state, family, table, chain) {
  return state.chains.find((item) => chainKey(item.family, item.table, item.name) === chainKey(family, table, chain)) ?? null;
}

export function requireChain(state, family, table, chain) {
  const item = getChain(state, family, table, chain);
  if (!item) {
    throw new TransactionValidationError('CHAIN_NOT_FOUND', `Chain ${family} ${table} ${chain} does not exist.`, { family, table, chain });
  }
  return item;
}

export function getSet(state, family, table, name) {
  return state.sets.find((item) => setKey(item.family, item.table, item.name) === setKey(family, table, name)) ?? null;
}

export function requireSet(state, family, table, name) {
  const item = getSet(state, family, table, name);
  if (!item) {
    throw new TransactionValidationError('SET_NOT_FOUND', `Set ${family} ${table} ${name} does not exist.`, { family, table, name });
  }
  return item;
}

export function chainRules(state, family, table, chain) {
  return state.rules
    .filter((rule) => chainKey(rule.family, rule.table, rule.chain) === chainKey(family, table, chain))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || handleKey(a.handle).localeCompare(handleKey(b.handle)));
}

export function reindexChain(state, family, table, chain) {
  const rules = chainRules(state, family, table, chain);
  rules.forEach((rule, index) => {
    rule.order = index;
  });
}

export function findRuleByHandle(state, handle, scope = {}) {
  const normalized = normalizeHandle(handle);
  return state.rules.find((rule) => {
    if (handleKey(rule.handle) !== handleKey(normalized)) return false;
    if (scope.table && tableKey(rule.family, rule.table) !== tableKey(scope.family ?? DEFAULT_FAMILY, scope.table)) return false;
    if (scope.chain && chainKey(rule.family, rule.table, rule.chain) !== chainKey(scope.family ?? rule.family, scope.table ?? rule.table, scope.chain)) return false;
    return true;
  }) ?? null;
}

export function ruleReferencesChain(rule, chainName) {
  if (!rule || !chainName) return false;
  const verdict = rule.verdict ?? rule.target ?? {};
  if (typeof verdict === 'string' && verdict === chainName) return true;
  if (verdict && typeof verdict === 'object') {
    if (verdict.jump === chainName || verdict.goto === chainName) return true;
  }
  if (rule.jump === chainName || rule.goto === chainName || rule.target === chainName) return true;
  const expression = [
    rule.expression,
    rule.exprText,
    typeof rule.expr === 'string' ? rule.expr : '',
    JSON.stringify(rule.expr ?? {}),
  ].filter(Boolean).join(' ');
  return new RegExp(`\\b(?:jump|goto)\\s+${escapeRegExp(chainName)}\\b`).test(expression);
}

export function ruleReferencesSet(rule, setName) {
  if (!rule || !setName) return false;
  const expression = [rule.expression, rule.exprText, JSON.stringify(rule.expr ?? {})].filter(Boolean).join(' ');
  return new RegExp(`@${escapeRegExp(setName)}\\b`).test(expression);
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function summarizeRules(state) {
  return chainOrder(state).flatMap((chain) => chainRules(state, chain.family, chain.table, chain.name).map((rule) => ({
    handle: rule.handle,
    family: rule.family,
    table: rule.table,
    chain: rule.chain,
    priority: chain.priority ?? null,
    order: rule.order,
    action: rule.action ?? null,
    expression: rule.expression ?? '',
  })));
}

export function chainOrder(state) {
  return [...state.chains].sort((a, b) => {
    const tableCompare = tableKey(a.family, a.table).localeCompare(tableKey(b.family, b.table));
    if (tableCompare !== 0) return tableCompare;
    return String(a.name).localeCompare(String(b.name));
  });
}
