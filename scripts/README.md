# Scripts de experimento e validação

Scripts em Node.js puro (Node 24+) usados na validação prática e no benchmark do Hub Colaborativo WebSocket. O endereço `wss://` é passado por argumento para nunca ficar versionado no Git.

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

## Testes de integração no estágio dev (T2, T3, T4, T5, T6, T7, segurança e logs)

Valida isolamento de conversas, limite 32 KB UTF-8 (RF11), pesquisa sem acento `pt-BR` (RF05), histórico > 128 KB paginado (RF06), presença multi-aba (T6), tratamento real de `410 Gone` (`GoneException`, T7.1), expiração real por inatividade no `presenceSweeper` (T7.2), reenvio idempotente (RF12), recusa de conexões inválidas (incluindo caracteres de controle/bidi), autorização `forbidden` (RNF01) e logs anonimizados no CloudWatch (`appLogs` e `presenceSweeperLogs`, RNF03).

```sh
node scripts/integration-tests-dev.mjs "wss://<api-id>.execute-api.sa-east-1.amazonaws.com/dev" --sanitize --out docs/dados/integration-report-dev.json
node scripts/integration-tests-dev.mjs --self-test
```

## Geração dos gráficos SVG do experimento T8

Gera os quatro gráficos SVG em `docs/imagens/` (`t8-latencia-por-carga.svg`, `t8-warmup-vs-medido.svg`, `t8-vazao-por-carga.svg` e `t8-consumo-dynamodb.svg`) diretamente a partir dos JSONs em `docs/dados/`, sem dependências externas.

```sh
python3 scripts/generate-charts.py
python3 scripts/generate-charts.py --self-test
```
