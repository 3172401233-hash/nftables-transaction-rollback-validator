#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { verifyTransaction } from '../src/index.js';

async function readInput() {
  const args = process.argv.slice(2);
  const inputFlag = args.findIndex((arg) => arg === '--input' || arg === '-i');
  const path = inputFlag >= 0
    ? args[inputFlag + 1]
    : args.find((arg) => !arg.startsWith('--') && arg.endsWith('.json'));
  if (path) return JSON.parse(await readFile(path, 'utf8'));
  if (process.stdin.isTTY) {
    process.stderr.write('Usage: nft-tx-verify <input.json> [--strict] or pipe JSON on stdin\n');
    process.exit(64);
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) {
    process.stderr.write('Usage: nft-tx-verify <input.json> or pipe JSON on stdin\n');
    process.exit(64);
  }
  return JSON.parse(text);
}

const strict = process.argv.includes('--strict');
const input = await readInput();
const report = verifyTransaction(input);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (strict && (!report.ok || report.uncertain)) process.exitCode = 1;
