import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, DEFAULTS } from '../src/planner.js';

// 把上一次输出的分配表回填为 currentBudget，模拟周期性重规划
function feedback(input, report) {
  return {
    ...input,
    tenants: input.tenants.map((t) => ({
      ...t,
      currentBudget: report.allocation[t.id].shards,
    })),
  };
}

function runUntilStable(input, maxRounds = 50) {
  let current = input;
  let report = plan(current);
  for (let i = 0; i < maxRounds; i += 1) {
    const next = feedback(current, report);
    const nextReport = plan(next);
    if (nextReport.totalMigrated === 0) return { report: nextReport, rounds: i + 1 };
    current = next;
    report = nextReport;
  }
  throw new Error('did not converge');
}

function assertConservation(input, report) {
  for (const t of input.tenants) {
    const row = report.allocation[t.id];
    const budget = t.qps * (input.windowMs / 1000) + (t.burst ?? 0);
    assert.ok(
      row.total <= Math.ceil(budget) + 1e-9,
      `tenant ${t.id} total ${row.total} exceeds budget ${budget}`,
    );
  }
  for (const s of input.shards) {
    const usage = report.shardUsage[s.id];
    assert.ok(
      usage.allocated <= usage.capacity,
      `shard ${s.id} allocated ${usage.allocated} exceeds capacity ${usage.capacity}`,
    );
  }
}

test('均匀流量：容量充足时每个租户拿满需求，零拒绝', () => {
  const input = {
    windowMs: 1000,
    shards: [
      { id: 's1', capacity: 1000 },
      { id: 's2', capacity: 1000 },
    ],
    tenants: [
      { id: 'a', qps: 100, distribution: { s1: 0.5, s2: 0.5 } },
      { id: 'b', qps: 200, distribution: { s1: 0.5, s2: 0.5 } },
    ],
    maxMigrationRatio: 1,
  };
  const report = plan(input);
  assert.equal(report.allocation.a.total, 100);
  assert.equal(report.allocation.b.total, 200);
  assert.equal(report.totalEstimatedRejections, 0);
  assert.deepEqual(report.unsatisfiableTenants, []);
  assertConservation(input, report);
});

test('单分片热点：热点分片打满产生拒绝，低流量租户保底不受影响', () => {
  const input = {
    windowMs: 1000,
    shards: [
      { id: 'hot', capacity: 500 },
      { id: 'idle', capacity: 5000 },
    ],
    tenants: [
      { id: 'heavy', qps: 2000, distribution: { hot: 0.9, idle: 0.1 } },
      { id: 'tiny', qps: 5, distribution: { hot: 1 } },
    ],
    maxMigrationRatio: 1,
  };
  const report = plan(input);
  // 热点分片不超容量
  assert.ok(report.shardUsage.hot.allocated <= 500);
  // 低流量租户保底：需求全部满足
  assert.equal(report.allocation.tiny.shards.hot, 5);
  assert.equal(report.estimatedRejections.tiny, 0);
  // 高流量租户在热点分片被拒绝，且无法通过抢占突破总额
  assert.ok(report.estimatedRejections.heavy > 0);
  assert.ok(report.allocation.heavy.total <= 2000);
  assert.deepEqual(report.unsatisfiableTenants.map((u) => u.tenantId), ['heavy']);
  assertConservation(input, report);
});

test('高流量租户不能通过并发抢占多个分片超额', () => {
  const input = {
    windowMs: 1000,
    shards: [
      { id: 's1', capacity: 100000 },
      { id: 's2', capacity: 100000 },
      { id: 's3', capacity: 100000 },
    ],
    tenants: [
      { id: 'greedy', qps: 300, distribution: { s1: 1, s2: 1, s3: 1 } },
      { id: 'normal', qps: 60 },
    ],
    maxMigrationRatio: 1,
  };
  const report = plan(input);
  // 分布在多个分片上归一化后，总量仍守恒
  assert.ok(report.allocation.greedy.total <= 300);
  assert.equal(report.allocation.normal.total, 60);
  assertConservation(input, report);
});

test('租户突发：突发额度提升预算，渐进迁移逐步到位并收敛', () => {
  const base = {
    windowMs: 1000,
    shards: [
      { id: 's1', capacity: 10000 },
      { id: 's2', capacity: 10000 },
    ],
    tenants: [{ id: 'bursty', qps: 1000, distribution: { s1: 0.5, s2: 0.5 } }],
    maxMigrationRatio: 0.25,
  };
  const { report: before } = runUntilStable(base);
  assert.equal(before.allocation.bursty.total, 1000);
  // 突发：追加 4000 突发额度
  const spiked = {
    ...base,
    tenants: [{ ...base.tenants[0], burst: 4000, currentBudget: before.allocation.bursty.shards }],
  };
  const firstStep = plan(spiked);
  // 渐进式：单步最多迁移 25% * 5000 = 1250
  assert.ok(firstStep.allocation.bursty.total <= 1000 + 1250);
  assert.ok(firstStep.totalMigrated > 0);
  // 多轮后收敛到新的稳态
  const { report: stable } = runUntilStable(spiked);
  assert.equal(stable.allocation.bursty.total, 5000);
  assert.equal(stable.totalEstimatedRejections, 0);
  assertConservation(spiked, stable);
});

