# Arquitetura distribuída e esquema de nomeação

**Projeto:** Hub Colaborativo WebSocket

## 1. Introdução

Este documento define a arquitetura distribuída do Hub Colaborativo WebSocket e o esquema de nomeação e endereçamento: como um usuário ou uma conversa é resolvido nas conexões WebSocket abertas e como uma requisição chega ao backend e volta aos clientes. Os requisitos citados (RF, RNF, R e L) estão na [especificação](especificacao.md).

O ciclo de vida da sessão, com os diagramas de sequência de `$connect` e `$disconnect`, fica para o documento da fase 3.

Os IDs das decisões (D) são estáveis, e o número de um item removido não é reaproveitado.

## 2. Arquitetura

```mermaid
flowchart LR
    subgraph Navegadores
        A["Cliente web<br/>(usuário A)"]
        B["Cliente web<br/>(usuário B)"]
    end

    CDN["CloudFront + S3<br/>cliente web estático"]
    GW["API Gateway<br/>API WebSocket<br/>estágio dev / prod"]

    subgraph Lambda
        LC["connect"]
        LD["disconnect"]
        LF["default"]
        LA["app<br/>rotas de aplicação"]
        LS["presenceSweeper"]
    end

    DB[("DynamoDB<br/>Users · Connections<br/>Conversations · Memberships<br/>Messages")]
    EB["EventBridge<br/>a cada 1 minuto"]
    CW["CloudWatch<br/>logs · métricas · painel"]
    SSM["SSM Parameter Store<br/>segredo dos logs"]

    A & B -->|"HTTPS (página)"| CDN
    A & B <-->|"wss://"| GW
    GW -->|"rotas"| Lambda
    Lambda -->|"POST / DELETE @connections"| GW
    EB --> LS
    Lambda -->|"lê e grava"| DB
    Lambda -->|"lê no início a frio"| SSM
    Lambda -.->|"logs e métricas"| CW
```

| Componente | Papel |
| --- | --- |
| Cliente web | Aplicação Angular servida pelo CloudFront a partir de um bucket S3 (RNF07). Abre uma conexão WebSocket por aba, envia as requisições e mantém a fila de reenvio (RF12) e o heartbeat (RF08). |
| API Gateway | API WebSocket com a route selection expression `$request.body.action`. Encaminha cada rota a uma Lambda e expõe a Management API (`@connections`) para o envio aos clientes. |
| Lambda `connect` | Rota `$connect`: valida o nome de usuário e vincula a conexão ao usuário (RF01). |
| Lambda `disconnect` | Rota `$disconnect`: desvincula a conexão (RF01, RF07). |
| Lambda `default` | Rota `$default`: responde com erro às requisições sem rota (RF09). |
| Lambda `app` | Todas as rotas de aplicação (seção 4), escolhidas internamente pelo `routeKey`. |
| Lambda `presenceSweeper` | Acionada a cada minuto pelo EventBridge; desvincula as conexões sem requisições há 10 minutos (RF07, R01) e publica o número de conexões abertas (seção 5). |
| DynamoDB | Diretório de nomes (usuários e conexões), conversas, participações e mensagens (seção 3.3). |
| SSM Parameter Store | Segredo usado para anonimizar os identificadores nos logs (seção 5). |
| CloudWatch | Logs com identificadores anonimizados (RNF03), métricas e painel (RNF06). |

As Lambdas são escritas em TypeScript, no runtime Node.js, e empacotadas pelo CDK. A `app` tem tempo limite de 10 s, do qual depende a sobreposição da reconexão (seção 4.4). Todas recebem permissão de leitura e gravação nas tabelas, `execute-api:ManageConnections` no estágio (R04) e `ssm:GetParameter` no segredo dos logs; o `presenceSweeper` recebe também `cloudwatch:PutMetricData`.

Toda a infraestrutura é declarada no stack do AWS CDK em `backend/` (RNF05). Há um stack por estágio, `dev` para desenvolvimento e `prod` para a apresentação, cada um com as próprias tabelas, na região `sa-east-1` (D07).

## 3. Esquema de nomeação e endereçamento

### 3.1 Nomes

O cronograma fala em *userId* e *sala*; neste projeto, eles correspondem ao nome de usuário (`username`) e à conversa (`conversationId`).

