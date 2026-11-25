import { verifyTransaction } from './transaction.js';

export {
  verifyTransaction,
  compareStrategies,
  buildCommands,
  normalizeFailure,
  applyRecoveryOrder,
} from './transaction.js';
export { normalizeRuleset, summarizeRules } from './normalize.js';
export { parseNftCommand, splitScriptCommands } from './parser.js';
export { applyCommand, normalizeCommand } from './commands.js';
export { TransactionValidationError, CommitInterruptedError } from './errors.js';

export function renderRuleset(ruleset) {
  if (!ruleset) return '<unknown commit outcome: reconcile with nft list ruleset>';
  const lines = [];
  for (const table of ruleset.tables ?? []) {
    lines.push(`table ${table.family} ${table.name} {`);
    for (const chain of (ruleset.chains ?? []).filter((item) => item.family === table.family && item.table === table.name)) {
      const priority = chain.priority === undefined ? '' : ` priority ${chain.priority};`;
      const hook = chain.hook ? ` hook ${chain.hook};` : '';
      const type = chain.type ? ` type ${chain.type};` : '';
      const policy = chain.policy ? ` policy ${chain.policy};` : '';
      lines.push(`  chain ${chain.name} {${type}${hook}${priority}${policy} }`);
      for (const rule of (ruleset.rules ?? [])
        .filter((item) => item.family === table.family && item.table === table.name && item.chain === chain.name)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
        lines.push(`    # handle ${rule.handle} order ${rule.order}: ${rule.expression || JSON.stringify(rule.expr ?? {})}`);
      }
    }
    for (const set of (ruleset.sets ?? []).filter((item) => item.family === table.family && item.table === table.name)) {
      const values = (set.elements ?? []).map((element) => element.value ?? element).join(', ');
      lines.push(`  set ${set.name} { type ${set.type ?? 'unknown'}; elements = { ${values} }; }`);
    }
    lines.push('}');
  }
  return lines.join('\n');
}

export const simulateTransaction = verifyTransaction;
export const validateTransaction = verifyTransaction;
export const runBatch = verifyTransaction;
export const planTransaction = verifyTransaction;
export const calculateFinalRuleset = verifyTransaction;

export class NftTransaction {
  constructor(input = {}) {
    this.input = input;
  }

  run() {
    return verifyTransaction(this.input);
  }
}
