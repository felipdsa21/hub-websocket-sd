# Backend

Infraestrutura e Lambdas do Hub Colaborativo WebSocket, declaradas com o AWS CDK. A arquitetura está em [docs/arquitetura.md](../docs/arquitetura.md).

Há um stack por estágio, `HubWebSocket-dev` e `HubWebSocket-prod`, na região `sa-east-1`. O código das Lambdas fica em `functions/`, e o stack, em `lib/`.

Estão implementadas as rotas `$connect`, `$disconnect`, `$default`, `heartbeat`, `sync`, `sendMessage`, `openDirect`, `createGroup`, `addMember`, `leaveGroup`, `getHistory` e `search` (em Lambdas ARM64 com IAM de menor privilégio e throttling no estágio), os anúncios de presença em tempo real (no `$connect`, no desvínculo e na refeitura pelo `presenceSweeper`), a Lambda `presenceSweeper` (expiração de conexões inativas em passagem única por minuto, limpeza de ids órfãos e métrica `OpenConnections`), logs JSON com identificadores anonimizados via HMAC-SHA256 (SSM Parameter Store, retenção de 14 dias em `dev` e 30 dias em `prod`), painel e alarmes no CloudWatch (`HubWebSocket-<estágio>`) e hospedagem do frontend em S3 privado com CloudFront (OAC, cabeçalhos de segurança HTTP e `index.html`/`config.json` sem cache).

## Desenvolvimento

```sh
npm ci
npm run build   # verificação de tipos
npm run lint
npm test
npx cdk synth HubWebSocket-dev
```

## Implantação

A GitHub Actions implanta o `dev` a cada push na `develop` e o `prod` a cada push na `main`, depois que a CI passa; o `prod` aguarda aprovação no environment `prod` do GitHub. Ela entra na AWS por OIDC, assumindo o papel do stack `HubWebSocket-GitHubOidc`, que só pode assumir os papéis criados pelo `cdk bootstrap`. Como os logs de um repositório público ficam abertos a qualquer pessoa logada no GitHub, o job oculta as URLs do estágio; elas continuam nas saídas do stack (`aws cloudformation describe-stacks --region sa-east-1 --stack-name HubWebSocket-<estágio> --query "Stacks[0].Outputs"`).

Tudo o que um deploy cria, pela Actions ou à mão, fica sob o permissions boundary `HubWebSocket-DeployBoundary`, do mesmo stack: só os serviços que o projeto usa, sem alterar o caminho de deploy e sem criar usuários, chaves de acesso ou provedores de identidade. O `HubWebSocket-GitHubOidc` é implantado à mão, com as suas próprias credenciais e fora do boundary; um serviço novo no projeto entra na lista do boundary e chega à conta por esse deploy.

### Configuração inicial

Com as credenciais da AWS configuradas (`aws configure`), uma vez por conta e região:

```sh
npx cdk bootstrap aws://<conta>/sa-east-1
```

Antes do primeiro deploy de cada estágio (`dev` e `prod`), crie o segredo HMAC usado na anonimização dos logs (arquitetura, seção 5):

```sh
aws ssm put-parameter \
  --region sa-east-1 \
  --name /hub-websocket/dev/log-hmac-secret \
  --type SecureString \
  --value "$(openssl rand -hex 32)"
```

Para a GitHub Actions, implante o papel OIDC e guarde a saída `DeployRoleArn` em uma variável do repositório. Se a conta já tiver o provedor OIDC do GitHub, passe também o ARN dele com `-c githubOidcProviderArn=<arn>`.

```sh
npx cdk deploy HubWebSocket-GitHubOidc -c githubSubjectPrefix=$(gh api repos/{owner}/{repo}/actions/oidc/customization/sub --jq .sub_claim_prefix)
gh variable set AWS_DEPLOY_ROLE_ARN --body <DeployRoleArn>
```

Em seguida, refaça o bootstrap para aplicar o boundary, que o stack acima acabou de criar, ao papel de execução do CloudFormation:

```sh
npx cdk bootstrap aws://<conta>/sa-east-1 --custom-permissions-boundary HubWebSocket-DeployBoundary
```

Por fim, crie no GitHub os environments `dev`, restrito ao branch `develop`, e `prod`, restrito ao branch `main` e com revisor obrigatório.

### Deploy manual

Compile o frontend (para que o `BucketDeployment` publique os arquivos estáticos junto com o `config.json` gerado automaticamente a partir de `WebSocketUrl`) e implante o stack:

```sh
(cd ../frontend && npm ci && npm run build)
npx cdk deploy HubWebSocket-dev
```

As saídas trazem `WebSocketUrl` (endereço `wss://` do estágio), `FrontendUrl` (URL HTTPS pública do CloudFront) e `DashboardName` (painel no CloudWatch).

## Teste manual

```sh
npx wscat -c "wss://<api-id>.execute-api.sa-east-1.amazonaws.com/dev?username=ana&displayName=Ana"
> {"action":"heartbeat","requestId":"0b6d2c1e-7f0e-4a51-9d3a-1c2f6a8e4b77"}
< {"type":"pong","requestId":"0b6d2c1e-7f0e-4a51-9d3a-1c2f6a8e4b77"}
```
