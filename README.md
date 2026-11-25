# nftables-transaction-rollback-validator

用纯 Node.js 内存模型验证 nftables 风格 batch 事务、rule handle 失效、chain 引用、set 冲突、重复 flush、提交中断和恢复顺序。

> 安全边界：本项目**不执行真实 `nft` 命令**，不访问 netlink、内核 nftables、网络命名空间或防火墙。`src/` 和 CLI 不调用 `child_process`（只有 CLI 测试会用 Node 子进程启动本项目自己的 CLI）；所有 table、chain、rule、handle 和 set 元素都只是 JSON/内存状态。它用于事务设计、测试和恢复顺序推演，不能替代在隔离 netns 中对真实内核版本做验证。

## 运行环境

已在 Node.js `v24.16.0` 下运行：

```bash
node --version   # v24.16.0
node --test
```

零第三方依赖，也不需要 `npm install`。`package.json` 中的 `engines.node` 为 `>=24.16.0`。

## CLI

```bash
node bin/nft-tx-verify.js examples/handle-stale-batch.json
node bin/nft-tx-verify.js --strict examples/handle-stale-batch.json
cat input.json | node bin/nft-tx-verify.js
```

默认即使模拟出失败事务，CLI 进程也输出 JSON 并以 0 退出；加 `--strict` 时，`report.ok === false` 或提交结果不确定会以状态码 1 退出。

编程接口：

```js
import { verifyTransaction, applyRecoveryOrder } from './src/index.js';

const report = verifyTransaction(input);
console.log(report.committedRules);
console.log(report.failedCommands);
console.log(report.recoveryOrder);

const restored = applyRecoveryOrder(
  report.finalRuleset,
  report.recoveryOrder,
  report.snapshot,
);
```

别名导出包括 `simulateTransaction`、`validateTransaction`、`runBatch`、`planTransaction` 和 `calculateFinalRuleset`。

## 输入模型

输入是一个 JSON 对象：

```jsonc
{
  "family": "inet",
  "table": "filter",
  "chain": "input",
  "priority": 0,
  "ruleHandle": 99,
  "set": "blocklist",
  "elements": ["203.0.113.7"],

  "snapshot": {
    "tables": [{ "family": "inet", "name": "filter" }],
    "chains": [
      { "name": "input", "type": "filter", "hook": "input", "priority": 0, "policy": "drop" }
    ],
    "rules": [
      { "handle": 20, "chain": "input", "expression": "tcp dport 80 drop", "action": "drop" }
    ],
    "sets": [
      { "name": "blocklist", "type": "ipv4_addr", "elements": ["198.51.100.10"] }
    ]
  },

  "batch": [
    { "id": "allow-http", "op": "add-rule", "newHandle": 100, "dport": 80, "action": "accept" },
    { "id": "delete-old", "op": "delete-rule", "handle": 99 },
    { "id": "stale", "op": "delete-rule", "handle": 99 }
  ],

  "failureLocation": "stale"
}
```

顶层 `table`、`chain`、`priority`、`ruleHandle`/`handle`、`set` 和 `elements` 会作为省略字段的默认值。只有一个 snapshot table 时会自动推断 table。

`batch` 也可以是 nft 风格字符串数组，或包含换行和 `{ ... }` block 的整段脚本：

```text
add table inet filter
add chain inet filter input { type filter hook input priority -10; policy drop; }
delete rule inet filter input handle 99
add element inet filter blocklist { 203.0.113.7 }
```

支持的主要 op：

- table：`add-table`、`create-table`、`delete-table`、`flush-table`
- chain：`add-chain`、`create-chain`、`delete-chain`、`flush-chain`、`set-chain-priority`
- rule：`add-rule`、`insert-rule`、`replace-rule`、`delete-rule`
- handle 定位：`handle`、`newHandle`、`afterHandle`/`positionHandle`、`beforeHandle`
- set：`add-set`、`create-set`、`delete-set`、`flush-set`
- element：`add-element`、`delete-element`

## 失败位置和中断

- `failureLocation`：命令 ID，或从 1 开始的命令位置；数字字符串也按位置处理。
- `failureAt`：从 0 开始的索引，或命令 ID。
- `failure.index` / `failure.position` / `failure.id`：显式定位。
- `failure.phase`：`before`（默认）、`after` 或 `commit`。
- `failure.outcome`：提交中断结果：
  - `aborted`：未提交，可原子回滚；
  - `unknown`：真实中断后结果未知，必须先 reconcile；
  - `applied`：实际已提交，只是调用方收到中断/超时，需要 checkpoint 或补偿恢复。

如果失败位置正好指向一个自然校验错误，例如 stale handle，引擎会先做 dry-run 校验并返回自然错误，不会用注入错误掩盖根因。

## 三种提交边界

### 1. 整批原子事务（默认）

单个 `batch` 或 `commands` 数组在暂存状态中顺序执行。任一命令失败：

- `committed: false`
- `status: "rolled-back"`
- `finalRuleset` 等于规范化后的 `snapshot`
- `rollbackScope: "whole-batch"`
- `recoveryOrder[0].op` 为 `restore-snapshot`

报告仍保留 `commandResults` 和 `recovery.stagedInverseOrder`，用于查看失败前暂存区执行到了哪里，以及如果错误地逐条提交时原本需要哪些逆操作。

### 2. 逐条提交

设置 `"mode": "per-command"`。每条命令立即成为可见状态的一部分；后续命令失败时，前面的命令不会自动回滚。

这会复现“新 allow 已提交、旧 deny 尚未删除”的中间状态。报告中的：

- `status: "partially-committed"`
- `rollbackScope: "applied-commands"`
- `mixedState.simultaneousAllowAndDeny`
- `recovery.inverseCommands`

