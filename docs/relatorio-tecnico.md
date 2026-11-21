# Relatório técnico — Hub Colaborativo WebSocket

**Disciplina:** Sistemas Distribuídos (2026.2 — Tema 4)  
**Equipe:** Antônio Rodrigo, Felipe da Silva, Wallyson Maciel e Wellington Cezario  
**Entrega:** 03/12/2026  

---

## 1. Resumo executivo

O **Hub Colaborativo WebSocket** é uma aplicação distribuída de comunicação bidirecional em tempo real construída sobre uma arquitetura *serverless* na AWS (região `sa-east-1`). A aplicação oferece conversas privadas e em grupo, presença online/offline em tempo real, histórico paginado, pesquisa, reconexão automática com backoff exponencial, fila local de reenvio idempotente, logs anonimizados via HMAC-SHA256 e painel de métricas no CloudWatch. Toda a infraestrutura — incluindo a hospedagem do cliente web Angular em S3 privado com CloudFront (OAC) — é versionada como código (IaC) via AWS CDK.

## 2. Fundamentação científica e mecanismos de comunicação

Com base no whitepaper oficial *Real-Time Communication on AWS* e nos fundamentos de sistemas distribuídos, a escolha de **WebSockets sobre Amazon API Gateway** resolve limitações estruturais de modelos baseados em HTTP tradicional:

- **HTTP Polling / Long Polling:** impõem sobrecarga contínua de cabeçalhos, latência acoplada ao intervalo de consulta e desperdício de computação em requisições vazias.
- **Server-Sent Events (SSE):** atendem entrega unidirecional servidor → cliente sobre HTTP, exigindo canais separados para envio e oferecendo suporte limitado a controle de sessão bidirecional.
- **WebSocket (RFC 6455):** inicia com um *handshake* `HTTP Upgrade` (`101 Switching Protocols`) e promove a conexão TCP para um canal full-duplex persistente baseado em frames leves, reduzindo drasticamente a latência e o tráfego de controle.

Em ambientes *serverless* (AWS Lambda), o desafio central é manter **sessões persistentes (stateful)** sobre **funções efêmeras (stateless)**. O API Gateway WebSocket atua como camada de terminação de conexões persistentes, atribuindo a cada sessão um `connectionId` único e invocando Lambdas sob demanda por rotas selecionadas via `$request.body.action` (`$connect`, `$disconnect`, `$default` e rotas de aplicação). O retorno assíncrono a qualquer cliente conectado ocorre pela **Callback API (`@connections` / `PostToConnection`)**, enquanto o estado de sessão e diretório de nomes é externalizado no Amazon DynamoDB (decisão **D01**). Detalhes do handshake, frames e ciclo de sessão constam em [docs/sessao.md](sessao.md).

## 3. Requisitos, riscos e arquitetura distribuída

Os requisitos funcionais (**RF01–RF12**), não funcionais (**RNF01–RNF07**), riscos (**R01–R07**) e limitações conhecidas (**L01–L04**) estão especificados em [docs/especificacao.md](especificacao.md). A arquitetura completa, o esquema de nomeação (`username`, `conversationId` determinístico `d:<u1>:<u2>` ou `g:<uuid>`, `connectionId` ↔ URI `@connections`), o modelo de dados em cinco tabelas DynamoDB on-demand (`Connections`, `Users`, `Conversations`, `Memberships`, `Messages`) e o catálogo de 11 decisões de projeto (**D01–D11**) estão documentados em [docs/arquitetura.md](arquitetura.md).

Destaques arquiteturais:
- **Lambda única de aplicação (D02):** concentra `heartbeat`, `sync`, `sendMessage`, `openDirect`, `createGroup`, `addMember`, `leaveGroup`, `getHistory` e `search`, reduzindo inícios a frio (R05).
- **Leituras fortemente consistentes e conjuntos no item (D04):** evita a consistência eventual de GSIs na resolução de destinatários e membros, garantindo que uma nova conexão ou membro não fique fora do fan-out.
- **Ordem determinística e deduplicação (RNF04, RF12):** mensagens usam sort key `m#<sentAt>#<sender>#<messageId>` e gravação transacional junto ao marcador de idempotência `id#<sender>#<messageId>`, detalhados em [docs/sincronizacao.md](sincronizacao.md).
- **Versão monotônica para presença (D10) e participação oculta (D11):** impede que anúncios atrasados revertam estados mais novos e permite receber presença antes da primeira mensagem de um chat privado sem exibi-lo prematuramente.

## 4. Tolerância a falhas e resiliência

A estratégia de tolerância a falhas cobre ambos os lados do sistema ([docs/tolerancia-falhas.md](tolerancia-falhas.md)):

- **Backend:** tratamento explícito de `410 Gone` (`GoneException`) com desvínculo isolado da conexão morta (RF08); isolamento de falhas paralelas no `fanOut` e em rotas com múltiplas difusões via `settle` (reunindo múltiplas exceções em `AggregateError` sem encerrar entregas em andamento); job periódico `presenceSweeper` a cada minuto via EventBridge Scheduler (D05) para expirar conexões com mais de 10 minutos de inatividade, limpar ids órfãos com releitura consistente e refazer anúncios de presença pendentes há mais de 1 minuto (`announcedVersion < version`), deixando o TTL do DynamoDB apenas como faxina; e retentativas com jitter em conflitos de transação.
- **Cliente web:** `heartbeat` a cada 30 s com timeout de `pong` em 10 s; reconexão automática com backoff exponencial (`0 ms`, `1 s`, `2 s`, …, teto de `30 s`); separação entre bloqueio imediato das ações dependentes do backend e janela de 3 s antes de exibir o banner e ocultar presença; recuperação sem perdas nem duplicatas via `sync(since)` e `getHistory(after)` recuados em 30 s; e fila local em memória reenviando mensagens uma por vez por conversa com aviso no `beforeunload`.