test('分片增删：故障分片预算迁出，新分片逐步吸收容量且全程守恒', () => {
  const three = {
    windowMs: 1000,
    shards: [
      { id: 's1', capacity: 1000 },
      { id: 's2', capacity: 1000 },
      { id: 's3', capacity: 1000 },
    ],
    tenants: [{ id: 't', qps: 900, distribution: { s1: 1 / 3, s2: 1 / 3, s3: 1 / 3 } }],
    maxMigrationRatio: 0.5,
  };
  const { report: stableThree } = runUntilStable(three);
  assert.equal(stableThree.allocation.t.total, 900);

  // s3 故障摘除：分布权重归一化到 s1/s2，s3 上残留预算计入迁移
  const afterFailure = {
    ...three,
    shards: [
      { id: 's1', capacity: 1000 },
      { id: 's2', capacity: 1000 },
    ],
    tenants: [{ ...three.tenants[0], currentBudget: stableThree.allocation.t.shards }],
  };
  const failureStep = plan(afterFailure);
  const migration = failureStep.migrations.find((m) => m.tenantId === 't');
  assert.equal(migration.deltas.__orphaned__, -300);
  assertConservation(afterFailure, failureStep);
  const { report: stableTwo } = runUntilStable(afterFailure);
  assert.equal(stableTwo.allocation.t.total, 900);
  assert.equal(stableTwo.allocation.t.shards.s3, undefined);

  // 扩容新增 s4：预算渐进迁移到新分片
  const afterScale = {
    ...three,
    shards: [
      { id: 's1', capacity: 1000 },
      { id: 's2', capacity: 1000 },
      { id: 's4', capacity: 1000 },
    ],
    tenants: [
      {
        ...three.tenants[0],
        distribution: { s1: 0.2, s2: 0.2, s4: 0.6 },
        currentBudget: stableTwo.allocation.t.shards,
      },
    ],
  };
  const scaleStep = plan(afterScale);
  assert.ok(scaleStep.totalMigrated > 0);
  assert.ok(scaleStep.totalMigrated <= 0.5 * 900 + 1e-9);
  assertConservation(afterScale, scaleStep);
  const { report: stableScale } = runUntilStable(afterScale);
  assert.equal(stableScale.allocation.t.total, 900);
  assert.equal(stableScale.allocation.t.shards.s4, 540);
});

test('预算守恒：超额订阅场景下租户总额与分片容量均不越界', () => {
  const input = {
    windowMs: 2000,
    shards: [
      { id: 's1', capacity: 300 },
      { id: 's2', capacity: 200 },
    ],
    tenants: [
      { id: 't1', qps: 400, burst: 100, distribution: { s1: 0.7, s2: 0.3 } },
      { id: 't2', qps: 300, distribution: { s1: 0.4, s2: 0.6 } },
      { id: 't3', qps: 50, minQuota: 20 },
    ],
    maxMigrationRatio: 1,
  };
  const report = plan(input);
  assertConservation(input, report);
  // 总需求 900+600+100 = 1600 令牌远超 500 容量，必有人被拒绝
  assert.ok(report.totalEstimatedRejections > 0);
  // 低流量租户 t3 保底 20
  assert.ok(report.allocation.t3.total >= 20);
  assert.ok(report.unsatisfiableTenants.length > 0);
});

test('重复执行：输出回填后收敛到不动点，迁移量归零', () => {
  const input = {
    windowMs: 1000,
    shards: [
      { id: 's1', capacity: 800 },
      { id: 's2', capacity: 800 },
    ],
    tenants: [
      { id: 'a', qps: 500, burst: 50, distribution: { s1: 0.8, s2: 0.2 } },
      { id: 'b', qps: 300, distribution: { s1: 0.3, s2: 0.7 } },
    ],
    maxMigrationRatio: 0.25,
  };
  const { report: stable, rounds } = runUntilStable(input);
  assert.ok(rounds > 1, '渐进调整需要多轮');
  // 不动点：再跑一次分配完全不变
  const again = plan(feedback(input, stable));
  assert.equal(again.totalMigrated, 0);
  assert.deepEqual(again.allocation, stable.allocation);
  assertConservation(input, again);
});

test('默认值与输入校验', () => {
  assert.equal(DEFAULTS.maxMigrationRatio, 0.25);
  assert.throws(() => plan(null), TypeError);
  assert.throws(() => plan({ windowMs: 0, shards: [{}], tenants: [{}] }), RangeError);
  assert.throws(
    () =>
      plan({
        windowMs: 1000,
        shards: [{ id: 's1', capacity: -1 }],
        tenants: [{ id: 't', qps: 1 }],
      }),
    RangeError,
  );
  assert.throws(
    () =>
      plan({
        windowMs: 1000,
        shards: [{ id: 's1', capacity: 1 }, { id: 's1', capacity: 1 }],
        tenants: [{ id: 't', qps: 1 }],
      }),
    /duplicate shard id/,
  );
});