| Nome | Quem gera | Formato | Escopo e duração | Identifica |
| --- | --- | --- | --- | --- |
| `username` | o usuário, no `$connect` | `^[a-z0-9._-]{3,32}$`, convertido para minúsculas | único no estágio; permanente | o usuário |
| `displayName` | o usuário, no `$connect` | 1 a 50 caracteres, sem espaços nas pontas | o do último `$connect` (RF01) | nada; é só um rótulo |
| `connectionId` | o API Gateway | opaco | uma conexão; até 2 horas (L02) | o ponto de entrega de uma aba |
| `conversationId` | o backend | chat privado: `d:<username1>:<username2>`, em ordem alfabética; grupo: `g:<UUID v4>` | permanente | a conversa |
| `messageId` | o cliente | UUID v4 (`crypto.randomUUID()`) | único por remetente | a mensagem do remetente, inclusive nos reenvios (RF12) |
| `requestId` | o cliente | UUID v4 | uma requisição | a requisição, para associar a ela a resposta ou o erro (RF09) |

O `:` não é aceito no nome de usuário, então um `conversationId` nunca é ambíguo. O nome de exibição não identifica nada, porque se repete entre usuários (RF05) e muda a cada conexão (RF01).

### 3.2 Resolução

O backend resolve nomes nos dois sentidos:

```text
envio aos clientes (fan-out):
  conversationId ──Conversations.members──► usernames ──Users.connections──► connectionIds ──► URI @connections

requisição recebida:
  connectionId (do requestContext) ──Connections.username──► username ──► autorização (RNF01)
```

A URI de uma conexão não é guardada; ela é derivada do `connectionId` e da URL de callback do estágio, que o CDK entrega às Lambdas pela variável de ambiente `CALLBACK_URL`:

```text
CALLBACK_URL = https://{api-id}.execute-api.sa-east-1.amazonaws.com/{estágio}
URI          = {CALLBACK_URL}/@connections/{connectionId}
```

| Método na URI | Comando | Uso |
| --- | --- | --- |
| `POST` | `postToConnection` | entregar um evento ao cliente |
| `DELETE` | `deleteConnection` | encerrar a conexão (`presenceSweeper`) |
| `GET` | `getConnection` | consultar a conexão (diagnóstico) |

Um `POST` ou `DELETE` para uma conexão que não existe mais responde `410 Gone` (`GoneException`), e o backend desvincula a conexão (seção 3.4).

O backend nunca confia em um nome de usuário vindo no corpo de uma requisição. O usuário de cada requisição é sempre o que está vinculado ao `connectionId`, que o API Gateway informa e o cliente não consegue falsificar.

### 3.3 Diretório (DynamoDB)

As tabelas usam cobrança sob demanda. As leituras do diretório e dos membros são fortemente consistentes, para que uma conexão ou um membro recém-adicionado entre no próximo fan-out (D04).

**Connections**: conexão → usuário.

| Atributo | Tipo | Descrição |
| --- | --- | --- |
| `connectionId` | S (PK) | identificador da conexão |
| `username` | S | usuário vinculado |
| `connectedAt` | N | instante do `$connect`, em ms |
| `lastSeenAt` | N | instante da última requisição, em ms (RF07) |
| `expiresAt` | N (TTL) | `connectedAt` + 3 horas; só faxina de registros esquecidos |

**Users**: usuário → conexões.

| Atributo | Tipo | Descrição |
| --- | --- | --- |
| `username` | S (PK) | nome de usuário |
| `displayName` | S | nome de exibição atual |
| `connections` | SS | `connectionId`s abertos; ausente quando o usuário está offline |
| `createdAt` | N | primeira conexão |

**Conversations**: conversa → membros.

| Atributo | Tipo | Descrição |
| --- | --- | --- |
| `conversationId` | S (PK) | identificador da conversa |
| `type` | S | `direct` ou `group` |
| `name` | S | nome do grupo; ausente no chat privado |
| `members` | SS | nomes de usuário dos membros |
| `started` | BOOL | chat privado: já tem mensagem (RF10) |
| `lastMessageAt` | N | instante da última mensagem |

**Memberships**: usuário → conversas visíveis (RF10).

| Atributo | Tipo | Descrição |
| --- | --- | --- |
| `username` | S (PK) | membro |
| `conversationId` | S (SK) | conversa |
| `joinedAt` | N | entrada na conversa |

**Messages**: histórico de cada conversa (RF06).