## 5. Segurança, observabilidade e implantação (IaC)

Conforme detalhado em [docs/observabilidade-implantacao.md](observabilidade-implantacao.md):

- **Autorização e validação (RF01, RNF01):** `$connect` rejeita handshakes sem `username` válido (HTTP 400); todas as rotas sobre conversas (`sendMessage`, `getHistory`, `addMember`, `leaveGroup`) verificam a participação do usuário da conexão em `Conversations.members`, recusando intrusos com `forbidden`.
- **Logs estruturados anonimizados (RNF03):** cada requisição grava uma linha JSON contendo rota, resultado (`ok`, `duplicate`, `gone`, `rejected`, `error`), duração a partir de `requestTimeEpoch` e os identificadores (`connectionId`, `username`, `conversationId`) anonimizados nos 12 primeiros hexadecimais de `HMAC-SHA256` usando segredo `SecureString` no SSM Parameter Store (`kms:Decrypt` restrito a `alias/aws/ssm`), sem jamais registrar o texto das mensagens.
- **Métricas e painel (RNF06):** o painel `HubWebSocket-<estágio>` no CloudWatch monitora `ConnectCount`, `OpenConnections` (métrica customizada do `presenceSweeper`), `MessageCount`, invocações/erros/duração das Lambdas e `IntegrationLatency`, complementado pelo painel opcional **Telemetria e eventos** e indicador de RTT no cliente web.
- **Implantação (RNF05, RNF07, D08):** stack CDK único por estágio (`dev` e `prod`), publicando o cliente Angular em bucket S3 privado atrás de CloudFront com OAC, redirecionamento HTTPS, fallback SPA (`403`/`404` → `/index.html`) e geração dinâmica de `config.json` com `CACHING_DISABLED`.

## 6. Validação funcional e avaliação de desempenho

### 6.1 Testes unitários e de integração
- **Testes automatizados locais:** 89 testes unitários/infra no backend (6 suítes Jest + `cdk synth`) e 165 testes no frontend (59 suítes Angular/Vitest), todos com lint, typecheck e formatação validados.
- **Bateria de integração no estágio `dev` ([docs/testes.md](testes.md)):** 6/6 cenários aprovados contra a AWS real cobrindo T3 (isolamento, histórico, ordenação concorrente, `lastMember`), T7 (reenvio idempotente, presença online/offline em tempo real, recuperação pós-queda via `sync`/`getHistory`), rejeição de handshakes inválidos, recusa `forbidden` (RNF01) e auditoria real no CloudWatch Logs (28 linhas JSON com hashes de 12 hex e zero vazamentos).

### 6.2 Experimento prático de desempenho (T8)
Os resultados completos, gráficos e métricas de infraestrutura estão em [docs/avaliacao-desempenho.md](avaliacao-desempenho.md) e [docs/metricas-infraestrutura.md](metricas-infraestrutura.md):

| Carga simultânea | Entregas | Média (ms) | p50 (ms) | p95 (ms) | p99 (ms) | Vazão (entregas/s) | Ordem (RNF04) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 2 usuários | 40 | 296,77 | 280,59 | 412,25 | 480,58 | 13,08 | 100% |
| 5 usuários | 250 | 315,43 | 283,39 | 465,54 | 884,93 | 64,47 | 100% |
| 10 usuários (T8) | 1.000 | 368,14 | 343,41 | 551,06 | 845,63 | 157,74 | 100% |

Principais conclusões experimentais:
1. O descarte da rodada de aquecimento (R05) reduziu a latência média em **56,4%** sob 10 usuários (`844,50 ms` → `368,14 ms`), comprovando o impacto do início a frio das Lambdas.
2. As cinco funções Lambda apresentaram **0 erros** e as cinco tabelas DynamoDB apresentaram **0 throttling**.
3. O p95 de `551,06 ms` em 10 usuários (contra o alvo RNF02 de `500 ms`, embora média e p50 fiquem em `368 ms` e `343 ms`) teve duas causas medidas: cota inicial `ConcurrentExecutions = 10` da conta AWS (disputada com o `presenceSweeper`, causando 7 retries recuperados sem perda nem duplicação por RF12) e memória padrão de `128 MB` na Lambda `app`.

## 7. Conclusão e trabalhos futuros

A arquitetura *serverless* com API Gateway WebSocket, Lambda e DynamoDB demonstrou-se adequada para comunicação colaborativa em tempo real com custo proporcional ao uso, alta confiabilidade na ordenação de mensagens e recuperação automática de falhas parciais. Como próximos passos para escala produtiva, destacam-se: (1) elevar a cota `ConcurrentExecutions` e a memória da Lambda `app` para `256–512 MB`; (2) substituir a varredura `Scan` de pesquisa e do `presenceSweeper` por índices dedicados ao crescer a base de usuários (seção 7 da arquitetura); (3) introduzir autenticação federada (Cognito/JWT no `$connect`, removendo L01); e (4) adicionar alarmes automatizados no CloudWatch e paginação de `sync`/`search`.

## Referências

- AWS Whitepaper — *Real-Time Communication on AWS*.
- Documentação técnica do projeto: [especificacao.md](especificacao.md), [arquitetura.md](arquitetura.md), [sessao.md](sessao.md), [sincronizacao.md](sincronizacao.md), [tolerancia-falhas.md](tolerancia-falhas.md), [observabilidade-implantacao.md](observabilidade-implantacao.md), [testes.md](testes.md), [avaliacao-desempenho.md](avaliacao-desempenho.md), [metricas-infraestrutura.md](metricas-infraestrutura.md) e [roteiro-demonstracao.md](roteiro-demonstracao.md).
