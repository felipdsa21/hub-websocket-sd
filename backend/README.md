# Backend

Infraestrutura e Lambdas do Hub Colaborativo WebSocket, declaradas com o AWS CDK. A arquitetura está em [docs/arquitetura.md](../docs/arquitetura.md).

Há um stack por estágio, `HubWebSocket-dev` e `HubWebSocket-prod`, na região `sa-east-1`. O código das Lambdas fica em `functions/`, e o stack, em `lib/`.

Estão implementadas as rotas `$connect`, `$disconnect`, `$default`, `heartbeat`, `sync`, `sendMessage`, `openDirect`, `createGroup`, `addMember`, `leaveGroup`, `getHistory` e `search`, além da Lambda `presenceSweeper`, que expira as conexões inativas a cada minuto e remove ids órfãos. Ainda faltam os anúncios de presença (no `$connect`, no desvínculo e a refeitura no `presenceSweeper`), a métrica de conexões abertas no CloudWatch e a anonimização HMAC nos logs.

## Desenvolvimento

```sh
npm ci
npm run build   # verificação de tipos
npm run lint
npm test
npx cdk synth HubWebSocket-dev
```

## Implantação

Com as credenciais da AWS configuradas (`aws configure`), uma vez por conta e região:

```sh
npx cdk bootstrap aws://<conta>/sa-east-1
```

Depois, a cada mudança:

```sh
npx cdk deploy HubWebSocket-dev
```

A saída `WebSocketUrl` traz o endereço `wss://` do estágio.

## Teste manual

```sh
npx wscat -c "wss://<api-id>.execute-api.sa-east-1.amazonaws.com/dev?username=ana&displayName=Ana"
> {"action":"heartbeat","requestId":"0b6d2c1e-7f0e-4a51-9d3a-1c2f6a8e4b77"}
< {"type":"pong","requestId":"0b6d2c1e-7f0e-4a51-9d3a-1c2f6a8e4b77"}
```
