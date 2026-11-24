# Relatório técnico — Hub Colaborativo WebSocket

**Disciplina:** Sistemas Distribuídos (2026.2 — Tema 4)  
**Equipe:** Antônio Rodrigo, Felipe da Silva, Wallyson Maciel e Wellington Cezario  
**Entrega:** 03/12/2026

---

## 1. Resumo executivo

O **Hub Colaborativo WebSocket** é uma aplicação distribuída de comunicação bidirecional em tempo real construída sobre uma arquitetura _serverless_ na AWS (região `sa-east-1`). A aplicação oferece conversas privadas e em grupo, presença online/offline em tempo real, troca de nome de exibição via reconexão paralela sem queda, persistência de sessão com sincronização multi-aba, histórico paginado, pesquisa tolerante a acentos (`pt-BR`), reconexão automática com backoff exponencial, fila local de reenvio idempotente, modo escuro com contraste WCAG AA, logs anonimizados via HMAC-SHA256 e painel com alarmes no CloudWatch. Toda a infraestrutura — incluindo a hospedagem do cliente web Angular em S3 privado com CloudFront (OAC e cabeçalhos de segurança HTTP) — é versionada como código (IaC) via AWS CDK.

## 2. Fundamentação científica e mecanismos de comunicação

Com base nos fundamentos de sistemas distribuídos, a escolha de **WebSockets sobre Amazon API Gateway** resolve limitações estruturais de modelos baseados em HTTP tradicional:

- **HTTP Polling / Long Polling:** impõem sobrecarga contínua de cabeçalhos, latência acoplada ao intervalo de consulta e desperdício de computação em requisições vazias.
- **Server-Sent Events (SSE):** atendem entrega unidirecional servidor → cliente sobre HTTP, exigindo canais separados para envio e oferecendo suporte limitado a controle de sessão bidirecional.
- **WebSocket (RFC 6455):** inicia com um _handshake_ `HTTP Upgrade` (`101 Switching Protocols`) e promove a conexão TCP para um canal full-duplex persistente baseado em frames leves, reduzindo drasticamente a latência e o tráfego de controle.

Em ambientes _serverless_ (AWS Lambda), o desafio central é manter **sessões persistentes (stateful)** sobre **funções efêmeras (stateless)**. O API Gateway WebSocket atua como camada de terminação de conexões persistentes, atribuindo a cada sessão um `connectionId` único e invocando Lambdas sob demanda por rotas selecionadas via `$request.body.action` (`$connect`, `$disconnect`, `$default` e rotas de aplicação). O retorno assíncrono a qualquer cliente conectado ocorre pela **Callback API (`@connections` / `PostToConnection`)**, enquanto o estado de sessão e diretório de nomes é externalizado no Amazon DynamoDB (decisão **D01**). Detalhes do handshake, frames e ciclo de sessão constam em [docs/sessao.md](sessao.md).

## 3. Requisitos, riscos e arquitetura distribuída

Os requisitos funcionais (**RF01–RF12**), não funcionais (**RNF01–RNF07**), riscos (**R01–R07**) e limitações conhecidas (**L01–L04**) estão especificados em [docs/especificacao.md](especificacao.md). A arquitetura completa, o esquema de nomeação (`username`, `conversationId` determinístico `d:<u1>:<u2>` ou `g:<uuid>`, `connectionId` ↔ URI `@connections`), o modelo de dados em cinco tabelas DynamoDB on-demand (`Connections`, `Users`, `Conversations`, `Memberships`, `Messages`) e o catálogo de 11 decisões de projeto (**D01–D11**) estão documentados em [docs/arquitetura.md](arquitetura.md).

Destaques arquiteturais:

- **Lambda única de aplicação em ARM64 (D02):** concentra `heartbeat`, `sync`, `sendMessage`, `openDirect`, `createGroup`, `addMember`, `leaveGroup`, `getHistory` e `search` (`512 MB`, Graviton2), reduzindo inícios a frio (R05) e a latência do fan-out.
- **Leituras fortemente consistentes e conjuntos no item (D04):** evita a consistência eventual de GSIs na resolução de destinatários e membros, garantindo que uma nova conexão ou membro não fique fora do fan-out.
- **Ordem determinística e deduplicação (RNF04, RF12):** mensagens usam sort key `m#<sentAt>#<sender>#<messageId>` e gravação transacional junto ao marcador de idempotência `id#<sender>#<messageId>` (com TTL de 7 dias apenas no marcador), detalhados em [docs/sincronizacao.md](sincronizacao.md).
- **Versão monotônica para presença (D10) e participação oculta (D11):** impede que anúncios atrasados revertam estados mais novos e permite receber presença antes da primeira mensagem de um chat privado sem exibi-lo prematuramente.
- **Limites defensivos:** teto de `32 KB` UTF-8 em `sendMessage` (para que uma mensagem perto de `128 KB`, vinda de outro cliente, não deixe uma página do `getHistory` acima do limite do `@connections`), teto de `99` membros em `createGroup` e `addMember`, normalização de acentos e limite de `50` resultados por categoria em `search`, e rejeição de caracteres de controle/bidi nos nomes.

