# Métricas de infraestrutura coletadas na AWS

**Projeto:** Hub Colaborativo WebSocket  
**Estágio / Região:** `HubWebSocket-dev` / `sa-east-1`  
**Janela coletada:** `2026-11-21T16:44:00Z` a `2026-11-21T16:46:00Z` (janela completa de 2 minutos cobrindo integralmente as cargas T8 de 2, 5 e 10 usuários simultâneos, coletada após o atraso de ingestão do CloudWatch)  
**Dados brutos:** [docs/dados/cloudwatch-metrics-dev.json](dados/cloudwatch-metrics-dev.json)

## 1. API Gateway WebSocket e conexões

Os valores de `IntegrationLatency` abaixo correspondem à estatística agregada sobre toda a janela de 2 minutos (`Period = 120 s`), evitando distorções de média de percentis por minuto.

| Métrica                    | Soma na janela | Agregado da janela (`120 s`) | Pico (máx/min) | Observação                                                                                                   |
| -------------------------- | -------------: | ---------------------------: | -------------: | ------------------------------------------------------------------------------------------------------------ |
| `ConnectCount`             |             17 |                            — |             17 | Exatamente 2 + 5 + 10 conexões dos benchmarks T8                                                             |
| `MessageCount`             |          1.707 |                            — |          1.707 | Requisições de entrada + entregas em fan-out via `@connections`                                              |
| `OpenConnections` (custom) |              — |                            — |              1 | Publicada pelo `presenceSweeper` (`HubWebSocket/dev`) no tick da janela                                      |
| `IntegrationLatency` (avg) |              — |                **146,17 ms** |      146,17 ms | Inclui as rodadas de aquecimento e cold starts iniciais                                                      |
| `IntegrationLatency` (p95) |              — |                **559,04 ms** |      559,04 ms | Inclui rajadas iniciais frias (`warmup`) e 1 retry de concorrência                                           |
| `IntegrationError`         |              0 |                            — |              0 | Nenhum erro de integração com a Lambda                                                                       |
| `ClientError`              |             42 |                            — |             42 | Respostas `410 Gone` de `postToConnection` durante encerramento simultâneo dos clientes ao fim do teste      |
| `ExecutionError`           |              2 |                            — |              2 | 1 throttle em `app` + 1 em `disconnect` pela cota `ConcurrentExecutions = 10` (absorvido sem perda por RF12) |

## 2. Funções Lambda

Todas as funções rodaram em **ARM64 (Graviton2)** (`Node.js 22.x`), com **`512 MB`** (`app`, `connect`, `disconnect`, `default`) e **`256 MB`** (`presenceSweeper`, passagem única por minuto sem espera em `setTimeout`), apresentando **zero erros de execução** (`Errors = 0`). As colunas de duração reportam a média e o **p95 agregados diretamente sobre a janela inteira** (`Period = 120 s`) e o pico máximo observado.

| Função            | Invocações | Erros | Throttles | Duração média (janela, ms) | Duração p95 (janela, ms) | Duração máx (ms) |
| ----------------- | ---------: | ----: | --------: | -------------------------: | -----------------------: | ---------------: |
| `app`             |        190 |     0 |         1 |                 **105,01** |               **163,87** |           574,19 |
| `connect`         |         17 |     0 |         0 |                  **91,66** |               **252,29** |           256,01 |
| `disconnect`      |         16 |     0 |         1 |                 **281,10** |               **405,88** |           408,35 |
| `default`         |          0 |     0 |         0 |                          — |                        — |                — |
| `presenceSweeper` |          2 |     0 |         0 |                 **104,77** |               **122,61** |           123,20 |

Em comparação à configuração inicial (`128 MB` x86_64 e `presenceSweeper` com espera de `30 s`), o ganho foi expressivo:

- **`app`:** duração média caiu de `326,15 ms` para **`105,01 ms`** (−67,8%) e o p95 da janela caiu para **`163,87 ms`**.
- **`presenceSweeper`:** duração média caiu de `30.141,72 ms` para **`104,77 ms`** (redução de ~288× no tempo de execução e ocupação de slot de concorrência).

## 3. DynamoDB (modo on-demand)

Nenhuma tabela apresentou limitação de taxa (`ThrottledRequests = 0`). Os totais abaixo contabilizam 100% das 187 mensagens gravadas (`187 × 4 WCUs transacionais = 748 WCUs` em `Messages`).

| Tabela          | RCU consumidas (total) | Pico RCU/min | WCU consumidas (total) | Pico WCU/min | Throttled |
| --------------- | ---------------------: | -----------: | ---------------------: | -----------: | --------: |
| `Users`         |                  1.561 |        1.289 |                     72 |           54 |         0 |
| `Conversations` |                    390 |          258 |                    193 |          124 |         0 |
| `Connections`   |                     66 |           59 |                    229 |          151 |         0 |
| `Memberships`   |                     33 |           24 |                     34 |           20 |         0 |
| `Messages`      |                      0 |            0 |                    748 |          484 |         0 |

O maior consumo de leitura recai sobre `Users` (resolução de conexões no fan-out e varredura do `presenceSweeper`, seção 7 da arquitetura) e o maior consumo de escrita sobre `Messages` (gravação transacional do marcador de idempotência `id#…` com TTL + mensagem `m#…` em cada `sendMessage`).

## 4. Cota de concorrência da conta de desenvolvimento

A consulta `aws lambda get-account-settings` confirma que a conta AWS de desenvolvimento ainda possui a cota inicial de conta nova (`ConcurrentExecutions = 10`). Com a remoção do `setTimeout(30 s)` do `presenceSweeper` e o corte de 3× na duração da Lambda `app` (`512 MB` ARM64), a contenção caiu de `8` para apenas **`2` eventos** (`1` throttle em `app` e `1` em `disconnect`), permitindo que o experimento T8 com 10 usuários simultâneos cumprisse com folga o requisito **RNF02** (`p95 = 166,05 ms < 500 ms`). Para o estágio `prod`, continua recomendado solicitar o desbloqueio da cota padrão da conta (`1.000` execuções simultâneas) via console AWS Support / Service Quotas.
