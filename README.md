# distributed-rate-limit-shard-sizer

在限流分片漂移和突发流量下重分配全局令牌预算的容量规划器（Node.js 24.16.0）。

## 背景

分布式限流把全局配额拆到多个分片后，热点会把部分分片打满，其他分片却空闲；
频繁搬移预算又会造成租户短时间超额。本工具根据租户 QPS、分片请求分布、当前预算、
突发额度、窗口长度和分片容量，重新计算每个分片、每个租户可分到的令牌数。

## 使用

```bash
node bin/cli.js --input examples/hotspot.json --pretty
cat config.json | node bin/cli.js
```

也可以作为库调用：

```js
import { plan } from './src/planner.js';
const report = plan(input);
```

## 输入

| 字段 | 说明 |
| --- | --- |
| `windowMs` | 窗口长度（毫秒） |
| `shards` | `[{ id, capacity }]`，分片及每窗口容量 |
| `tenants[].qps` | 租户请求速率 |
| `tenants[].burst` | 突发额度（令牌/窗口，可选） |
| `tenants[].distribution` | `{ shardId: 权重 }` 请求分布（可选，缺省均匀） |
| `tenants[].currentBudget` | `{ shardId: 令牌数 }` 当前各分片预算（可选） |
| `tenants[].minQuota` | 低流量租户保底额度（可选，默认 10） |
| `maxMigrationRatio` | 单次运行可迁移预算占租户总预算的上限（可选，默认 0.25） |

租户总预算 = `qps * windowMs / 1000 + burst`。

## 输出

- `allocation`：分配表（每租户每分片令牌数、合计与预算上限）
- `shardUsage`：每个分片已分配量与容量
- `migrations` / `totalMigrated`：每租户每分片的迁移量与总迁移量
- `estimatedRejections`：按当前窗口需求预计的拒绝数
- `unsatisfiableTenants`：稳态下仍无法满足的租户（容量不足）及缺口

## 设计要点

- **容量守恒**：同一租户跨分片累计配额永远不超过其总预算；每个分片分配总量不超过容量。
- **渐进式调整**：热点迁移、分片故障、实例扩缩容时，单次运行每个租户跨所有分片的
  迁入/迁出总量不超过 `maxMigrationRatio * 总预算`，避免租户短时间超额；
  将输出回填为 `currentBudget` 周期性执行即可收敛到稳态。
- **保底与公平**：分片内先满足各租户保底额度（低流量租户保留可用额度），
  剩余容量按需求比例注水分配；高流量租户无法通过并发抢占多个分片突破总预算。
- **分片增删**：摘除的分片权重按比例归一化到存活分片，残留预算计入迁移量；
  新增分片从 0 开始渐进吸收预算。

## 边界说明

本工具只做**容量规划**：输出每个分片、每个租户应分配的令牌预算，
不实现具体的令牌桶存储、请求计数或分布式一致性协议。
实际系统中由接入层/限流代理按本工具的输出配置各自的令牌桶。

## 测试

```bash
node --test
```

覆盖均匀流量、单分片热点、租户突发、分片增删、预算守恒和重复执行（收敛不动点）。