| Atributo | Tipo | Descrição |
| --- | --- | --- |
| `conversationId` | S (PK) | conversa |
| `sk` | S (SK) | mensagem: `m#<sentAt com 13 dígitos>#<sender>#<messageId>`; marcador de duplicata: `id#<sender>#<messageId>` |
| `messageId` | S | identificador gerado pelo cliente |
| `sender` | S | nome de usuário do remetente |
| `text` | S | texto |
| `sentAt` | N | `requestContext.requestTimeEpoch`: o instante em que o API Gateway recebeu a requisição (RF02) |
| `ref` | S | só no marcador de duplicata: o `sk` da mensagem original |

Os membros de uma conversa ficam em `Conversations.members`, lido em uma única leitura consistente; a tabela `Memberships` existe para listar as conversas de um usuário. As duas são alteradas juntas, em uma transação.

### 3.4 Vínculo e desvínculo de conexões

**Vincular** (`$connect`):

1. Validar `username` e `displayName` da query string; sem nome de usuário válido, a Lambda responde `400` e o handshake falha (RF01). Sem nome de exibição, vale o nome de usuário.
2. Gravar `Connections[connectionId]`, com `lastSeenAt` igual a `connectedAt`.
3. Em `Users[username]`, adicionar o `connectionId` ao conjunto `connections` (`ADD`) e gravar o `displayName`, pedindo os valores antigos. Se o conjunto antigo estava vazio, o usuário acabou de ficar online.
4. Se o usuário ficou online ou mudou de nome de exibição, avisar os contatos (seção 3.5).

O `$connect` não envia nada à conexão que está abrindo, porque o API Gateway só aceita `postToConnection` para ela depois que o handshake termina; os contatos, cujas conexões já estão abertas, podem ser avisados. Por isso, o cliente pede o próprio estado inicial (conversas e presença dos contatos) com a requisição `sync` logo após abrir a conexão.

**Desvincular** é um procedimento único, chamado pelo `$disconnect`, pelo `GoneException` no fan-out (RF08) e pelo `presenceSweeper` (RF07):

1. Ler `Connections[connectionId]` para obter o `username`. Se não há item, a conexão já foi desvinculada, e o procedimento termina.
2. Em `Users[username]`, remover o `connectionId` do conjunto (`DELETE`) com a condição `contains(connections, :connectionId)`, pedindo os valores novos. Se a condição falha, outro caminho já removeu o id. Se ela passa e o conjunto ficou vazio, o DynamoDB remove o atributo, e o usuário acabou de ficar offline: anunciar aos contatos.
3. Apagar `Connections[connectionId]`.

Como só um chamador passa na condição do passo 2, a mudança para offline é anunciada uma única vez, mesmo com os três caminhos em paralelo. Operações `ADD` e `DELETE` sobre um conjunto são atômicas, então conexões de abas diferentes do mesmo usuário não se atropelam.

A ordem dos passos mantém uma regra: todo id em `Users.connections` tem um item em `Connections`, porque o vínculo grava o item antes de incluir o id, e o desvínculo retira o id antes de apagar o item. Se uma Lambda falha no meio do desvínculo, o item continua em `Connections`, e o `presenceSweeper` refaz o desvínculo em até 11 minutos após a última requisição. Se uma Lambda falha no meio do vínculo, o handshake falha, e sobra só um item em `Connections` fora do conjunto, que o `presenceSweeper` apaga sem anunciar nada (D09).

**Expiração por inatividade** (RF07): toda requisição, de qualquer rota além de `$connect` e `$disconnect` (inclusive `heartbeat`, `sync`, `search` e as que caem na `$default`), atualiza `Connections.lastSeenAt` com a condição `attribute_exists(connectionId)`, que impede recriar o item de uma conexão já desvinculada. A mesma atualização devolve o item e, com ele, o `username` (seção 3.2). A cada minuto, o `presenceSweeper` lê as conexões com `lastSeenAt` de mais de 10 minutos atrás, encerra cada uma com `DELETE @connections` (ignorando o `410`) e a desvincula. O offline é anunciado, assim, entre 10 e 11 minutos após a última requisição. O TTL do DynamoDB não serve para isso, porque apaga os itens sem prazo garantido e sem avisar ninguém (D05).

### 3.5 Contatos

Os avisos de presença (RF07) e de troca de nome de exibição (RF01) vão aos *contatos* do usuário: os membros de todas as conversas visíveis dele. A resolução é `Memberships[username]` → `Conversations.members` de cada conversa → `Users.connections` de cada contato.

