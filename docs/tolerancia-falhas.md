# Tolerância a falhas

**Projeto:** Hub Colaborativo WebSocket

## 1. Introdução

Este documento descreve como o backend lida com falhas parciais: clientes que caem sem avisar, envios para conexões que não existem mais, Lambdas interrompidas no meio de um procedimento e falhas de um único envio durante uma difusão. Ele cobre só o que o backend implementa hoje; o heartbeat, a reconexão com backoff exponencial e a fila de reenvio do lado do cliente ficam para quando o cliente for implementado. Os nomes, as tabelas, os procedimentos e as decisões (D) citados estão na [arquitetura](arquitetura.md), e os requisitos, os riscos e os testes (RF, R e T), na [especificação](especificacao.md).

Em um sistema distribuído, o servidor não tem como distinguir um cliente lento de um cliente que caiu. O backend, por isso, não confia em um único sinal: combina o aviso do API Gateway (`$disconnect`), a resposta de cada envio (`410 Gone`) e o tempo desde a última requisição de cada conexão (`lastSeenAt`). Cada um cobre o caso em que os outros falham.

## 2. Falhas consideradas

- **Queda do cliente sem `$disconnect`:** o API Gateway entrega o `$disconnect` em regime de melhor esforço, então uma queda de rede ou uma aba encerrada à força pode deixar o registro da conexão no diretório e o usuário como online (R01).
- **Envio para uma conexão encerrada:** um `postToConnection` para uma conexão que não existe mais responde `410 Gone` (`GoneException`).
- **Lambda interrompida no meio:** um tempo limite ou um erro pode parar o vínculo ou o desvínculo entre dois passos, porque eles são passos ordenados e não uma transação (D09).
- **Falha de um único envio:** um envio pode falhar por outro motivo, como limite de requisições excedido, enquanto os demais da mesma difusão funcionariam.
- **Conexão sem registro:** uma conexão ainda aberta pode chegar a uma requisição depois de já ter sido desvinculada, por exemplo pela expiração por inatividade.

## 3. Detecção de conexões órfãs (410 Gone)

Todo envio do backend a um cliente passa pela mesma função (`send`, em `backend/functions/shared.ts`). Quando o API Gateway responde `410 Gone`, ela desvincula a conexão pelo procedimento único da seção 3.4 da arquitetura e informa que o evento não foi entregue, sem lançar erro (RF08). A conexão sai de `Users.connections` e o item de `Connections` é apagado.

Há uma exceção: o id entra em `Users.connections` antes de o handshake terminar, e um envio nesse intervalo também responde `410`. Por isso, um `410` para uma conexão cujo `connectedAt` é de menos de 30 s atrás não a desvincula. Se ela de fato caiu, o `$disconnect` ou a expiração por inatividade a remove.

Uma conexão encerrada é detectada, assim, no primeiro envio a ela: uma mensagem de outro membro da conversa, um aviso de grupo ou a resposta a uma requisição.

## 4. Difusão por conversa sem falhas em cascata

Os eventos de uma conversa (`message`, `conversationAdded`, `memberJoined`, `memberLeft` e `conversationRemoved`) vão a todas as conexões de todos os membros por uma difusão (`fanOut`, em `backend/functions/data.ts`). O backend relê `Conversations.members` depois de gravar a mudança, resolve as conexões de cada membro em `Users.connections` e envia o evento a cada uma em paralelo.

Cada conexão é tratada de forma independente:

- Um `410 Gone` desvincula só aquela conexão, e as demais recebem o evento normalmente (RF08).
- Qualquer outra falha também não interrompe os demais envios. A difusão espera todos terminarem e só então repassa a primeira falha, que fica registrada no log da requisição. Sem isso, a primeira falha encerraria a Lambda com envios ainda em andamento, que poderiam nunca chegar.

No `sendMessage`, a mensagem já está gravada antes da difusão, então uma falha de entrega nunca a perde: quem não recebeu em tempo real a encontra no histórico ao se reconectar.

## 5. Expiração por inatividade

### 5.1 Registro da atividade

Toda requisição, de qualquer rota exceto `$connect` e `$disconnect`, atualiza `Connections.lastSeenAt` com o instante em que o API Gateway a recebeu (RF07). Isso inclui o `heartbeat`, que só existe para isso: o backend atualiza `lastSeenAt` e responde `pong` com o mesmo `requestId`. Um cliente que envia heartbeats periódicos, portanto, nunca é considerado inativo, e o `pong` permite a ele perceber uma conexão que parou de responder.

A atualização tem a condição `attribute_exists(connectionId)`, que impede recriar o registro de uma conexão já desvinculada (seção 7).

### 5.2 `presenceSweeper`

A Lambda `presenceSweeper` (`backend/functions/presenceSweeper.ts`) é acionada a cada minuto pelo EventBridge Scheduler. Em cada execução, ela:

