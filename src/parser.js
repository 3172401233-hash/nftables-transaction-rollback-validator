import { DEFAULT_FAMILY, NFT_FAMILIES, normalizeHandle } from './normalize.js';

const FAMILY_PATTERN = `(?:(?<family>inet|ip6?|arp|bridge|netdev)\\s+)?`;

export function splitScriptCommands(script) {
  const lines = String(script).split(/\r?\n/);
  const commands = [];
  let buffer = '';
  let depth = 0;
  let quote = null;

  for (const rawLine of lines) {
    let line = rawLine;
    if (!quote) line = line.replace(/(^|\s)#.*$/, '$1');
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (quote) {
        if (char === quote && line[index - 1] !== '\\') quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth = Math.max(0, depth - 1);
      }
    }
    buffer = buffer ? `${buffer} ${line.trim()}` : line.trim();
    if (buffer && depth === 0) {
      commands.push(buffer.replace(/\\;/g, ';').replace(/\s+/g, ' ').trim());
      buffer = '';
    }
  }
  if (buffer.trim()) commands.push(buffer.replace(/\\;/g, ';').replace(/\s+/g, ' ').trim());
  return commands.filter(Boolean);
}

function opFromText(text) {
  const tokens = text.trim().split(/\s+/);
  const first = tokens[0]?.toLowerCase();
  const second = tokens[1]?.toLowerCase();
  if (first === 'add' || first === 'create' || first === 'delete' || first === 'flush' || first === 'insert' || first === 'replace') {
    if (['table', 'chain', 'rule', 'set', 'element'].includes(second)) return `${first}-${second}`;
  }
  if (first === 'set' && second === 'chain' && tokens[2]?.toLowerCase() === 'priority') return 'set-chain-priority';
  return null;
}

function matchTarget(pattern, text) {
  const match = text.match(pattern);
  if (!match) return null;
  return { ...match.groups, rest: match.groups.rest?.trim() ?? '' };
}

function parseFamilyTableObject(text, defaultFamily) {
  const pattern = new RegExp(`^${FAMILY_PATTERN}(?<table>[\\w.:-]+)\\s+(?<object>[\\w.:-]+)(?<rest>\\s+.*)?$`, 's');
  const parsed = matchTarget(pattern, text.trim());
  if (!parsed) return null;
  let { family, table, object, rest } = parsed;
  if (!family && NFT_FAMILIES.has(table) && rest) {
    const shifted = rest.trim().match(/^(?<object2>[\w.:-]+)(?<rest2>\s+.*)?$/s);
    family = table;
    table = object;
    object = shifted?.groups.object2 ?? object;
    rest = shifted?.groups.rest2 ?? '';
  }
  return { family: family ?? defaultFamily, table, object, rest: rest?.trim() ?? '' };
}

function parseFamilyTable(text, defaultFamily) {
  const pattern = new RegExp(`^${FAMILY_PATTERN}(?<name>[\\w.:-]+)(?<rest>\\s+.*)?$`, 's');
  const parsed = matchTarget(pattern, text.trim());
  if (!parsed) return null;
  let { family, name, rest } = parsed;
  if (!family && NFT_FAMILIES.has(name)) {
    const next = rest?.trim().split(/\s+/) ?? [];
    family = name;
    name = next[0];
    rest = rest?.trim().slice(name.length).trim() ?? '';
  }
  return { family: family ?? defaultFamily, name, rest: rest?.trim() ?? '' };
}

function extractBraces(text) {
  const start = text.indexOf('{');
  if (start < 0) return { before: text.trim(), block: '', after: '' };
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    if (text[index] === '}') depth -= 1;
    if (depth === 0) {
      return {
        before: text.slice(0, start).trim(),
        block: text.slice(start + 1, index).trim(),
        after: text.slice(index + 1).trim(),
      };
    }
  }
  return { before: text.slice(0, start).trim(), block: text.slice(start + 1).trim(), after: '' };
}