## 4. Roteamento de requisições

### 4.1 Rotas

O API Gateway escolhe a rota pelo campo `action` da requisição (route selection expression `$request.body.action`). Toda requisição de aplicação leva também um `requestId`.

| Rota (`action`) | Lambda | Campos | Requisitos |
| --- | --- | --- | --- |
| `$connect` | connect | query string: `username`, `displayName` | RF01 |
| `$disconnect` | disconnect | — | RF01, RF07 |
| `$default` | default | — | RF09 |
| `sync` | app | `since` (opcional, instante em ms) | RF07, RF08, RF10 |
| `heartbeat` | app | — | RF07, RF08 |
| `sendMessage` | app | `conversationId`, `messageId`, `text` | RF02, RF11, RF12 |
| `openDirect` | app | `username` | RF03 |
| `createGroup` | app | `name`, `members` | RF04 |
| `addMember` | app | `conversationId`, `username` | RF04 |
| `leaveGroup` | app | `conversationId` | RF04 |
| `getHistory` | app | `conversationId`, `before` ou `after` (opcional, um `sk`) | RF06, RF08 |
| `search` | app | `query` | RF05 |

Exemplo:

```json
{
  "action": "sendMessage",
  "requestId": "0b6d2c1e-7f0e-4a51-9d3a-1c2f6a8e4b77",
  "conversationId": "d:antonio:wallyson",
  "messageId": "5f3c9a10-2b7d-4e8f-a6c1-9d0e7b4a2f13",
  "text": "Olá!"
}
```

Em toda requisição, a Lambda `app` atualiza `lastSeenAt` e resolve o usuário pela conexão (seções 3.2 e 3.4); a Lambda `default` faz o mesmo antes de responder com erro. Antes de qualquer ação sobre uma conversa, a Lambda `app` confere também se o usuário está em `Conversations.members` (RNF01).

### 4.2 Eventos enviados ao cliente

Tudo o que o cliente recebe, inclusive as respostas às próprias requisições, chega por `postToConnection` (D06). Todo evento tem um campo `type`.

| `type` | Quando | Campos principais |
| --- | --- | --- |
| `response` | resposta a uma requisição | `requestId`, `data` |
| `error` | requisição recusada (RF09) | `requestId` (quando houver), `messageId` (quando a requisição é uma mensagem, RF12), `code`, `message` |
| `pong` | resposta ao heartbeat | `requestId` |
| `message` | nova mensagem em uma conversa (RF02) | `conversationId`, `sk`, `messageId`, `sender`, `text`, `sentAt` |
| `presence` | mudança de presença de um contato (RF07) | `username`, `online`, `at` |
| `displayName` | troca de nome de exibição de um contato (RF01) | `username`, `displayName` |
| `conversationAdded` | conversa nova visível (RF10) | `conversation`, com os membros e o `displayName` e o `online` de cada um |
| `conversationRemoved` | saída de um grupo (RF04) | `conversationId` |
| `memberJoined` | entrada de membro (RF04, RF07) | `conversationId`, `username`, `displayName`, `online` |
| `memberLeft` | saída de membro (RF04) | `conversationId`, `username` |

O evento `presence` leva o instante da mudança (`at`), e o cliente ignora um evento mais antigo que o último recebido para o mesmo usuário, já que dois avisos podem chegar fora de ordem.

Os membros de uma conversa sempre chegam com o nome de exibição e o estado de presença: em `conversationAdded`, em `memberJoined` e nas respostas de `sync`, `openDirect` e `createGroup`. Assim, o cliente recebe a presença de quem surge em uma das suas conversas (RF07).

Um evento `message` de uma conversa que o cliente ainda não conhece pode chegar antes do `conversationAdded` dela (seção 4.3); nesse caso, o cliente pede `sync` em vez de descartar a mensagem.

### 4.3 Roteamento de uma mensagem

