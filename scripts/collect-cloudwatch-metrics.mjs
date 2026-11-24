#!/usr/bin/env node
/**
 * Exports CloudWatch metrics from the HubWebSocket stack for a given time window:
 * - API Gateway WebSocket: ConnectCount, MessageCount, IntegrationLatency (avg/p95), IntegrationError, ClientError, ExecutionError
 * - Lambda (connect, disconnect, default, app, presenceSweeper): Invocations, Errors, Duration (avg/p95/max)
 * - DynamoDB (5 tables): ConsumedReadCapacityUnits, ConsumedWriteCapacityUnits, ThrottledRequests
 * - Custom namespace HubWebSocket/<stage>: OpenConnections
 *
 * Usage: node collect-cloudwatch-metrics.mjs --stage dev --start <ISO> --end <ISO> [--out metrics.json]
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}

const selfTest = process.argv.includes('--self-test');
const sanitize = process.argv.includes('--sanitize');

function mergeMetricResults(results) {
  const byId = new Map();
  for (const r of results ?? []) {
    const existing = byId.get(r.Id);
    if (!existing) {
      byId.set(r.Id, {
        ...r,
        Timestamps: [...(r.Timestamps ?? [])],
        Values: [...(r.Values ?? [])],
      });
    } else {
      existing.Timestamps.push(...(r.Timestamps ?? []));
      existing.Values.push(...(r.Values ?? []));
    }
  }
  return [...byId.values()];
}

function summarizeMetricResult(r, stat = 'Sum') {
  const values = r.Values ?? [];
  const total = values.reduce((a, b) => a + b, 0);
  const avg = values.length ? total / values.length : null;
  const max = values.length ? Math.max(...values) : null;
  return {
    id: r.Id,
    label: r.Label,
    stat,
    datapoints: values.length,
    // Sum is only meaningful for additive Sum metrics, not Average/p95/Maximum stats.
    sum: stat === 'Sum' ? Number(total.toFixed(2)) : null,
    avg: avg !== null ? Number(avg.toFixed(2)) : null,
    max: max !== null ? Number(max.toFixed(2)) : null,
    timestamps: r.Timestamps ?? [],
    values,
  };
}

if (selfTest) {
  const s = summarizeMetricResult({ Id: 'x', Label: 'Test', Values: [10, 20, 30], Timestamps: ['t1', 't2', 't3'] });
  const a = summarizeMetricResult(
    { Id: 'y', Label: 'Latency', Values: [100, 200], Timestamps: ['t1', 't2'] },
    'Average',
  );
  const emptyAvg = summarizeMetricResult({ Id: 'z', Label: 'Empty', Values: [], Timestamps: [] }, 'p95');
  const merged = mergeMetricResults([
    { Id: 'm', Label: 'Paged', Timestamps: ['t2'], Values: [2] },
    { Id: 'm', Label: 'Paged', Timestamps: ['t1'], Values: [1] },
  ]);
  if (
    s.stat !== 'Sum' ||
    s.datapoints !== 3 ||
    s.sum !== 60 ||
    s.avg !== 20 ||
    s.max !== 30 ||
    a.stat !== 'Average' ||
    a.sum !== null ||
    a.avg !== 150 ||
    a.max !== 200 ||
    emptyAvg.sum !== null ||
    emptyAvg.avg !== null ||
    merged.length !== 1 ||
    merged[0].Values.length !== 2
  ) {
    console.error('Self-test failed:', { s, a, emptyAvg, merged });
    process.exit(1);
  }
  console.log('Self-test passed:', { sumExample: s, avgExample: a });
  process.exit(0);
}

const stage = arg('stage', 'dev');
const region = arg('region', 'sa-east-1');
const stackName = `HubWebSocket-${stage}`;
const endIso = arg('end', new Date().toISOString());
const endMs = Date.parse(endIso);
if (Number.isNaN(endMs)) {
  console.error(`Invalid --end timestamp: ${endIso}`);
  process.exit(1);
}
const startIso = arg('start', new Date(endMs - 15 * 60 * 1000).toISOString());
const startMs = Date.parse(startIso);
if (Number.isNaN(startMs) || startMs >= endMs) {
  console.error(`Invalid time window: start=${startIso}, end=${endIso}`);
  process.exit(1);
}
const outPath = arg('out', undefined);

function awsJson(args) {
  const out = execFileSync('aws', ['--region', region, ...args, '--output', 'json'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(out);
}

const resources = awsJson(['cloudformation', 'list-stack-resources', '--stack-name', stackName])
  .StackResourceSummaries;

const apiId = resources.find((r) => r.ResourceType === 'AWS::ApiGatewayV2::Api')?.PhysicalResourceId;
const lambdas = resources
  .filter((r) => r.ResourceType === 'AWS::Lambda::Function' && !r.LogicalResourceId.startsWith('Custom'))
  .filter((r) => !r.LogicalResourceId.includes('CustomResource') && !r.LogicalResourceId.includes('S3AutoDelete'))
  .map((r) => ({ logical: r.LogicalResourceId, physical: r.PhysicalResourceId }));
const tables = resources
  .filter((r) => r.ResourceType === 'AWS::DynamoDB::Table')
  .map((r) => ({ logical: r.LogicalResourceId, physical: r.PhysicalResourceId }));

const windowPeriod = Math.max(60, Math.ceil((endMs - startMs) / 60_000) * 60);

const queries = [];
const add = (id, label, namespace, metricName, dimensions, stat, period = 60) => {
  queries.push({
    Id: id,
    Label: label,
    MetricStat: {
      Metric: { Namespace: namespace, MetricName: metricName, Dimensions: dimensions },
      Period: period,
      Stat: stat,
    },
  });
};

if (apiId) {
  const apiDims = [
    { Name: 'ApiId', Value: apiId },
    { Name: 'Stage', Value: stage },
  ];
  add('apigw_connect', 'APIGW ConnectCount', 'AWS/ApiGateway', 'ConnectCount', apiDims, 'Sum');
  add('apigw_messages', 'APIGW MessageCount', 'AWS/ApiGateway', 'MessageCount', apiDims, 'Sum');
  add('apigw_lat_avg', 'APIGW IntegrationLatency avg', 'AWS/ApiGateway', 'IntegrationLatency', apiDims, 'Average');
  add('apigw_lat_p95', 'APIGW IntegrationLatency p95', 'AWS/ApiGateway', 'IntegrationLatency', apiDims, 'p95');
  add(
    'apigw_lat_avg_win',
    'APIGW IntegrationLatency avg (window)',
    'AWS/ApiGateway',
    'IntegrationLatency',
    apiDims,
    'Average',
    windowPeriod,
  );
  add(
    'apigw_lat_p95_win',
    'APIGW IntegrationLatency p95 (window)',
    'AWS/ApiGateway',
    'IntegrationLatency',
    apiDims,
    'p95',
    windowPeriod,
  );
  add('apigw_err_int', 'APIGW IntegrationError', 'AWS/ApiGateway', 'IntegrationError', apiDims, 'Sum');
  add('apigw_err_cli', 'APIGW ClientError', 'AWS/ApiGateway', 'ClientError', apiDims, 'Sum');
  add('apigw_err_exe', 'APIGW ExecutionError', 'AWS/ApiGateway', 'ExecutionError', apiDims, 'Sum');
}

add('custom_open_conn', 'OpenConnections', `HubWebSocket/${stage}`, 'OpenConnections', [], 'Maximum');

lambdas.forEach((fn, idx) => {
  const dims = [{ Name: 'FunctionName', Value: fn.physical }];
  const short = fn.logical.replace(/[A-F0-9]{8}$/, '');
  add(`fn_${idx}_inv`, `Lambda ${short} Invocations`, 'AWS/Lambda', 'Invocations', dims, 'Sum');
  add(`fn_${idx}_err`, `Lambda ${short} Errors`, 'AWS/Lambda', 'Errors', dims, 'Sum');
  add(`fn_${idx}_thr`, `Lambda ${short} Throttles`, 'AWS/Lambda', 'Throttles', dims, 'Sum');
  add(`fn_${idx}_dur_avg`, `Lambda ${short} Duration avg`, 'AWS/Lambda', 'Duration', dims, 'Average');
  add(`fn_${idx}_dur_p95`, `Lambda ${short} Duration p95`, 'AWS/Lambda', 'Duration', dims, 'p95');
  add(`fn_${idx}_dur_max`, `Lambda ${short} Duration max`, 'AWS/Lambda', 'Duration', dims, 'Maximum');
  add(
    `fn_${idx}_dur_avg_win`,
    `Lambda ${short} Duration avg (window)`,
    'AWS/Lambda',
    'Duration',
    dims,
    'Average',
    windowPeriod,
  );
  add(
    `fn_${idx}_dur_p95_win`,
    `Lambda ${short} Duration p95 (window)`,
    'AWS/Lambda',
    'Duration',
    dims,
    'p95',
    windowPeriod,
  );
});

tables.forEach((tbl, idx) => {
  const dims = [{ Name: 'TableName', Value: tbl.physical }];
  const short = tbl.logical.replace(/[A-F0-9]{8}$/, '');
  add(`ddb_${idx}_rcu`, `DynamoDB ${short} RCU`, 'AWS/DynamoDB', 'ConsumedReadCapacityUnits', dims, 'Sum');
  add(`ddb_${idx}_wcu`, `DynamoDB ${short} WCU`, 'AWS/DynamoDB', 'ConsumedWriteCapacityUnits', dims, 'Sum');
  add(`ddb_${idx}_thr`, `DynamoDB ${short} Throttled`, 'AWS/DynamoDB', 'ThrottledRequests', dims, 'Sum');
});

const response = awsJson([
  'cloudwatch',
  'get-metric-data',
  '--start-time',
  startIso,
  '--end-time',
  endIso,
  '--metric-data-queries',
  JSON.stringify(queries),
]);

const statById = new Map(queries.map((q) => [q.Id, q.MetricStat.Stat]));
const summary = mergeMetricResults(response.MetricDataResults).map((r) =>
  summarizeMetricResult(r, statById.get(r.Id)),
);

const report = {
  stackName,
  region,
  apiId: sanitize ? '<api-id>' : apiId,
  startTime: startIso,
  endTime: endIso,
  lambdas: sanitize ? lambdas.map(({ logical }) => ({ logical })) : lambdas,
  tables: sanitize ? tables.map(({ logical }) => ({ logical })) : tables,
  metrics: summary,
};

if (outPath) {
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Saved CloudWatch metrics to ${outPath}`);
} else {
  console.log(JSON.stringify(report, null, 2));
}
