export function snapshotWithRules() {
  return {
    tables: [{ family: 'inet', name: 'filter' }],
    chains: [
      { family: 'inet', table: 'filter', name: 'input', type: 'filter', hook: 'input', priority: 0, policy: 'drop' },
      { family: 'inet', table: 'filter', name: 'web' },
    ],
    sets: [
      {
        family: 'inet',
        table: 'filter',
        name: 'trusted_v4',
        type: 'ipv4_addr',
        elements: ['198.51.100.10'],
      },
    ],
    rules: [
      { handle: 10, chain: 'input', expression: 'ct state established,related accept', action: 'accept' },
      { handle: 20, chain: 'input', protocol: 'tcp', dport: 80, expression: 'tcp dport 80 drop', action: 'drop' },
      { handle: 99, chain: 'input', expression: 'tcp dport 8080 accept', action: 'accept' },
    ],
  };
}

export function duplicateHandleBatch() {
  return [
    {
      id: 'allow-http',
      op: 'add-rule',
      family: 'inet',
      table: 'filter',
      chain: 'input',
      newHandle: 100,
      protocol: 'tcp',
      dport: 80,
      expression: 'tcp dport 80 accept',
      action: 'accept',
    },
    { id: 'delete-obsolete-once', op: 'delete-rule', family: 'inet', table: 'filter', chain: 'input', handle: 99 },
    { id: 'delete-obsolete-twice', op: 'delete-rule', family: 'inet', table: 'filter', chain: 'input', handle: 99 },
    { id: 'delete-conflicting-drop', op: 'delete-rule', family: 'inet', table: 'filter', chain: 'input', handle: 20 },
  ];
}