```mermaid
sequenceDiagram
    participant A as Cliente de A (cA)
    participant G as API Gateway
    participant L as Lambda app
    participant D as DynamoDB
    participant B as Clientes de B (cB1, cB2)

    A->>G: sendMessage (conversationId, messageId, text)
    G->>L: evento com routeKey, connectionId = cA, requestTimeEpoch
    L->>D: Connections[cA]: atualiza lastSeenAt → username = a
    L->>D: Conversations[conversationId] → members = {a, b}
    Note over L: a está em members? (RNF01)
    L->>D: transação: marcador id + mensagem m
    L->>D: Conversations: lastMessageAt = sentAt, se maior
    L->>D: Users[a, b] → connections = {cA, cB1, cB2}
    par para cada conexão
        L->>G: POST @connections/cB1 e cB2
        G-->>B: message
    and
        L->>G: POST @connections/cA
        G-->>A: message (confirmação)
    end
    Note over L,G: 410 Gone → desvincular a conexão (seção 3.4) e seguir com as demais
```

1. A Lambda resolve o remetente pelo `connectionId` e confere se ele é membro da conversa.
2. Grava, em uma única transação, o marcador `id#<sender>#<messageId>` (com a condição de que ainda não exista) e a mensagem `m#<sentAt>#<sender>#<messageId>`. Como o marcador inclui o remetente, outro usuário pode usar o mesmo `messageId` sem que sua mensagem seja tomada por um reenvio (T7).
3. Se a transação é cancelada, a Lambda olha o motivo de cada item:
   - `ConditionalCheckFailed` no marcador: é um reenvio da fila do cliente (RF12, R07). A Lambda lê a mensagem original pelo `ref` do marcador, refaz os passos 4 e 5 com ela, que não têm efeito se já foram feitos, e a envia só à conexão que reenviou, como confirmação.
   - `TransactionConflict`: outra transação sobre o mesmo marcador está em andamento, como a do original de um reenvio que chegou antes de ele terminar. A Lambda repete a transação após uma espera curta, até 3 vezes, e o resultado cai em um dos outros casos. O mesmo tratamento vale para todas as transações do backend.
4. Atualiza `Conversations.lastMessageAt` para o `sentAt`, com a condição de que o valor atual seja menor ou ausente, e ignora a falha da condição. Essa gravação fica fora da transação para que envios simultâneos na mesma conversa não entrem em conflito no item da conversa (R06, T8).
5. No primeiro envio de um chat privado (`started` falso na leitura do passo 1), a Lambda cria a participação do outro usuário e marca `started` com a condição de que ainda seja falso. Só a Lambda que vence essa condição envia `conversationAdded` ao outro usuário, antes da mensagem (RF10), então duas primeiras mensagens simultâneas não geram o aviso em dobro.
6. Resolve as conexões de todos os membros e envia o evento `message` a cada uma, em paralelo. Um `410 Gone` desvincula aquela conexão e não interrompe as demais (RF08).

Refazer os passos 4 e 5 no reenvio cobre uma Lambda que falha depois da transação: sem isso, o outro usuário de um chat privado nunca receberia a participação e não veria a conversa. A mensagem em si não é entregue de novo aos demais (RF12); eles a recebem pelo histórico.

### 4.4 Ordem e reconexão

A ordem de uma conversa é a ordem do `sk` (`sentAt` e, no empate, remetente e `messageId`). O cliente insere cada mensagem recebida na posição do `sk` e descarta uma mensagem que já tem (mesmo remetente e `messageId`), então todos os clientes exibem a mesma ordem (RNF04), mesmo que as entregas de duas Lambdas cheguem em ordem diferente.

Ao reconectar (RF08), o cliente envia `sync` com `since` igual ao instante da última mensagem que recebeu menos 30 segundos, e o `sync` aponta as conversas com `lastMessageAt` posterior a ele. Para cada uma, o cliente pede `getHistory` com `after` igual ao último `sk` que tem, recuado também em 30 segundos. A sobreposição cobre uma mensagem gravada depois de outra com `sentAt` maior: o `sentAt` é o instante em que o API Gateway recebeu a requisição, e a gravação pode acontecer até o fim do início a frio e do tempo limite de 10 s da Lambda `app`. As repetidas são descartadas pelo remetente e `messageId`, e nada se perde nem aparece duas vezes.

As mensagens pendentes são reenviadas uma por vez, cada uma após a confirmação da anterior (RF12). Reenviadas juntas, duas mensagens poderiam ter o mesmo `sentAt`, e o desempate pelo `messageId` inverteria a ordem original.

O histórico é enviado em páginas de até 50 mensagens e até 28 KB. A cota de frame de 32 KB vale também para os envios por `@connections`, e a documentação não diz se o API Gateway divide em frames um envio maior; o T5 mostra o comportamento real (RF06).

## 5. Logs e métricas

