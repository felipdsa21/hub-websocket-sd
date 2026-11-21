# Métricas de infraestrutura coletadas na AWS

**Projeto:** Hub Colaborativo WebSocket  
**Estágio / Região:** `HubWebSocket-dev` / `sa-east-1`  
**Janela coletada:** `2026-11-21T03:53:00Z` a `2026-11-21T04:02:00Z` (cobrindo os testes de integração e as cargas de 2, 5 e 10 usuários simultâneos)  
**Dados brutos:** [docs/dados/cloudwatch-metrics-dev.json](dados/cloudwatch-metrics-dev.json)

## 1. API Gateway WebSocket e conexões

| Métrica | Soma na janela | Média/min | Pico (máx/min) | Observação |
| --- | ---: | ---: | ---: | --- |
| `ConnectCount` | 41 | 10,25 | 20 | Conexões dos testes de integração e benchmarks (2, 5 e 10 usuários) |
| `MessageCount` | 1.915 | 383,00 | 1.278 | Soma de requisições de entrada + fan-out via `@connections` |
| `OpenConnections` (custom) | — | 5,80 | 9 | Publicada pelo `presenceSweeper` (`HubWebSocket/dev`) |
| `IntegrationLatency` (avg) | — | 759,66 ms | 2.362,40 ms | Inclui cold starts iniciais (`Init Duration` ~300–380 ms) |
| `IntegrationLatency` (p95) | — | 1.379,46 ms | 3.637,42 ms | Pico durante rajada inicial fria de 10 usuários |
| `IntegrationError` | 0 | 0 | 0 | Nenhum erro de integração com a Lambda |
| `ClientError` | 41 | 8,20 | 17 | Recusas intencionais dos testes de segurança (`$connect` 400 e `$default`) |
| `ExecutionError` | 8 | 1,60 | 8 | Throttling por cota `ConcurrentExecutions = 10` da conta nova, recuperado por RF12 |

> **Nota sobre médias de janela:** para métricas de contagem (`ConnectCount`, `MessageCount`, `ClientError`, `ExecutionError`), `Média/min` representa a média entre os minutos com datapoints no CloudWatch (`4` ou `5` minutos ativos dentro da janela de 9 minutos). Para `IntegrationLatency` e `OpenConnections`, a coluna mostra a média simples das janelas de 1 minuto (ponderada por `MessageCount`, a `IntegrationLatency` média global nas `1.915` entregas foi de `455,81 ms`, já que o minuto de cold start `00:53` teve apenas `27` mensagens a `2.362,40 ms` e o minuto de pico `00:56` teve `1.278` mensagens a `475,38 ms`).

## 2. Funções Lambda

Todas as funções rodaram com memória padrão de `128 MB` (`Node.js 22.x`) e **zero erros de execução** (`Errors = 0`).

| Função | Invocações | Erros | Duração média (ms) | Duração p95 (ms) | Duração máx (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| `app` | 183 | 0 | 326,15 | 687,16 | 2.130,56 |
| `connect` | 37 | 0 | 392,07 | 618,07 | 918,06 |
| `disconnect` | 20 | 0 | 655,36 | 1.158,16 | 2.193,81 |
| `default` | 4 | 0 | 386,81 | 674,32 | 1.236,22 |
| `presenceSweeper` | 5 | 0 | 30.141,72 | 30.141,72 | 30.159,04 |

Os valores de `Duração média` e `Duração p95` na tabela correspondem à média simples das séries de 1 minuto exportadas pelo CloudWatch (sem ponderação pelo volume de invocações por minuto; ponderada por invocações, a duração média de `app` foi de `393,82 ms`, com pico de p95 em 1 minuto de `1.011,83 ms`). A duração estável de ~`30,14 s` do `presenceSweeper` corresponde exatamente à espera configurada de `30 s` entre a primeira e a segunda varredura de `Connections` (seção 3.4 da arquitetura).

## 3. DynamoDB (modo on-demand)

Nenhuma tabela apresentou limitação de taxa (`ThrottledRequests = 0`).

| Tabela | RCU consumidas (total) | Pico RCU/min | WCU consumidas (total) | Pico WCU/min | Throttled |
| --- | ---: | ---: | ---: | ---: | ---: |
| `Users` | 1.403 | 1.213 | 105 | 49 | 0 |
| `Conversations` | 345 | 231 | 176 | 113 | 0 |
| `Connections` | 69 | 28 | 240 | 141 | 0 |
| `Memberships` | 62 | 20 | 70 | 29 | 0 |
| `Messages` | 12 | 5 | 576 | 444 | 0 |

O maior consumo de leitura recai sobre `Users` (resolução de conexões no fan-out e varredura do `presenceSweeper`, conforme previsto na seção 7 da arquitetura) e o maior consumo de escrita sobre `Messages` (gravação transacional do marcador de idempotência + mensagem em cada `sendMessage`, gerando 4 WCUs por mensagem).

## 4. Gargalo observado na conta de testes

A consulta `aws lambda get-account-settings` confirmou que a conta AWS de desenvolvimento possui cota inicial de **`ConcurrentExecutions = 10`**. Como o `presenceSweeper` ocupa 1 execução durante ~30 s de cada minuto, sobram 9 slots simultâneos durante metade do tempo, explicando os 8 eventos de `ExecutionError` sob rajada simultânea de 10 usuários (todos absorvidos pela fila de reenvio idempotente sem perda nem duplicação). Para o ambiente produtivo, recomenda-se solicitar aumento da cota de concorrência Lambda (ex.: 100+) e avaliar elevar a memória da Lambda `app` de `128 MB` para `256–512 MB` para reduzir o tempo de CPU no fan-out e no cold start.
