# Sincronização, consistência e ciclo de vida das conversas

**Projeto:** Hub Colaborativo WebSocket

## 1. Introdução

Este documento explica os mecanismos distribuídos que garantem a ordenação das mensagens de cada conversa, a idempotência contra reenvios, o modelo de consistência de leitura e escrita no DynamoDB e o ciclo de vida das conversas privadas, grupos e histórico paginado. Os requisitos citados (RF, RNF, R, L e T) estão definidos na [especificação](especificacao.md), e este texto ilustra e aprofunda os mecanismos detalhados na [arquitetura](arquitetura.md), que continua sendo a referência.

## 2. Sincronização temporal e ordem das mensagens

### 2.1 Autoridade temporal do servidor (RF02, RNF04)

Em sistemas distribuídos baseados em navegadores web, os relógios locais dos clientes (`Date.now()`) sofrem desvios arbitrários (_clock skew_) decorrentes de configurações manuais do sistema operacional, fusos horários incorretos ou falta de sincronização NTP. Confiar no timestamp gerado pelo cliente permitiria que mensagens enviadas posteriormente aparecessem antes de mensagens anteriores ou fossem inseridas no passado da linha do tempo.

Para eliminar essa dependência, o sistema adota a **autoridade temporal centralizada no servidor**:

- **Carimbo de tempo oficial (`sentAt`):** Atribuído exclusivamente pelo backend utilizando `requestContext.requestTimeEpoch` (em milissegundos), registrado pelo Amazon API Gateway no instante em que o frame da requisição chega à borda da infraestrutura.
- **Imutabilidade temporal:** O cliente nunca envia ou altera o campo `sentAt`. O timestamp retornado pelo servidor no evento `message` torna-se o valor definitivo para todos os participantes e abas conectadas.

### 2.2 Chave de ordenação determinística (sk)

Na tabela `Messages`, cada mensagem persistida recebe uma _Sort Key_ (`sk`) composta e determinística no formato:

    m#<sentAt com 13 dígitos preenchidos com zero à esquerda>#<sender>#<messageId>

**Exemplo:** `m#1731542400123#wallyson#550e8400-e29b-41d4-a716-446655440000`

Essa estrutura estabelece uma **ordem total estrita** entre todas as mensagens de uma mesma conversa (`PK = conversationId`), utilizando três níveis de desempate lexicográfico:

1. **`sentAt` (13 dígitos):** Garante ordenação cronológica exata pela chegada ao API Gateway (o preenchimento com zeros à esquerda preserva a ordem lexicográfica em strings).
2. **`sender`:** Caso dois usuários distintos enviem mensagens que cheguem exatamente no mesmo milissegundo (`sentAt` idêntico), o nome de usuário normalizado desempata a posição de forma determinística.
3. **`messageId` (UUID v4):** Caso o mesmo usuário dispare duas mensagens distintas no mesmo milissegundo, o identificador único gerado pelo cliente elimina qualquer ambiguidade residual.

**Convergência no Cliente (RNF04):** Devido a variações de latência de rede ou _fan-out_ paralelo entre múltiplas conexões, diferentes clientes podem receber os eventos `message` fora da ordem cronológica. Ao receber qualquer evento `message`, o cliente insere o item na lista local ordenando estritamente pela chave `sk` e descartando a mensagem que já tem, pelo mesmo `sender` e `messageId`, o que também casa a confirmação com a mensagem pendente, que ainda não tem `sk`. Dessa forma, sem necessidade de coordenação entre clientes, todas as abas e participantes convergem para a mesma sequência de mensagens.

### 2.3 Janela de sobreposição na reconexão (sync e getHistory)

Em um ambiente _serverless_ (AWS Lambda), uma requisição recebida pelo API Gateway no instante t1 pode sofrer atraso de inicialização (_cold start_) ou contenção de CPU até o limite de execução de 10 segundos da Lambda `app`, sendo gravada no DynamoDB alguns milissegundos ou segundos após outra requisição recebida em t2 > t1.

Se um cliente reconectado solicitasse apenas mensagens posteriores ao instante exato da sua última sincronização, uma mensagem recebida antes da queda, mas persistida depois, poderia ser omitida. Para mitigar esse cenário (RF08):

- O cliente envia `sync` com `since` igual ao maior entre o `sentAt` da última mensagem recebida e o instante do último `sync`, menos 30 segundos, e pede `getHistory` com `after` recuado também em 30 segundos para cada conversa que o `sync` aponta (seção 4.4 da arquitetura).
- As mensagens já conhecidas dentro dessa janela de sobreposição são deduplicadas localmente pelo `sender` e pelo `messageId`, enquanto eventuais mensagens gravadas com atraso são incorporadas na posição cronológica correta.