## 4. Tolerância a falhas e resiliência

A estratégia de tolerância a falhas cobre ambos os lados do sistema ([docs/tolerancia-falhas.md](tolerancia-falhas.md)):

- **Backend:** tratamento explícito de `410 Gone` (`GoneException`) com desvínculo isolado da conexão morta (RF08); isolamento de falhas paralelas na difusão e em rotas com múltiplas difusões (reunindo múltiplas exceções em `AggregateError` sem encerrar entregas em andamento); job periódico `presenceSweeper` (`256 MB` ARM64, timeout `30 s`) a cada minuto via EventBridge Scheduler em passagem única (~`105 ms`, D05) para expirar conexões com mais de 10 minutos de inatividade, limpar ids órfãos com releitura consistente e refazer anúncios de presença pendentes há mais de 1 minuto (`announcedVersion < version`), deixando o TTL do DynamoDB apenas como faxina; e retentativas com jitter em conflitos de transação.
- **Cliente web:** `heartbeat` a cada 30 s com timeout de `pong` em 10 s combinado aos eventos `offline`/`online` da `window`; reconexão automática com backoff exponencial (`0 ms`, `1 s`, `2 s`, …, teto de `30 s`); separação entre bloqueio imediato das ações dependentes do backend e janela de 3 s antes de exibir o banner e ocultar presença; troca de `displayName` via reconexão paralela sem queda e sincronização multi-aba via evento `storage` (RF01); recuperação sem perdas nem duplicatas via `sync(since)` e `getHistory(after)` recuados em 30 s; e fila local em memória reenviando mensagens uma por vez por conversa com aviso no `beforeunload`.

## 5. Segurança, observabilidade e implantação (IaC)

Conforme detalhado em [docs/observabilidade-implantacao.md](observabilidade-implantacao.md):

