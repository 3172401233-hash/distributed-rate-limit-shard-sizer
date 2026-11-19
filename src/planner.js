const EPSILON = 1e-9;

export const DEFAULTS = Object.freeze({
  // 单次运行中，某租户最多可迁移其总预算的比例（渐进式调整）
  maxMigrationRatio: 0.25,
  // 低流量租户保底额度（令牌/窗口），租户可用 minQuota 覆盖
  defaultMinQuota: 10,
});

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function assertValidInput(input) {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('input must be an object');
  }
  if (!isFiniteNumber(input.windowMs) || input.windowMs <= 0) {
    throw new RangeError('windowMs must be a positive number');
  }
  if (!Array.isArray(input.shards) || input.shards.length === 0) {
    throw new TypeError('shards must be a non-empty array');
  }
  if (!Array.isArray(input.tenants) || input.tenants.length === 0) {
    throw new TypeError('tenants must be a non-empty array');
  }
  const seenShards = new Set();
  for (const shard of input.shards) {
    if (typeof shard.id !== 'string' || shard.id.length === 0) {
      throw new TypeError('each shard needs a non-empty string id');
    }
    if (seenShards.has(shard.id)) {
      throw new Error(`duplicate shard id: ${shard.id}`);
    }
    seenShards.add(shard.id);
    if (!isFiniteNumber(shard.capacity) || shard.capacity < 0) {
      throw new RangeError(`shard ${shard.id}: capacity must be a non-negative number`);
    }
  }
  const seenTenants = new Set();
  for (const tenant of input.tenants) {
    if (typeof tenant.id !== 'string' || tenant.id.length === 0) {
      throw new TypeError('each tenant needs a non-empty string id');
    }
    if (seenTenants.has(tenant.id)) {
      throw new Error(`duplicate tenant id: ${tenant.id}`);
    }
    seenTenants.add(tenant.id);
    if (!isFiniteNumber(tenant.qps) || tenant.qps < 0) {
      throw new RangeError(`tenant ${tenant.id}: qps must be a non-negative number`);
    }
    if (tenant.burst !== undefined && (!isFiniteNumber(tenant.burst) || tenant.burst < 0)) {
      throw new RangeError(`tenant ${tenant.id}: burst must be a non-negative number`);
    }
  }
}

// 把租户请求分布归一化到当前存活的 shard 集合上：
// 分片故障/摘除时其权重按比例迁移到剩余分片，新增分片默认权重为 0。
function normalizeDistribution(tenant, shardIds) {
  const raw = tenant.distribution ?? {};
  const weights = new Map();
  let sum = 0;
  for (const id of shardIds) {
    const w = raw[id];
    if (w !== undefined && (!isFiniteNumber(w) || w < 0)) {
      throw new RangeError(`tenant ${tenant.id}: distribution[${id}] must be a non-negative number`);
    }
    const weight = w ?? 0;
    weights.set(id, weight);
    sum += weight;
  }
  if (sum <= EPSILON) {
    const even = 1 / shardIds.length;
    for (const id of shardIds) weights.set(id, even);
    return weights;
  }
  for (const id of shardIds) weights.set(id, weights.get(id) / sum);
  return weights;
}

// 单分片内的保底 + 比例注水分配。
// entries: [{ key, demand, floor }]，返回 Map key -> 目标配额（不超过 demand，总和不超过 capacity）。
function allocateShard(entries, capacity) {
  const alloc = new Map();
  if (entries.length === 0 || capacity <= 0) {
    for (const e of entries) alloc.set(e.key, 0);
    return alloc;
  }
  // 保底层：低流量租户优先拿到 floor；保底总量超容量时按比例压缩
  let floorSum = 0;
  for (const e of entries) floorSum += Math.min(e.floor, e.demand);
  const floorScale = floorSum > capacity ? capacity / floorSum : 1;
  let remaining = capacity;
  for (const e of entries) {
    const grant = Math.min(e.floor, e.demand) * floorScale;
    alloc.set(e.key, grant);
    remaining -= grant;
  }
  // 注水位：按剩余需求比例分配剩余容量，超限者退出后迭代
  let active = entries.filter((e) => e.demand > alloc.get(e.key) + EPSILON);
  while (remaining > EPSILON && active.length > 0) {
    let totalNeed = 0;
    for (const e of active) totalNeed += e.demand - alloc.get(e.key);
    if (totalNeed <= remaining + EPSILON) {
      for (const e of active) alloc.set(e.key, e.demand);
      remaining -= totalNeed;
      break;
    }
    const nextActive = [];
    let spent = 0;
    for (const e of active) {
      const need = e.demand - alloc.get(e.key);
      const share = (remaining * need) / totalNeed;
      const grant = Math.min(need, share);
      alloc.set(e.key, alloc.get(e.key) + grant);
      spent += grant;
      if (e.demand > alloc.get(e.key) + EPSILON) nextActive.push(e);
    }
    remaining -= spent;
    if (nextActive.length === active.length) break; // 数值收敛保护
    active = nextActive;
  }
  return alloc;
}