1. Percorre `Connections` e, para cada conexão sem requisições há mais de 10 minutos, encerra a conexão com `DELETE @connections` e a desvincula. Uma falha ao encerrar é ignorada, porque a conexão pode já ter caído; o desvínculo acontece de qualquer forma.
2. Percorre `Users` e desvincula os ids de `Users.connections` que não têm item em `Connections` (seção 6).
3. Espera 30 s e repete o passo 1. O agendamento tem resolução de 1 minuto e pode atrasar alguns segundos; com duas varreduras por execução, uma conexão inativa é removida entre 10 e 11 minutos após a última requisição.

Os desvínculos de uma execução são independentes: um que falha não impede os outros, e a falha fica no log da execução. O tempo limite da Lambda é de 50 s, para caber as duas varreduras e a espera.

O schedule e a configuração de invocação assíncrona da Lambda usam 0 novas tentativas e idade máxima de evento de 60 s. Repetir uma execução que falhou não ajuda: a seguinte, um minuto depois, refaz o mesmo trabalho, e execuções repetidas só disputariam a cota de execuções simultâneas.

### 5.3 TTL só como faxina

Cada item de `Connections` tem um `expiresAt` de 3 horas após a conexão, usado pelo TTL do DynamoDB. O TTL não serve para a expiração por inatividade, porque apaga os itens sem prazo garantido e sem avisar ninguém (D05); ele só alcança os itens que o `presenceSweeper` não conseguiu tratar.

## 6. Recuperação após uma Lambda interrompida

O vínculo grava o item em `Connections` antes de incluir o id em `Users.connections`, e o desvínculo retira o id antes de apagar o item (D09). Assim, uma falha no meio sempre deixa um item em `Connections`, e esse item volta a ser tratado:

- Se o vínculo falha depois de gravar o item, sobra uma conexão sem requisições, que o `presenceSweeper` remove após 10 minutos.
- Se o desvínculo falha depois de retirar o id, sobra só o item, que o `presenceSweeper` apaga quando ele passa de 10 minutos sem requisições.

O caso restante é um id em `Users.connections` cujo item sumiu, por exemplo apagado pelo TTL. Ele mantém o usuário como online e não seria encontrado pela varredura de `Connections`. Por isso, o passo 2 do `presenceSweeper` procura esses ids. Como um `Scan` não é um retrato de um único instante, cada id candidato é conferido com uma leitura consistente de `Connections[connectionId]` antes de ser desvinculado: uma conexão aberta durante a varredura já tem o item gravado e não é tomada por órfã.

## 7. Requisições de uma conexão sem registro

Se a atualização de `lastSeenAt` encontra a conexão sem registro, a Lambda não executa a requisição:

- Em um `sendMessage`, ela só encerra a conexão, sem responder com erro. A mensagem continua pendente no cliente, que se reconecta e a reenvia (RF12).
- Nas demais rotas, ela responde com o erro `notRegistered` e então encerra a conexão.

Em ambos os casos, o cliente perde uma conexão que o backend já não reconhecia e abre uma nova, registrada do zero no `$connect`.

## 8. Reenvio sem duplicação

Uma conexão pode cair depois que o backend gravou a mensagem e antes de a confirmação chegar ao remetente. O cliente, então, reenvia a mensagem com o mesmo `messageId` (RF12). O backend grava cada mensagem junto com um marcador indexado pelo remetente e pelo `messageId`, na mesma transação e com a condição de que o marcador ainda não exista. Um reenvio encontra o marcador e só confirma a mensagem à conexão que o fez, sem gravá-la nem difundi-la de novo (R07).

Conflitos de transação no DynamoDB, comuns em envios simultâneos para a mesma conversa, são repetidos até 3 vezes com espera curta e aleatória. Um conflito que persiste deixa a mensagem sem confirmação, em vez de responder com erro, para que o cliente a reenvie.

## 9. O que ainda falta

- **Anúncios de presença:** o `$connect`, o desvínculo e o `presenceSweeper` ainda não enviam o evento `presence` aos contatos, nem refazem os anúncios interrompidos (seção 3.5 da arquitetura). Hoje, a presença só é atualizada para os outros na próxima requisição que traz o estado do usuário.
- **Métrica de conexões abertas:** o `presenceSweeper` ainda não publica a contagem no CloudWatch (seção 5 da arquitetura).
- **Lado do cliente:** heartbeat periódico, detecção da queda, reconexão com backoff exponencial e fila de reenvio.
- **Testes de injeção de falhas:** o T7 da especificação, com quedas reais de cliente e de rede.

## 10. Verificação

Os testes unitários do backend (`npm run test` em `backend/`) cobrem os mecanismos deste documento: o desvínculo no `410 Gone` e a exceção do handshake, a difusão que continua após uma falha, a expiração apenas das conexões inativas, o desvínculo mesmo quando o encerramento falha, a limpeza de ids órfãos com a releitura antes do desvínculo e a configuração do schedule sem novas tentativas.
