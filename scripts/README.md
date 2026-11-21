# Scripts de experimento e validação

Scripts em Node.js puro (Node 22+) usados na validação prática e no benchmark do Hub Colaborativo WebSocket. O endereço `wss://` é passado por argumento para nunca ficar versionado no Git.

## Benchmark de carga (T8)

Executa o protocolo T8 da [especificação](../docs/especificacao.md): conecta `N` usuários no mesmo grupo, faz uma rodada de aquecimento (R05) e depois envia 10 mensagens sequenciais por usuário em paralelo, medindo latência (média, p50, p95, p99), vazão e consistência de ordem (RNF02, RNF04, R06).

```sh
node scripts/load-test-t8.mjs "wss://<api-id>.execute-api.sa-east-1.amazonaws.com/dev" --users 10 --messages 10 --out docs/dados/t8-benchmark-10u.json
node scripts/load-test-t8.mjs --self-test
```

## Coleta de métricas do CloudWatch

Exporta as métricas do API Gateway WebSocket, das cinco Lambdas, das cinco tabelas DynamoDB e da métrica customizada `OpenConnections` em janelas de 1 minuto. Use `--sanitize` ao salvar dados para versionamento no Git.

```sh
node scripts/collect-cloudwatch-metrics.mjs --stage dev --start "2026-11-21T03:53:00Z" --end "2026-11-21T04:02:00Z" --sanitize --out docs/dados/cloudwatch-metrics-dev.json
node scripts/collect-cloudwatch-metrics.mjs --self-test
```

## Testes de integração no estágio dev (T3, T7, segurança e logs)

Valida isolamento de conversas, histórico, ordenação concorrente, reenvio idempotente, presença/recuperação após desconexão, recusa de conexões inválidas, autorização `forbidden` (RNF01) e logs anonimizados no CloudWatch (RNF03).

```sh
node scripts/integration-tests-dev.mjs "wss://<api-id>.execute-api.sa-east-1.amazonaws.com/dev" --sanitize --out docs/dados/integration-report-dev.json
node scripts/integration-tests-dev.mjs --self-test
```
