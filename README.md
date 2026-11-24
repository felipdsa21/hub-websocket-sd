# Hub Colaborativo WebSocket

Aplicação de mensagens em tempo real usando WebSockets no API Gateway da AWS. Funciona como um mini-Teams só de chat: conversas privadas e em grupo, com presença online e histórico.

Projeto da disciplina de Sistemas Distribuídos (2026.2, Tema 4), com entrega em 03/12/2026. O detalhamento do tema está em [docs/tema-4-api-gateway-websockets-detalhamento.pdf](docs/tema-4-api-gateway-websockets-detalhamento.pdf).

## Como funciona

O cliente web, em Angular, abre uma conexão WebSocket persistente com o API Gateway, informando o nome de usuário e o nome de exibição. Cada rota do API Gateway (`$connect`, `$disconnect`, `$default` e as rotas de aplicação, como `sendMessage`) chama uma função Lambda. As Lambdas guardam conexões, usuários, conversas e mensagens no DynamoDB e entregam os eventos aos destinatários pela Callback API (`@connections`). A infraestrutura é declarada com o AWS CDK, com um stack por estágio (`dev` e `prod`) na região `sa-east-1`.

## Documentação

- [Especificação](docs/especificacao.md): requisitos, riscos, limitações e plano de testes.
- [Arquitetura](docs/arquitetura.md): serviços da AWS, esquema de nomeação, dados, rotas e eventos, comportamento do cliente, logs e métricas.
- [Sessão](docs/sessao.md): ciclo de vida da sessão, com o handshake, os frames e o diretório de conexões.
- [Sincronização e consistência](docs/sincronizacao.md): ordenação de mensagens, deduplicação, consistência no DynamoDB e ciclo de vida das conversas.
- [Tolerância a falhas](docs/tolerancia-falhas.md): conexões órfãs (`410 Gone`), isolamento de falhas na difusão, expiração por inatividade, heartbeat, reconexão e recuperação no cliente.
- [Observabilidade e implantação](docs/observabilidade-implantacao.md): logs estruturados com anonimização HMAC-SHA256, métricas/painel/alarmes no CloudWatch, IAM de menor privilégio e hospedagem S3 + CloudFront (OAC) via CDK.
- [Evidências de teste](docs/testes.md): evidências T1–T8, bateria automatizada de integração na AWS (`12/12`, incluindo `410 Gone` e `presenceSweeper`) e validação E2E em Chromium sobre CloudFront.
- [Avaliação de desempenho](docs/avaliacao-desempenho.md): metodologia do experimento T8, latências (média, p50, p95, p99), vazão, consumo do DynamoDB e gráficos comparativos.
- [Métricas de infraestrutura](docs/metricas-infraestrutura.md): métricas exportadas do CloudWatch (API Gateway, Lambdas ARM64, DynamoDB e `OpenConnections`) durante o experimento T8.
- [Relatório técnico consolidado](docs/relatorio-tecnico.md): documento unificando fundamentação científica, arquitetura, decisões, tolerância a falhas, observabilidade e avaliação experimental.
- [Roteiro de demonstração ao vivo](docs/roteiro-demonstracao.md): guia passo a passo para a apresentação prática com múltiplos clientes e painel CloudWatch.
- [Design no Figma](https://www.figma.com/design/ThG8NUReHI5c9tYzXdaU6z/Hub-Colaborativo-WebSocket): telas e componentes da interface.

## Estrutura

- `backend/`: stack do CDK (`lib/`) e código das Lambdas (`functions/`). Detalhes de desenvolvimento e implantação estão no [README do backend](backend/README.md).
- `frontend/`: cliente web em Angular, com Angular Material.
- `scripts/`: scripts de benchmark T8, coleta de métricas no CloudWatch, geração de gráficos SVG e testes de integração no `dev` ([README dos scripts](scripts/README.md)).
- `docs/`: especificação, arquitetura, sessão, sincronização, tolerância a falhas, observabilidade, evidências de teste, avaliação de desempenho, métricas, relatório técnico, roteiro de demo, dados e imagens.

## Estado atual

O backend implementa as rotas `$connect`, `$disconnect`, `$default`, `heartbeat`, `sync`, `sendMessage`, `openDirect`, `createGroup`, `addMember`, `leaveGroup`, `getHistory` e `search` (em Lambdas ARM64 com IAM de menor privilégio e throttling no estágio), persistência no DynamoDB com TTL nos marcadores de idempotência e entrega via `@connections`, anúncios de presença em tempo real aos contatos, a rotina `presenceSweeper` (expiração de inativas em passagem única por minuto, refeitura de anúncios pendentes e métrica `OpenConnections`), logs estruturados com anonimização HMAC-SHA256 (SSM Parameter Store), painel e alarmes no CloudWatch, além da hospedagem do frontend em S3 privado com CloudFront (OAC e cabeçalhos de segurança HTTP).

O frontend tem todas as telas, incluindo modo escuro persistido e painel de telemetria com RTT opcional. Ele persiste a sessão e o nome de exibição no navegador sincronizados entre abas (`storage`), reconecta em paralelo ao trocar o nome de exibição sem queda, mantém o heartbeat e escuta eventos `offline`/`online`, reconecta automaticamente com backoff exponencial sincronizando mensagens perdidas e reenviando a fila local, carrega a lista de conversas com o `sync`, carrega o histórico, envia e recebe mensagens em tempo real, aplica os eventos de conversas, membros e presença, pesquisa e faz as ações sobre conversas (iniciar chat, criar grupo, adicionar pessoas e sair).

## Como rodar

É preciso ter o Node.js 24.15.0 ou mais novo (ou o 26), versão mínima exigida pelo Angular CLI.

Frontend:

```sh
cd frontend
npm ci
npm start
```

Antes de abrir a interface, copie `frontend/public/config.example.json` para `frontend/public/config.json` e coloque nele o endereço do estágio `dev` (a saída `WebSocketUrl` do `cdk deploy`); sem ele, não é possível entrar. O `config.json` fica fora do Git.

A interface abre em http://localhost:4200. Para conferir o código: `npm test`, `npm run lint` e `npx prettier --check src`.

Backend:

```sh
cd backend
npm ci
npm test
npx cdk synth HubWebSocket-dev
```

A implantação e o teste manual com o `wscat` estão no [README do backend](backend/README.md).

## Equipe

- Antônio Rodrigo: arquitetura e documentação.
- Wellington Cezario: cloud e backend.
- Felipe da Silva: frontend.
- Wallyson Maciel: testes e integração.

## Contribuindo

O projeto segue o Git Flow a partir da `develop` e usa Conventional Commits em português. O fluxo de branches, as convenções e onde documentar cada coisa estão no [guia de contribuição](CONTRIBUTING.md).