会给出共存的 accept/drop handle，并按成功日志的逆序生成恢复命令。

### 3. 可隔离的子事务

传入 `subtransactions: [{ "id": "...", "commands": [...] }]`，或设置 `"mode": "subtransaction"` 并用 `subtransaction`/`group` 字段给命令分组。

每个子事务自身是 all-or-nothing：

- 失败子事务的暂存修改被丢弃；
- 已提交的前序子事务保留；
- 后续子事务默认跳过，ID 出现在 `classification.skippedSubtransactionIds`；
- `rollbackScope` 首先是 `subtransaction:<id>`；
- 若要整体恢复到原始 snapshot，`recoveryOrder` 会逆序补偿所有已提交子事务。

重试分类在 `report.retry`：

- stale handle、chain 引用、set 冲突等确定性错误不能原样重试，需要刷新 snapshot/handle 或修正输入；
- `outcome: "aborted"` 保证子事务边界干净，因此可在重建 handle 或解决冲突后安全重试；
- `TRANSIENT_FAILURE` 且结果明确未提交时 `safeToRetry: true`；
- `outcome: "unknown"` 时 `safeToRetry: false`，策略为 `reconcile-live-ruleset-before-retry`；
- 可用 `completedSubtransactions` 配合中断后的当前 snapshot 跳过已提交单元。

## 关键校验规则

- **已删除 handle**：同一 batch 中删除 handle 后，再次 `delete`/`replace`，或用 `afterHandle`、`beforeHandle`、`positionHandle` 引用它，会返回 `STALE_HANDLE`，详情包含首次删除位置 `details.deletedAt`。
- **handle 不复用**：batch 内删除的 handle 不会被自动分配器再次使用；显式复用返回 `HANDLE_REUSED`。
- **真实 handle 说明**：真实 nft handle 通常由内核分配，`delete/replace ... handle <n>` 引用已知 handle；输入里的 `newHandle` 是测试和快照对齐用的确定性赋值，不表示真实 `nft add rule` 一定接受客户端指定 handle。
- **chain 引用**：删除 chain 前扫描 `verdict.jump`、`verdict.goto`、`jump <chain>` 和 `goto <chain>`。仍有规则引用时返回 `CHAIN_REFERENCED` 和引用规则 handle；先删除引用规则后即可删除 chain。
- **set 冲突**：`add-element` 支持 `conflict: "fail" | "ignore" | "replace"`，也可通过顶层 `setConflict` 设置。重复元素且 `fail` 时返回 `ELEMENT_CONFLICT`；IP、端口、MAC 类型不匹配返回 `SET_TYPE_CONFLICT`。
- **重复 flush**：重复 `flush-set`、`flush-chain` 或 `flush-table` 不报错；第二次结果为 `status: "unchanged"`、`duplicateFlush: true`。恢复日志只包含第一次 flush 捕获的旧元素/规则。

## 输出结构

CLI/API 报告的核心字段：

```js
{
  ok,
  executesRealNft: false,
  mode,                    // atomic | per-command | subtransaction
  status,
  committed,
  uncertain,
  snapshot,
  finalRuleset,            // null 表示提交结果未知，需要 reconcile
  committedRules,          // 别名 rules，附带 chain priority/order
  failedCommands: [{
    commandIndex,
    position,
    commandId,
    phase,                 // command | commit
    code,
    message,
    stale,
    outcome,
    command,
    details
  }],
  rollbackScope,
  classification,
  commandResults,
  subtransactions,
  recovery: {
    strategy,
    scope,
    inverseCommands,
    order
  },
  recoveryOrder,
  retry,
  possibleRulesets,
  mixedState
}
```

`committedRules` 会按 table/chain 和规则顺序输出 handle、priority、action、expression。`possibleRulesets` 只在提交结果未知时出现，包含 `lastKnownGood` 和 `tentativeCommitted` 两种可能状态。

## 示例

```bash
node bin/nft-tx-verify.js examples/handle-stale-batch.json \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s); console.log(r.status, r.failedCommands[0].code, r.committedRules.map(x=>x.handle));})"
# rolled-back STALE_HANDLE [ 10, 20, 99 ]
```

把同一输入改成 `"mode": "per-command"` 后，会得到部分提交状态，其中新 allow handle `100` 与旧 drop handle `20` 共存；`recoveryOrder` 先恢复被删除的 handle `99`，再删除新建的 handle `100`，最后校验 snapshot。

子事务中断示例：

```bash
node bin/nft-tx-verify.js examples/subtransaction-commit.json
```

## 测试覆盖

`node --test` 当前覆盖：

- stale handle 重复删除和已删除 position 引用；
- 合法 before/after handle 排序；
- chain 被 `jump` 规则引用及解除引用后的删除；
- 逐条提交产生 allow/deny 混合状态和逆序恢复；
- set 重复元素冲突、默认幂等、类型冲突；
- 重复 flush set/table 与恢复步骤去重；
- 失败位置注入；
- atomic commit 的 `aborted`、`unknown`、`applied` 三种中断结果；
- 子事务隔离、跳过后续单元、检查点续跑和重建 handle 后重试；
- nft 风格字符串解析、顶层默认字段和 CLI strict 退出码。

## 目录

- `src/normalize.js`：snapshot 规范化、键和查询 helper。
- `src/parser.js`：无依赖 nft 风格命令解析和脚本分行。
- `src/commands.js`：命令应用、校验和逆操作生成。
- `src/transaction.js`：atomic/per-command/subtransaction 编排、失败分类和报告。
- `src/recovery.js`：逆序恢复和恢复结果校验。
- `test/`：`node:test` 测试。
- `examples/`：可直接运行的 JSON 输入。