/**
 * 重新计算每个分片、每个租户的令牌配额。
 *
 * @param {object} input
 * @param {number} input.windowMs 窗口长度（毫秒）
 * @param {Array<{id:string, capacity:number}>} input.shards 分片及其每窗口容量
 * @param {Array<object>} input.tenants 租户列表：
 *   - id: 租户标识
 *   - qps: 租户请求速率
 *   - burst: 突发额度（令牌/窗口，可选，默认 0）
 *   - distribution: { shardId: 权重 } 请求分布（可选，缺省均匀分布）
 *   - currentBudget: { shardId: 令牌数 } 当前各分片预算（可选，缺省 0）
 *   - minQuota: 保底额度（可选，默认 DEFAULTS.defaultMinQuota）
 * @param {object} [options]
 * @param {number} [options.maxMigrationRatio] 单次运行可迁移预算占租户总预算的上限
 * @returns {object} 分配报告
 */
export function plan(input, options = {}) {
  assertValidInput(input);
  const maxMigrationRatio =
    options.maxMigrationRatio ?? input.maxMigrationRatio ?? DEFAULTS.maxMigrationRatio;
  if (!isFiniteNumber(maxMigrationRatio) || maxMigrationRatio <= 0 || maxMigrationRatio > 1) {
    throw new RangeError('maxMigrationRatio must be in (0, 1]');
  }
  const defaultMinQuota = input.defaultMinQuota ?? DEFAULTS.defaultMinQuota;

  const windowSec = input.windowMs / 1000;
  const shardIds = input.shards.map((s) => s.id);
  const capacityOf = new Map(input.shards.map((s) => [s.id, s.capacity]));

  // 1) 计算每个租户的总预算（守恒上限）与归一化分布
  const tenants = input.tenants.map((t) => {
    const totalBudget = t.qps * windowSec + (t.burst ?? 0);
    const distribution = normalizeDistribution(t, shardIds);
    const floor = Math.min(totalBudget, t.minQuota ?? defaultMinQuota);
    const current = new Map();
    for (const id of shardIds) {
      const cur = t.currentBudget?.[id];
      if (cur !== undefined && (!isFiniteNumber(cur) || cur < 0)) {
        throw new RangeError(`tenant ${t.id}: currentBudget[${id}] must be a non-negative number`);
      }
      current.set(id, cur ?? 0);
    }
    // 已被摘除的分片上残留的当前预算：必须迁出（计入迁移量，不进入新分配）
    let orphanedBudget = 0;
    for (const [id, cur] of Object.entries(t.currentBudget ?? {})) {
      if (!capacityOf.has(id) && isFiniteNumber(cur) && cur > 0) orphanedBudget += cur;
    }
    return { id: t.id, totalBudget, distribution, floor, current, orphanedBudget };
  });

  // 2) 稳态目标：每个分片内做保底 + 注水位分配
  //    目标天然满足守恒：sum_s target[t][s] <= sum_s demand[t][s] == totalBudget[t]
  const target = new Map(); // tenantId -> Map(shardId -> tokens)
  for (const t of tenants) target.set(t.id, new Map());
  for (const shardId of shardIds) {
    const entries = tenants.map((t) => ({
      key: t.id,
      demand: t.totalBudget * t.distribution.get(shardId),
      floor: t.floor * t.distribution.get(shardId),
    }));
    const alloc = allocateShard(entries, capacityOf.get(shardId));
    for (const t of tenants) target.get(t.id).set(shardId, alloc.get(t.id) ?? 0);
  }

  // 3) 渐进式调整：单次运行每个租户跨所有分片的迁入/迁出总量都不超过
  //    maxMigrationRatio * totalBudget，避免热点迁移/扩缩容时租户瞬时超额
  const allocation = new Map(); // tenantId -> Map(shardId -> tokens)
  const migrations = [];
  let totalMigrated = 0;
  for (const t of tenants) {
    const step = maxMigrationRatio * t.totalBudget;
    const tenantAlloc = new Map();
    const perShardDelta = {};
    const deltas = new Map();
    let sumUp = 0;
    let sumDown = 0;
    for (const shardId of shardIds) {
      const delta = target.get(t.id).get(shardId) - t.current.get(shardId);
      deltas.set(shardId, delta);
      if (delta > 0) sumUp += delta;
      else sumDown -= delta;
    }
    const upScale = sumUp > step ? step / sumUp : 1;
    const downScale = sumDown > step ? step / sumDown : 1;
    for (const shardId of shardIds) {
      const cur = t.current.get(shardId);
      const delta = deltas.get(shardId);
      const next = Math.max(0, cur + delta * (delta > 0 ? upScale : downScale));
      tenantAlloc.set(shardId, next);
      const applied = next - cur;
      if (Math.abs(applied) > EPSILON) {
        perShardDelta[shardId] = round(applied);
        // 迁移量按实际搬移的令牌数计：正向增量之和（负向是同一批令牌的迁出侧）
        if (applied > 0) totalMigrated += applied;
      }
    }
    if (t.orphanedBudget > EPSILON) {
      perShardDelta.__orphaned__ = round(-t.orphanedBudget);
      totalMigrated += t.orphanedBudget;
    }
    allocation.set(t.id, tenantAlloc);
    if (Object.keys(perShardDelta).length > 0) {
      migrations.push({ tenantId: t.id, deltas: perShardDelta });
    }
  }

  // 4) 汇总：分配表、预计拒绝数、无法满足的租户
  const allocationTable = {};
  const estimatedRejections = {};
  const unsatisfiable = [];
  let totalRejected = 0;
  for (const t of tenants) {
    const row = {};
    let allocSum = 0;
    let rejected = 0;
    for (const shardId of shardIds) {
      const tokens = Math.floor(allocation.get(t.id).get(shardId) + EPSILON);
      row[shardId] = tokens;
      allocSum += tokens;
      const demand = t.totalBudget * t.distribution.get(shardId);
      rejected += Math.max(0, demand - tokens);
    }
    allocationTable[t.id] = { shards: row, total: allocSum, budget: Math.floor(t.totalBudget + EPSILON) };
    estimatedRejections[t.id] = Math.round(rejected);
    totalRejected += rejected;
    // 无法满足：稳态目标仍低于总预算（容量不足），而非渐进调整未到位
    let targetSum = 0;
    for (const shardId of shardIds) targetSum += target.get(t.id).get(shardId);
    if (targetSum < t.totalBudget - EPSILON) {
      unsatisfiable.push({
        tenantId: t.id,
        budget: Math.floor(t.totalBudget + EPSILON),
        attainable: Math.floor(targetSum + EPSILON),
        deficit: Math.ceil(t.totalBudget - targetSum - EPSILON),
        reason: 'insufficient shard capacity',
      });
    }
  }

  const shardUsage = {};
  for (const shardId of shardIds) {
    let used = 0;
    for (const t of tenants) used += allocation.get(t.id).get(shardId);
    shardUsage[shardId] = {
      capacity: capacityOf.get(shardId),
      allocated: Math.floor(used + EPSILON),
    };
  }

  return {
    windowMs: input.windowMs,
    maxMigrationRatio,
    allocation: allocationTable,
    shardUsage,
    migrations,
    totalMigrated: round(totalMigrated),
    estimatedRejections,
    totalEstimatedRejections: Math.round(totalRejected),
    unsatisfiableTenants: unsatisfiable,
  };
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}