## 3. Deduplicação e idempotência (RF12, R07)

### 3.1 Separação entre marcador de idempotência e registro de mensagem

Redes móveis e conexões WebSocket estão sujeitas a quedas silenciosas entre o envio do frame pelo cliente e o recebimento da confirmação pelo servidor. Se o cliente reenviar uma mensagem cuja primeira tentativa já foi persistida, o sistema deve impedir a duplicação no histórico sem retornar erro ao usuário.

A partição `PK = conversationId` na tabela `Messages` guarda, para cada mensagem, o item da mensagem, com o `sk` `m#…`, e um marcador `id#<sender>#<messageId>`, cujo `ref` aponta para o `sk` da mensagem. O marcador recebe TTL de 7 dias (`expiresAt`, em segundos) para limitar seu acúmulo sem remover os itens `m#…`, que permanecem permanentemente no histórico. O prefixo `id#` inclui explicitamente `<sender>` para garantir que dois usuários distintos que eventualmente gerem o mesmo UUID (`messageId`) não colidam entre si (T7).

### 3.2 Fluxo transacional de escrita e tratamento de reenvios

A gravação da mensagem e do seu marcador ocorre em uma única operação atômica (`TransactWriteItems`) com condição de inexistência (`attribute_not_exists(sk)`) em ambos os itens:

```mermaid
sequenceDiagram
    autonumber
    actor C as Cliente Remetente
    participant GW as API Gateway
    participant L as Lambda app
    participant DB as DynamoDB
    actor M as Demais Membros

    C->>GW: sendMessage
    GW->>L: Invoca com requestTimeEpoch
    L->>DB: TransactWriteItems Put id e Put m

    alt Sucesso primeira entrega
        DB-->>L: Transação confirmada
        L->>DB: Atualiza lastMessageAt/lastMessageBy e revela ocultas
        L-->>C: Evento message confirmação
        L-->>M: Evento message fan-out
    else ConditionalCheckFailed reenvio
        DB-->>L: Marcador id já existe
        L->>DB: GetItem marcador id e mensagem m
        L->>DB: Refaz lastMessageAt/lastMessageBy e revela ocultas
        L-->>C: Reenvia evento message só à conexão que reenviou
    else TransactionConflict concorrência
        DB-->>L: Conflito de transação
        L->>L: Retry com backoff curto até 3x
        alt Conflito persiste
            L->>DB: GetItem marcador id
            Note over L,C: Se id existe, segue como reenvio; senão, não responde e cliente reenvia
        end
    end
```

**Controle de Fila no Cliente:** Quando offline ou aguardando confirmação, o cliente enfileira as mensagens localmente por conversa e as envia **uma por vez** — iniciando imediatamente ao reconectar e disparando a próxima logo após a confirmação da anterior (com timeout de 15 segundos sem confirmação para reenvio enquanto conectado). O envio sequencial evita que duas mensagens pendentes da mesma conversa cheguem ao API Gateway no mesmo milissegundo durante uma rajada de reconexão e tenham sua ordem relativa alterada pelo desempate do `messageId`.

## 4. Modelo de consistência no DynamoDB

### 4.1 Leituras fortemente consistentes e ausência de GSIs (D04)

Em sistemas de tempo real, uma leitura eventualmente consistente pode retornar dados obsoletos logo após uma escrita — por exemplo, ignorar uma conexão recém-registrada em `Users.connections` durante um _fan-out_ ou omitir um membro recém-adicionado a um grupo.

Por esse motivo, o projeto adota duas diretrizes rigorosas:

1. **Consistência forte em todas as leituras:** Toda chamada `GetItem`, `BatchGetItem`, `Query` e `Scan` nas tabelas `Connections`, `Users`, `Conversations`, `Memberships` e `Messages` é executada com `ConsistentRead: true`.
2. **Proibição de Índices Secundários Globais (GSIs — D04):** O DynamoDB não suporta `ConsistentRead: true` em GSIs. Em vez de índices secundários, os conjuntos `Users.connections` e `Conversations.members` guardam no próprio item as conexões de um usuário e os membros de uma conversa, e a tabela `Memberships` lista as conversas de cada usuário.

### 4.2 Transações atômicas vs. atualizações condicionais

