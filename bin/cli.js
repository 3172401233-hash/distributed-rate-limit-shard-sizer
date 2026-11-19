#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { plan } from '../src/planner.js';

const USAGE = [
  '用法: node bin/cli.js --input <config.json> [--pretty]',
  '       cat config.json | node bin/cli.js [--pretty]',
  '',
  '输入 JSON 字段:',
  '  windowMs           窗口长度（毫秒）',
  '  shards             [{ id, capacity }]            分片及每窗口容量',
  '  tenants            [{ id, qps, burst?, distribution?, currentBudget?, minQuota? }]',
  '  maxMigrationRatio  单次运行可迁移预算比例上限（可选，默认 0.25）',
  '  defaultMinQuota    低流量租户保底额度（可选，默认 10）',
  '',
  '输出: 分配表、迁移量、预计拒绝数、无法满足的租户。',
  '本工具只做容量规划，不实现具体的令牌桶存储。',
].join('\n');

async function readInput(args) {
  const idx = args.indexOf('--input');
  if (idx !== -1) {
    const file = args[idx + 1];
    if (!file) throw new Error('--input 需要文件路径');
    return readFile(file, 'utf8');
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  if (chunks.length === 0) throw new Error('缺少输入：使用 --input <file> 或通过 stdin 传入 JSON');
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const pretty = args.includes('--pretty');
  const raw = await readInput(args);
  const input = JSON.parse(raw);
  const report = plan(input);
  console.log(JSON.stringify(report, null, pretty ? 2 : 0));
}

main().catch((err) => {
  console.error(`shard-sizer: ${err.message}`);
  process.exitCode = 1;
});
