# Hub Colaborativo WebSocket

Aplicação de mensagens em tempo real usando WebSockets no API Gateway da AWS. Funciona como um mini-Teams só de chat: conversas privadas e em grupo, com presença online e histórico.

Projeto da disciplina de Sistemas Distribuídos (2026.2, Tema 4), com entrega em 03/12/2026. O detalhamento do tema está em [docs/tema-4-api-gateway-websockets-detalhamento.pdf](docs/tema-4-api-gateway-websockets-detalhamento.pdf).

## Como funciona

O cliente web, em Angular, abre uma conexão WebSocket persistente com o API Gateway, informando o nome de usuário e o nome de exibição. Cada rota do API Gateway (`$connect`, `$disconnect`, `$default` e as rotas de aplicação, como `sendMessage`) chama uma função Lambda. As Lambdas guardam conexões, usuários, conversas e mensagens no DynamoDB e entregam os eventos aos destinatários pela Callback API (`@connections`). A infraestrutura é declarada com o AWS CDK, com um stack por estágio (`dev` e `prod`) na região `sa-east-1`.

## Documentação

- [Especificação](docs/especificacao.md): requisitos, riscos, limitações e plano de testes.
- [Arquitetura](docs/arquitetura.md): serviços da AWS, esquema de nomeação, dados, rotas e eventos, comportamento do cliente, logs e métricas.
- [Sessão](docs/sessao.md): ciclo de vida da sessão, com o handshake, os frames e o diretório de conexões.
- [Design no Figma](https://www.figma.com/design/ThG8NUReHI5c9tYzXdaU6z/Hub-Colaborativo-WebSocket): telas e componentes da interface.

## Estrutura

- `backend/`: stack do CDK (`lib/`) e código das Lambdas (`functions/`). Detalhes de desenvolvimento e implantação estão no [README do backend](backend/README.md).
- `frontend/`: cliente web em Angular, com Angular Material.
- `docs/`: especificação, arquitetura e sessão.

## Estado atual

O backend implementa as rotas `$connect`, `$disconnect`, `$default` e `heartbeat`, com o vínculo entre usuário e `connectionId` no DynamoDB, e está implantado no estágio `dev`. As demais rotas de aplicação, como o envio de mensagens, ainda caem na `$default`.

O frontend tem todas as telas, mas ainda não se comunica com o backend: roda sobre dados fixos, e os estados que só o backend produziria, como a queda da conexão ou uma mensagem recusada, são simulados por cenários.

## Como rodar

É preciso ter o Node.js 22.22.3 ou mais novo (ou o 24.15.0 ou mais novo), versão mínima exigida pelo Angular CLI.

Frontend:

```sh
cd frontend
npm ci
npm start
```

A interface abre em http://localhost:4200. Em desenvolvimento, os cenários são escolhidos com `?cenario=`, como em http://localhost:4200/?cenario=sem-conexao,pendentes; a lista completa está em `frontend/src/app/core/fixtures/scenarios.ts`. Para conferir o código: `npm test`, `npm run lint` e `npx prettier --check src`.

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
- Wallysson Maciel: testes e integração.

## Contribuindo

O projeto segue o Git Flow a partir da `develop` e usa Conventional Commits em português. O fluxo de branches, as convenções e onde documentar cada coisa estão no [guia de contribuição](CONTRIBUTING.md).