- **Persistência de mensagens (`sendMessage`):** O item da mensagem e o marcador de deduplicação são gravados juntos em uma transação na tabela `Messages`, garantindo que não exista mensagem sem marcador nem marcador órfão.
- **Metadados da conversa (`sendMessage`):** A atualização de `lastMessageAt` e `lastMessageBy` em `Conversations` ocorre fora da transação principal, por atualização condicional, para evitar contenção de escrita sob alta concorrência de envios (R06, T8).
- **Criação de salas (`openDirect` e `createGroup`):** Grava a conversa e as participações juntas em transação entre `Conversations` e `Memberships`, sem conversa parcial. No `openDirect`, a participação do outro usuário nasce oculta e só aparece no `sync` depois da primeira mensagem (D11).
- **Alteração de membros (`addMember` e `leaveGroup`):** Uma transação atualiza o conjunto de membros em `Conversations` e o vínculo correspondente em `Memberships` ao mesmo tempo, mantendo ambas as estruturas sincronizadas.
- **Ciclo de conexão (`$connect` e `$disconnect`):** O registro em `Connections` e a atualização atômica no conjunto de conexões do usuário em `Users` permitem que múltiplas abas conectem e desconectem simultaneamente sem perda de estado (D09).

Os conflitos de transação seguem a seção 3.3 da arquitetura, e os do `sendMessage`, a seção 4.3.

## 5. Ciclo de vida de conversas privadas, grupos e histórico

### 5.1 Conversas privadas (openDirect — RF03, D03, D11)

- **Identificador Determinístico (D03):** O `conversationId` de qualquer conversa direta entre dois usuários é formado pela concatenação ordenada lexicograficamente de seus usernames: `d:<username1>:<username2>` (ex.: `d:antonio:wallyson`). Se ambos os usuários abrirem a conversa simultaneamente, ambos convergem para a exata mesma chave de partição, evitando conversas duplicadas.
- **Participação Oculta (D11):** Ao executar `openDirect`, o item da conversa nasce com `started = false`. O iniciador recebe o registro normal em `Memberships`, enquanto o destinatário recebe o registro com `hidden = true`:
  - **Efeito na presença (RF07):** O destinatário já passa a ser contato do iniciador para os anúncios de presença.
  - **Efeito na listagem (RF10):** O `sync` omite conversas com `hidden = true` para o destinatário, evitando poluir sua caixa de entrada com chats vazios.
  - **Ativação na primeira mensagem:** Quando a primeira mensagem é enviada, **fora** da transação da mensagem, se `started` ainda é falso, a Lambda remove `hidden` e grava `joinedAt` em cada participação ainda oculta (com condição `attribute_exists(hidden)`), marca `started = true` em `Conversations` e emite `conversationAdded` ao dono de cada participação revelada imediatamente antes do evento `message`.

### 5.2 Grupos e gestão de membros (createGroup, addMember, leaveGroup — RF04)

- **Identificador Único e limite de membros:** Grupos recebem `conversationId` no formato `g:<UUID v4>` e suportam até **99 membros** tanto na criação (`createGroup`, respeitando o limite de 100 operações por `TransactWriteItems` do DynamoDB: 1 item em `Conversations` + até 99 itens em `Memberships`) quanto em inclusões posteriores (`addMember`, via condição `size(members) < 99`), o que mantém o `conversationAdded` de um grupo abaixo de 128 KB; a resposta do `sync`, que reúne todas as conversas, não é paginada (seção 7 da arquitetura).
- **Proteção contra Abandono Simultâneo (`lastMember`):** Na rota `leaveGroup`, a transação exige `contains(members, :username)` e, quando `confirm` não é verdadeiro, aplica também a condição `size(members) > 1` no item da conversa. Se os dois últimos membros de um grupo clicarem em sair ao mesmo tempo sem confirmar, a primeira transação conclui a remoção e a segunda falha na condição, retornando o erro `lastMember` para que o último integrante confirme explicitamente o encerramento do grupo (`confirm: true`).
- **Eventos de Ciclo de Vida:** Toda alteração de topologia do grupo notifica os membros conectados por meio de eventos dedicados (`conversationAdded`, `conversationRemoved`, `memberJoined` e `memberLeft`).

### 5.3 Histórico paginado (getHistory — RF06)

A consulta de histórico opera diretamente sobre a partição `conversationId` da tabela `Messages` utilizando `Query` com `ConsistentRead: true`, restringindo as chaves ao prefixo `m#` sem trazer os marcadores de deduplicação (`id#`, que ordenam antes de `m#` porque `'i' < 'm'`). Como o DynamoDB aceita apenas uma condição sobre a _Sort Key_ por `Query`, a expressão varia conforme o cursor; a seção 4.5 da arquitetura traz as expressões de cada caso.

**Tamanho das páginas:** cada página tem até 50 mensagens e até 28 KB, com pelo menos uma; a seção 4.4 da arquitetura explica o limite e o que o T5 verifica.