- **Autorização, validação e menor privilégio (RF01, RNF01):** `$connect` rejeita handshakes sem `username` válido ou com caracteres de controle/bidi (HTTP 400); todas as rotas sobre conversas (`sendMessage`, `getHistory`, `addMember`, `leaveGroup`) verificam a participação do usuário da conexão em `Conversations.members`, recusando intrusos com `forbidden`. Apenas a Lambda `app` acessa a tabela `Messages` (IAM mínimo por função), e o estágio WebSocket impõe throttling (`1.000 rps`, burst `2.000`).
- **Logs estruturados anonimizados (RNF03):** cada requisição grava uma linha JSON contendo rota, resultado (`ok`, `duplicate`, `gone`, `rejected`, `error`), duração a partir de `requestTimeEpoch` e os identificadores (`connectionId`, `username`, `conversationId`) anonimizados nos 12 primeiros hexadecimais de `HMAC-SHA256` usando segredo `SecureString` no SSM Parameter Store (`kms:Decrypt` restrito a `alias/aws/ssm`, pré-carregado em paralelo no cold start), sem jamais registrar o texto das mensagens. Os `LogGroup`s mantêm retenção de `14 dias` em `dev` e `30 dias` em `prod`.
- **Métricas, painel e alarmes (RNF06):** o painel `HubWebSocket-<estágio>` no CloudWatch reúne 6 gráficos (`ConnectCount`/`OpenConnections`, `MessageCount`/invocações, erros, latência incluindo `app`/`connect`/`presenceSweeper`, `Throttles` das Lambdas e erros/throttling do DynamoDB) e 3 alarmes automatizados (`AppErrors`, `AppThrottles` e `PresenceSweeperDuration`), complementados pelo painel **Telemetria e eventos** e indicador de RTT no cliente web.
- **Implantação (RNF05, RNF07, D08):** stack CDK único por estágio (`dev` e `prod`), publicando o cliente Angular em bucket S3 privado atrás de CloudFront com OAC, redirecionamento HTTPS, cabeçalhos de segurança (`HSTS`, `CSP` estrita com `script-src 'self'`, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`), fallback SPA (`403`/`404` → `/index.html`) e `CACHING_DISABLED` para `config.json` e `index.html`, além de PITR no DynamoDB e versionamento S3 em `prod`.

## 6. Validação funcional e avaliação de desempenho

### 6.1 Testes unitários, integração na AWS e E2E em navegador real

- **Testes automatizados locais:** **126 testes** unitários/infra no backend (6 suítes Jest + `cdk synth` `dev`/`prod`) e **190 testes** no frontend (58 suítes Angular/Vitest), todos com lint, typecheck e formatação validados.
- **Bateria de integração ao vivo no estágio `dev` ([docs/testes.md](testes.md)):** **12/12 cenários aprovados** contra a AWS real cobrindo partes do T2 (`31,6 KB` UTF-8, sem o bloqueio de 40 KB no cliente web), T3 (isolamento, histórico, ordenação concorrente, `lastMember`), T4 (pesquisa sem acento `pt-BR`), parte do T5 (histórico > `128 KB` paginado em 5 páginas, com mensagens de ~28 KB), T6 (presença multi-aba), **T7.1 (`410 Gone` / `GoneException` real)**, parte do T7.2 (remoção pelo `presenceSweeper` de um registro gravado já ocioso), T7.5 (reenvio idempotente), recuperação pós-queda com um cliente de script, segurança (`$connect` incluindo controles/bidi e `forbidden` RNF01) e auditoria no CloudWatch Logs (`appLogs` com 45 linhas JSON + `presenceSweeperLogs`, zero vazamentos).
- **Validação E2E em Chromium sobre CloudFront HTTPS ([docs/testes.md](testes.md)):** zero erros de console, zero violações de CSP e zero HTTP >= 400 (incluindo troca de `displayName` paralela sem `offline`, recarga F5 + 2ª aba + sincronização multi-aba de logout/login via `storage`, pesquisa, escolha de pessoas, bloqueio por teclado offline e contraste WCAG AA nos modos claro e escuro), sem capturas nem logs no repositório.

### 6.2 Experimento prático de desempenho (T8)

Os resultados completos, gráficos e métricas de infraestrutura estão em [docs/avaliacao-desempenho.md](avaliacao-desempenho.md) e [docs/metricas-infraestrutura.md](metricas-infraestrutura.md):

| Carga simultânea | Entregas | Média (ms) | p50 (ms) |   p95 (ms) | p99 (ms) | Vazão (entregas/s) | Ordem (RNF04)  | RNF02 (`p95 < 500 ms`) |
| ---------------- | -------: | ---------: | -------: | ---------: | -------: | -----------------: | -------------- | ---------------------- |
| 2 usuários       |       40 |     128,19 |   123,29 | **153,97** |   155,14 |              30,21 | 100% (22/22)   | **Aprovado**           |
| 5 usuários       |      250 |     140,87 |   130,30 | **167,66** |   553,41 |             142,70 | 100% (55/55)   | **Aprovado**           |
| 10 usuários (T8) |    1.000 |     160,67 |   131,71 | **166,05** |   598,07 |         **278,16** | 100% (110/110) | **Aprovado**           |

Principais conclusões experimentais:

1. A migração das Lambdas de rota para **`512 MB` ARM64** e a remoção da espera de `30 s` do `presenceSweeper` (`~105 ms` por execução) reduziram o p95 de 10 usuários de `551,06 ms` (medição anterior, sem dados brutos em `docs/dados/`) para **`166,05 ms`** (−69,9%), cumprindo o **RNF02** com mais de 3× de folga e elevando a vazão para **`278,16` entregas/s**.
2. O descarte da rodada de aquecimento (R05) reduziu a latência média em **67,1%** sob 10 usuários (`488,86 ms` → `160,67 ms`) e o p95 em **83,4%** (`1.002,33 ms` → `166,05 ms`).
3. As cinco funções Lambda registraram **0 erros** e as cinco tabelas DynamoDB registraram **0 throttling**, com apenas 1 retry pontual na cauda `p99`/`máx` devido à cota inicial `ConcurrentExecutions = 10` da conta nova (recuperado sem perda nem duplicação por RF12).

## 7. Conclusão e trabalhos futuros

A arquitetura _serverless_ com API Gateway WebSocket, Lambda (ARM64) e DynamoDB demonstrou-se adequada para comunicação colaborativa em tempo real com custo proporcional ao uso, latência p95 de `166 ms` sob 10 usuários simultâneos, ordenação determinística 100% consistente e recuperação automática de falhas parciais. Como próximos passos para escala produtiva, destacam-se: (1) solicitar o desbloqueio da cota padrão `ConcurrentExecutions = 1.000` na conta AWS antes de subir tráfego acima de 10 usuários simultâneos; (2) substituir a varredura `Scan` de pesquisa e do `presenceSweeper` por índices dedicados ao crescer a base de usuários (seção 7 da arquitetura); (3) introduzir autenticação federada (Cognito/JWT no `$connect`, removendo L01); e (4) adicionar paginação ao `sync` e ações SNS nos alarmes do CloudWatch.

## Referências

- Documentação técnica do projeto: [especificacao.md](especificacao.md), [arquitetura.md](arquitetura.md), [sessao.md](sessao.md), [sincronizacao.md](sincronizacao.md), [tolerancia-falhas.md](tolerancia-falhas.md), [observabilidade-implantacao.md](observabilidade-implantacao.md), [testes.md](testes.md), [avaliacao-desempenho.md](avaliacao-desempenho.md), [metricas-infraestrutura.md](metricas-infraestrutura.md) e [roteiro-demonstracao.md](roteiro-demonstracao.md).