Cada Lambda escreve uma linha JSON por requisição (RNF03) com a rota, o resultado, o código de erro e a duração. Os identificadores (`connectionId`, `username` e `conversationId`) aparecem anonimizados como os 12 primeiros caracteres hexadecimais de `HMAC-SHA256(segredo, valor)`. O segredo fica no SSM Parameter Store e é o mesmo em todas as Lambdas do estágio, então um mesmo identificador gera sempre o mesmo valor anonimizado e os logs continuam correlacionáveis. O texto das mensagens nunca é registrado.

O segredo é um parâmetro `SecureString` criado uma vez por estágio, fora do CDK, porque o CloudFormation não cria parâmetros desse tipo e o valor não pode ficar no repositório. O stack só referencia o parâmetro pelo nome e concede a leitura; cada Lambda o lê no início a frio.

O painel (RNF06) usa as métricas que o API Gateway publica para a API WebSocket (`ConnectCount`, `MessageCount`, `IntegrationError`, `ClientError`, `ExecutionError` e `IntegrationLatency`) e as métricas das Lambdas. O API Gateway não publica o número de conexões abertas, então o `presenceSweeper`, que já percorre `Connections` a cada minuto, publica essa contagem como métrica própria.

## 6. Decisões

- **D01 – Lambda e DynamoDB:** backend sem servidor, sem VPC e com cobrança por uso, que é a arquitetura mínima do tema. Um Redis guardaria o diretório com menor latência, mas exigiria VPC e um nó sempre ligado.
- **D02 – Uma Lambda para as rotas de aplicação:** as rotas de aplicação compartilham a mesma Lambda `app`, o que reduz os inícios a frio (R05) e o código repetido. `$connect`, `$disconnect` e `$default` ficam em Lambdas próprias, porque têm entradas e permissões diferentes. O log registra o `routeKey`, então as rotas continuam distinguíveis (RNF03).
- **D03 – `conversationId` determinístico no chat privado:** `d:<username1>:<username2>` em ordem alfabética garante um único chat por par (RF03) com uma gravação condicional, mesmo que os dois usuários o iniciem ao mesmo tempo.
- **D04 – Conjuntos no item em vez de índices secundários:** os índices secundários globais do DynamoDB só têm leitura eventualmente consistente, e uma conexão recém-aberta ou um membro recém-adicionado poderia ficar de fora de um fan-out. Os conjuntos `Users.connections` e `Conversations.members` são lidos de forma consistente e alterados atomicamente. Isso vale enquanto os conjuntos forem pequenos (o item tem limite de 400 KB), o que é o caso do projeto.
- **D05 – `presenceSweeper` em vez de TTL:** o RF07 exige anunciar o offline em até 1 minuto, e o TTL do DynamoDB não tem prazo nem gera aviso. O TTL fica só como faxina.
- **D06 – Todos os eventos por `@connections`:** as respostas às requisições também usam `postToConnection`, em vez da resposta da integração da rota. O cliente tem um único caminho de recebimento, e o custo é uma chamada a mais por requisição.
- **D07 – Região `sa-east-1`:** os clientes e a demonstração estão no Brasil, e a região de São Paulo reduz a latência de rede (RNF02).
- **D08 – Cliente no S3 com CloudFront:** o cliente estático fica no mesmo stack do CDK que o backend (RNF05) e é servido por HTTPS (RNF07).
- **D09 – Desvínculo em passos ordenados em vez de transação:** uma transação no DynamoDB não devolve os valores novos, então não diria qual chamador deixou o conjunto vazio, e o offline poderia ser anunciado mais de uma vez. A ordem dos passos e a condição `contains` (seção 3.4) garantem um único anúncio, e uma falha no meio fica para o `presenceSweeper` terminar.

## 7. Limitações do esquema

- A pesquisa de usuários (RF05) e o `presenceSweeper` percorrem a tabela inteira (`Scan`). Com o número de usuários do projeto isso é barato; com muitos usuários, seriam necessários um índice de pesquisa e um índice por `lastSeenAt`.
- O fan-out faz uma chamada por conexão de cada destinatário (R06). O custo cresce com o tamanho do grupo e com o número de abas abertas.
- Uma mensagem perto do limite do RF11 gera um evento `message` acima de 32 KB. Se o API Gateway não dividir em frames os envios por `@connections` (seção 4.4), o limite do RF11 terá de baixar; o T2 e o T5 mostram o comportamento real.
