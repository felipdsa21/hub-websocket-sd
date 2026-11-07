# Backend

Infraestrutura e Lambdas do Hub Colaborativo WebSocket, declaradas com o AWS CDK. A arquitetura está em [docs/arquitetura.md](../docs/arquitetura.md).

Há um stack por estágio, `HubWebSocket-dev` e `HubWebSocket-prod`, na região `sa-east-1`. O código das Lambdas fica em `functions/`, e o stack, em `lib/`.

Por enquanto, estão implementadas as rotas `$connect`, `$disconnect`, `$default` e `heartbeat`. As demais rotas de aplicação caem na `$default` até serem implementadas.

## Desenvolvimento

```sh
npm ci
npm run build   # verificação de tipos
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
