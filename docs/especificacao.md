# Especificação de requisitos e plano de testes

**Projeto:** Hub Colaborativo WebSocket

## 1. Introdução

Este documento especifica os requisitos, os riscos e o plano de testes do Hub Colaborativo WebSocket, uma aplicação de mensagens em tempo real construída sobre uma API WebSocket do Amazon API Gateway, conforme o Tema 4 da disciplina de Sistemas Distribuídos. A aplicação implementa um subconjunto do chat do Microsoft Teams; ficam de fora recursos como canais públicos, edição e exclusão de mensagens, anexos, reações, indicador de digitação, confirmação de leitura e chamadas.

O documento é normativo: qualquer divergência entre o sistema e este documento é um defeito em um dos dois. Ele descreve o que o sistema faz e o que o usuário precisa ver, mas não os detalhes da interface, como telas, disposição e estilo. Os IDs de requisitos, riscos, limitações e testes são estáveis, e o número de um item removido não é reaproveitado.

### Referências

- Detalhamento do Tema 4: Comunicação Direta com API Gateway WebSockets ([PDF](tema-4-api-gateway-websockets-detalhamento.pdf)).
- AWS. [Real-Time Communication on AWS](https://docs.aws.amazon.com/pdfs/whitepapers/latest/real-time-communication-on-aws/real-time-communication-on-aws.pdf). Whitepaper.
- AWS. [$connect and $disconnect routes](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-route-keys-connect-disconnect.html).
- AWS. [Use @connections commands in your backend service](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-how-to-call-websocket-api-connections.html).
- AWS. [Quotas for configuring and running a WebSocket API in API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-execution-service-websocket-limits-table.html).

## 2. Visão geral

O sistema segue a arquitetura mínima do tema: os clientes web se conectam a uma API WebSocket do API Gateway, implantada em um estágio, que encaminha cada rota a funções Lambda. O backend guarda as conexões, os usuários, as conversas e as mensagens no DynamoDB, e envia dados aos clientes pela Management API (`@connections`).

```text
clientes web ◄──WebSocket──► API Gateway ──rotas──► Lambda ◄──► DynamoDB
                                  ▲                    │
                                  └─── @connections ───┘
```

Cada usuário entra com um nome de usuário único, sem senha, e aparece para os demais com um nome de exibição. Um usuário pode usar vários clientes ao mesmo tempo, como abas diferentes do navegador; cada cliente tem a própria conexão, e as conexões com o mesmo nome de usuário pertencem ao mesmo usuário.

Uma conversa é um chat privado ou um chat em grupo. O chat privado reúne dois usuários e aparece com o nome de exibição do outro participante; o chat em grupo tem nome e membros.

Neste documento, *mensagem* é sempre uma mensagem de chat. Tudo o que o cliente envia pela conexão, seja uma mensagem ou outra ação, é uma *requisição*.

## 3. Requisitos funcionais

- **RF01 – Conexão:** O cliente abre uma conexão WebSocket persistente informando o nome de usuário e o nome de exibição. Vale o nome de exibição informado na conexão mais recente, e uma mudança de nome chega em tempo real aos participantes das conversas do usuário. Na rota `$connect`, o backend registra o identificador da conexão (`connectionId`) junto ao usuário, que passa a existir na primeira conexão. Uma conexão sem nome de usuário é recusada no `$connect`, e o handshake falha. Na rota `$disconnect`, o backend remove o registro.
- **RF02 – Requisições e entrega:** O cliente envia requisições por rotas de aplicação, escolhidas pela route selection expression. Cada mensagem recebe o horário em que o backend a recebeu e é entregue, com o remetente e esse horário, a todas as conexões dos participantes da conversa, inclusive à que a enviou, o que confirma o envio. A entrega usa `postToConnection`, pois responder à integração da rota não envia nada aos demais clientes.
- **RF03 – Chats privados:** Um usuário pode iniciar um chat privado com outro, e as mensagens chegam apenas aos dois. Existe no máximo um chat privado por par de usuários; iniciá-lo de novo abre o existente.
- **RF04 – Chats em grupo:** Um usuário pode criar um chat em grupo com nome e com pelo menos um outro participante. Os membros podem adicionar outros usuários e sair, mas ninguém entra sem ser adicionado. Os membros são avisados de cada entrada e saída. Quem é adicionado vê todo o histórico do grupo; quem sai deixa de ver o grupo. As mensagens do grupo chegam apenas aos membros.
- **RF05 – Pesquisa:** O usuário pode buscar pelo nome as conversas de que participa. Também pode buscar outros usuários, pelo nome de usuário ou de exibição, para iniciar um chat privado. Quando nomes de exibição se repetem, o nome de usuário aparece junto deles para distingui-los.
- **RF06 – Histórico:** Cada conversa guarda suas mensagens. Ao abrir uma conversa, o usuário recebe as mensagens mais recentes, inclusive as enviadas enquanto estava offline, e as anteriores chegam conforme ele volta na conversa.
- **RF07 – Presença:** Cada usuário está online ou offline: fica online enquanto tiver alguma conexão aberta e passa a offline quando a última se encerra. Uma conexão sem nenhuma requisição há 10 minutos é considerada encerrada, e a mudança para offline é anunciada em até 1 minuto. O cliente recebe o estado atual dos participantes das suas conversas ao conectar e quando surge um novo participante, e depois as mudanças em tempo real. Os usuários encontrados em uma pesquisa também vêm com o estado de presença.
- **RF08 – Conexões encerradas:** Ao enviar para uma conexão que não existe mais, o backend trata o erro, remove o registro e continua a entrega às demais conexões. Como o API Gateway encerra as conexões que ficam 10 minutos ociosas, o cliente envia sinais periódicos (heartbeat) em intervalo bem menor que esse e considera a conexão perdida quando o heartbeat fica sem resposta. Após uma queda ou a expiração da conexão, o cliente se reconecta sozinho, com intervalos crescentes entre as tentativas, até um máximo (backoff exponencial), e recebe as mensagens enviadas enquanto estava desconectado, sem perder nem repetir mensagens.
- **RF09 – Erros:** Uma requisição malformada, sem rota correspondente (que cai na `$default`, inclusive quando não é JSON) ou com uma ação não permitida recebe uma resposta de erro que diz o que falhou e, quando a requisição é uma mensagem com identificador (RF12), traz esse identificador. Nenhuma requisição é descartada em silêncio, exceto no caso da L03 e de uma mensagem que o backend deixa sem confirmação para ser reenviada (RF12).
- **RF10 – Lista de conversas:** O usuário vê as conversas de que participa e, ao conectar ou reconectar, recebe a lista atualizada. Uma conversa nova aparece para ele em tempo real: um grupo, quando ele é adicionado; um chat privado, quando ele recebe a primeira mensagem.
- **RF11 – Tamanho das mensagens:** O cliente impede o envio de mensagens cuja requisição passaria de 32 KB (L03) e avisa o usuário.
- **RF12 – Reenvio:** Cada mensagem leva um identificador gerado pelo cliente. Enquanto a confirmação (RF02) não chega, por falta de conexão ou por falha, a mensagem aparece como pendente e fica em uma fila de reenvio no cliente, que reenvia as pendentes, na ordem original, ao se reconectar ou após um tempo sem confirmação. O backend reconhece um reenvio pelo remetente e pelo identificador e apenas confirma o envio à conexão que o fez, sem guardar nem entregar a mensagem de novo. Uma mensagem rejeitada com erro (RF09) sai da fila e é indicada como não enviada.

## 4. Requisitos não funcionais

- **RNF01 – Autorização de cada requisição:** O backend verifica, em cada requisição sobre uma conversa (envio, leitura do histórico ou alteração), se o usuário da conexão participa dela, pois o `$connect` identifica a conexão, mas não autoriza cada ação seguinte.
- **RNF02 – Latência:** A latência ponta a ponta fica abaixo de 500 ms em 95% das entregas, com 10 usuários conectados.
- **RNF03 – Logs:** O backend registra as rotas acionadas e as respostas, com os identificadores anonimizados.
- **RNF04 – Ordem:** As mensagens de uma conversa são exibidas na mesma ordem para todos os participantes.
- **RNF05 – Configuração versionada:** A configuração da API (rotas, integrações e estágio) fica versionada no repositório, junto com o código do backend e dos clientes.
- **RNF06 – Métricas:** As métricas da API e do backend (conexões, requisições, erros e latência de integração) ficam visíveis em um painel do CloudWatch.
- **RNF07 – Publicação do cliente:** O cliente web fica publicado em uma URL HTTPS pública, conectado ao estágio da API.

## 5. Riscos

- **R01 – Registros de conexões encerradas** (impacto alto, probabilidade alta): a AWS entrega o `$disconnect` em regime de melhor esforço, então um registro pode sobrar após uma queda e manter o usuário como online. **Mitigação:** remover o registro ao receber o erro de conexão inexistente (RF08) e expirar a conexão sem requisições (RF07).
- **R02 – Vazamento entre conversas** (impacto alto, probabilidade média): uma falha no filtro de destinatários entrega mensagens a quem não participa da conversa. **Mitigação:** teste T3.
- **R03 – Falha de reconexão** (impacto alto, probabilidade média): o cliente não volta sozinho após uma queda ou a expiração da conexão. **Mitigação:** teste T7.
- **R04 – Permissão do backend** (impacto alto, probabilidade média): sem permissão para usar a Management API, o backend não consegue enviar nada aos clientes. **Mitigação:** repetir o teste T2 após cada implantação.
- **R05 – Início a frio do Lambda** (impacto médio, probabilidade média): as primeiras requisições após um período ocioso demoram mais. **Mitigação:** descartar da medição de latência uma rodada inicial de aquecimento.
- **R06 – Grupos grandes** (impacto médio, probabilidade média): o backend faz uma chamada por conexão de cada destinatário, então a latência cresce com o tamanho do grupo. **Mitigação:** medir a latência com todos os usuários do T8 no mesmo grupo.
- **R07 – Mensagens duplicadas no reenvio** (impacto médio, probabilidade média): a confirmação pode se perder depois que o backend já guardou a mensagem, e o reenvio da fila a duplicaria. **Mitigação:** identificador da mensagem gerado pelo cliente (RF12) e teste T7.

### Limitações conhecidas

Riscos aceitos:

- **L01 – Identificação sem senha:** qualquer pessoa pode entrar com o nome de usuário de outra e agir em nome dela. Um sistema de autenticação foi considerado desnecessário para o projeto.
- **L02 – Duração máxima da conexão:** o API Gateway encerra toda conexão após 2 horas, e esse limite não pode ser aumentado. O cliente fica alguns instantes sem receber mensagens em tempo real e as recebe ao se reconectar (RF08).
- **L03 – Tamanho da requisição:** o API Gateway fecha a conexão ao receber uma requisição acima de 128 KB ou um frame acima de 32 KB, e esses limites não podem ser aumentados. O cliente web não envia mensagens acima do limite do RF11; vinda de outro cliente, uma requisição grande demais se perde sem resposta de erro.

## 6. Plano de testes

Os testes usam o cliente web, o wscat e um script de carga. Juntos, T1, T2, T7 e T8 geram as evidências exigidas pelo tema: demonstração bidirecional com dois clientes, logs com identificadores anonimizados, latências e tratamento da desconexão. O RNF05 é verificado pela inspeção do repositório, e os testes com o cliente web usam a versão publicada (RNF07), exceto os passos que exigem configuração de teste.

### T1 – Conexão e registro

**Cobre:** RF01.

1. Conectar dois usuários que tenham uma conversa entre si e confirmar que há um registro com o `connectionId` de cada um, associado ao respectivo usuário.
2. Tentar conectar sem nome de usuário e confirmar que a conexão é recusada.
3. Reconectar um dos usuários com outro nome de exibição e confirmar que o outro vê o novo nome imediatamente.
4. Desconectar os clientes e confirmar que os registros foram removidos.

**Evidência:** logs das rotas `$connect` e `$disconnect`.

### T2 – Troca bidirecional

**Cobre:** RF02, RF09, RF11, RF12, R04.

1. Com dois usuários conectados em um chat privado, enviar uma mensagem pelo primeiro e confirmar que o segundo a recebe, com remetente e horário, e que ela volta ao primeiro como confirmação.
2. Responder pelo segundo e confirmar que o primeiro recebe a resposta.
3. Enviar uma requisição sem rota correspondente e outra que não é JSON, e confirmar o erro da `$default` nas duas.
4. Enviar uma mensagem malformada, com identificador, para uma rota de aplicação e confirmar que o erro diz o que falhou e traz o identificador da mensagem.
5. Tentar enviar pelo cliente web uma mensagem de 40 KB e confirmar que o envio é impedido com um aviso.
6. Com o backend respondendo com erro por configuração de teste, enviar uma mensagem pelo cliente web e confirmar que ela é indicada como não enviada e que não é reenviada após uma reconexão.
7. Com o backend demorando a confirmar por configuração de teste, enviar uma mensagem pelo cliente web e confirmar que ela aparece como pendente, é reenviada sem reconexão e chega ao destinatário uma única vez.

**Evidência:** demonstração com os dois clientes e logs das rotas e das respostas.

### T3 – Chats privados e em grupo

**Cobre:** RF03, RF04, RF07, RF09, RF10, RNF01, R02.

1. Conectar três usuários: A, B e C.
2. Iniciar, por A, um chat privado com B e confirmar que ele ainda não aparece para B. Enviar uma mensagem e confirmar que a conversa aparece imediatamente para B, que B recebe a mensagem e que C não a recebe.
3. Iniciar de novo, por A, um chat privado com B e confirmar que a conversa existente é aberta.
4. Criar, por A, um grupo com C e confirmar que o grupo aparece imediatamente para C. Enviar uma mensagem por A e confirmar que C a recebe e B não.
5. Pelo wscat, com o identificador do grupo, fazer B enviar uma mensagem ao grupo, ler o histórico do grupo e adicionar-se a ele, e confirmar que as três requisições recebem erro.
6. Adicionar B ao grupo por C e confirmar que o grupo aparece para B com todo o histórico, que A e C são avisados e que B recebe o estado de presença de A e C.
7. Fazer C sair do grupo e confirmar que A e B são avisados, que o grupo some para C e que uma nova mensagem de A chega a B e não a C.

**Evidência:** capturas de tela dos três clientes.

### T4 – Pesquisa

**Cobre:** RF05, RF07.

1. Buscar pelo nome um grupo e, depois, um chat privado de que o usuário participa, e confirmar que cada um aparece no resultado.
2. Buscar pelo nome um grupo de que o usuário não participa e confirmar que ele não aparece.
3. Buscar um usuário pelo nome de exibição e, depois, pelo nome de usuário, e confirmar que ele vem com o estado de presença. Iniciar um chat privado a partir do resultado.
4. Buscar um nome de exibição usado por dois usuários e confirmar que o nome de usuário distingue os dois no resultado.

**Evidência:** capturas de tela do cliente.

### T5 – Histórico

**Cobre:** RF06.

1. Com B offline, enviar mensagens de A para B e para um grupo de que B participa.
2. Conectar B, abrir as duas conversas e confirmar que as mensagens aparecem, com remetente e horário.
3. Abrir uma conversa cujo histórico passa de 128 KB, voltar até o início e confirmar que todas as mensagens podem ser vistas.

**Evidência:** capturas de tela do cliente de B e logs do envio do histórico em partes.

### T6 – Presença e vários clientes

**Cobre:** RF02, RF07.

1. Com A conectado e em uma conversa com B, conectar B em dois clientes e confirmar que A vê B online.
2. Conectar C, que tem conversas com A e com B, e confirmar que ele recebe, ao conectar, A e B como online.
3. Enviar uma mensagem de A para B e confirmar que os dois clientes de B a recebem.
4. Responder por um dos clientes de B e confirmar que A e o outro cliente de B recebem a resposta.
5. Fechar um dos clientes de B e confirmar que A continua vendo B online.
6. Fechar o outro cliente de B e confirmar que A vê B offline.

**Evidência:** capturas de tela dos clientes.

### T7 – Conexões encerradas e reconexão

**Cobre:** RF02, RF07, RF08, RF10, RF12, R01, R03, R07.

1. Conectar um cliente, anotar o `connectionId`, desconectá-lo e regravar o registro com a última requisição de agora. Enviar uma mensagem a esse usuário e confirmar que o backend trata o erro de conexão inexistente e remove o registro, e que o remetente recebe a confirmação.
2. Regravar de novo o registro com a última requisição de agora, conectar outro usuário que tenha conversa com ele e confirmar que o vê online. Sem nenhuma requisição dessa conexão, confirmar que o outro usuário passa a vê-lo offline entre 10 e 11 minutos após a regravação.
3. Desligar a rede da máquina de um cliente. Enquanto ele está fora, tentar enviar duas mensagens por ele e confirmar que elas aparecem como pendentes; depois, por outro usuário, enviar uma mensagem a ele e adicioná-lo a um grupo. Religar a rede e confirmar que o cliente se reconecta, que os intervalos entre as tentativas de reconexão cresceram (logs do cliente), que as mensagens pendentes são reenviadas na ordem original e chegam ao outro usuário uma única vez, que o cliente recebe a mensagem do outro usuário uma única vez e que vê o grupo novo na lista.
4. Com o heartbeat desativado por configuração de teste e sem nenhuma outra atividade, deixar um cliente conectado por mais de 10 minutos e confirmar que ele se reconecta após a expiração; repetir com o heartbeat ativo e confirmar que a conexão se mantém.
5. Pelo wscat, enviar duas vezes a mesma mensagem, com o mesmo identificador, e confirmar que as duas requisições recebem a confirmação, mas que a mensagem é entregue ao destinatário e guardada no histórico uma única vez. Enviar, por outro usuário, uma mensagem com o mesmo identificador e confirmar que ela é entregue normalmente.

**Evidência:** logs do tratamento da desconexão.

### T8 – Latência e logs

**Cobre:** RNF02, RNF03, RNF04, RNF06, R05, R06.

1. Com 10 usuários distintos em um mesmo grupo, simulados por um único script na mesma máquina, fazer uma rodada de aquecimento. Em seguida, fazer cada usuário enviar 10 mensagens ao mesmo tempo que os demais, registrando os instantes de envio e de recebimento de cada entrega.
2. Calcular a latência média e o percentil 95 das entregas, sem a rodada de aquecimento, e informar a rodada de aquecimento à parte.
3. Confirmar que todos os clientes ordenam as mensagens da mesma forma.
4. Conferir que os logs mostram as rotas e as respostas sem identificadores em claro.
5. Conferir que o painel do CloudWatch mostra as conexões, as requisições, os erros e a latência de integração do período do teste.

**Evidência:** latências calculadas, logs com identificadores anonimizados e captura de tela do painel do CloudWatch.