function parsePriority(value) {
  if (value === undefined) return undefined;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

function parseChainBlock(block) {
  if (!block) return {};
  const read = (key) => block.match(new RegExp(`\\b${key}\\s+(-?[\\w.:-]+)`))?.[1]?.trim();
  return {
    type: read('type') ?? null,
    hook: read('hook') ?? null,
    priority: parsePriority(read('priority')),
    policy: read('policy') ?? null,
    device: read('device') ?? null,
  };
}

function parseElementList(block) {
  return block
    .split(/,|\n/)
    .map((item) => item.trim().replace(/;$/, '').trim())
    .filter(Boolean);
}

function extractHandleAndPosition(expression) {
  let text = ` ${expression} `;
  const result = { expression: text.trim() };
  const handle = text.match(/\bhandle\s+(\d+)\b/);
  if (handle) {
    result.handle = normalizeHandle(handle[1]);
    text = text.replace(handle[0], ' ');
  }
  const position = text.match(/\bposition\s+(\d+)\b/);
  if (position) {
    result.positionHandle = normalizeHandle(position[1]);
    text = text.replace(position[0], ' ');
  }
  const after = text.match(/\bafter\s+(?:handle\s+)?(\d+)\b/);
  if (after) {
    result.afterHandle = normalizeHandle(after[1]);
    text = text.replace(after[0], ' ');
  }
  const before = text.match(/\bbefore\s+(?:handle\s+)?(\d+)\b/);
  if (before) {
    result.beforeHandle = normalizeHandle(before[1]);
    text = text.replace(before[0], ' ');
  }
  result.expression = text.replace(/\s+/g, ' ').trim();
  const action = result.expression.match(/\b(accept|drop|reject|return|continue|queue)\b\s*$/)?.[1];
  if (action) result.action = action;
  return result;
}

export function parseNftCommand(input, defaults = {}) {
  const text = String(input).trim().replace(/\s+/g, ' ');
  const op = opFromText(text);
  const defaultFamily = defaults.family ?? DEFAULT_FAMILY;
  if (!op) {
    return { op: 'raw', raw: text, expression: text, family: defaultFamily, table: defaults.table };
  }

  const body = text.slice(text.indexOf(' ') + 1).replace(/^[a-z]+\s+/i, '');

  if (op.endsWith('-table')) {
    const target = parseFamilyTable(body, defaultFamily);
    return { op, family: target.family, table: target.name };
  }

  if (op === 'set-chain-priority') {
    const match = text.match(/^set\s+chain\s+(?<target>.*?)\s+priority\s+(?<priority>-?\w+)$/i);
    const target = parseFamilyTableObject(match.groups.target, defaultFamily);
    return {
      op,
      family: target.family,
      table: target.table,
      chain: target.object,
      priority: parsePriority(match.groups.priority),
    };
  }

  if (op.endsWith('-chain')) {
    const braces = extractBraces(body);
    const target = parseFamilyTableObject(braces.before, defaultFamily);
    return {
      op,
      family: target.family,
      table: target.table,
      chain: target.object,
      ...parseChainBlock(braces.block),
    };
  }

  if (op.endsWith('-set')) {
    const braces = extractBraces(body);
    const target = parseFamilyTableObject(braces.before, defaultFamily);
    const set = {
      op,
      family: target.family,
      table: target.table,
      set: target.object,
      name: target.object,
    };
    if (braces.block) {
      const type = braces.block.match(/\btype\s+([^\s;]+)/)?.[1];
      if (type) set.type = type;
      const flags = braces.block.match(/\bflags\s+([^\s;]+)/)?.[1];
      if (flags) set.flags = flags.split(',');
      const elements = braces.block.match(/\belements\s*=\s*\{([^}]*)\}/)?.[1];
      if (elements) set.elements = parseElementList(elements);
    }
    return set;
  }

  if (op.endsWith('-element')) {
    const braces = extractBraces(body);
    const target = parseFamilyTableObject(braces.before, defaultFamily);
    return {
      op,
      family: target.family,
      table: target.table,
      set: target.object,
      name: target.object,
      elements: parseElementList(braces.block),
    };
  }

  if (op.endsWith('-rule')) {
    const target = parseFamilyTableObject(body, defaultFamily);
    const details = extractHandleAndPosition(target.rest);
    return {
      op,
      family: target.family,
      table: target.table,
      chain: target.object,
      ...details,
    };
  }

  return { op: 'raw', raw: text };
}

export function normalizeOp(op) {
  if (!op) return op;
  const text = String(op).trim().toLowerCase().replace(/[_\s]+/g, '-');
  const aliases = {
    create: 'create-table',
    add: 'add-table',
    delete: 'delete-table',
    flush: 'flush-table',
    'remove-rule': 'delete-rule',
    del: 'delete-rule',
    'remove-element': 'delete-element',
  };
  return aliases[text] ?? text;
}
