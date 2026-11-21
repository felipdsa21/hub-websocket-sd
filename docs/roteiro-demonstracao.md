# Roteiro de demonstração ao vivo

**Projeto:** Hub Colaborativo WebSocket (Sistemas Distribuídos 2026.2 — Tema 4)  
**Duração estimada:** 10 a 12 minutos  
**Pré-requisitos:** aplicação web publicada via CloudFront (HTTPS), painel `HubWebSocket-dev` (ou `prod`) aberto no console AWS CloudWatch e dois perfis/janelas de navegador distintos (por exemplo, Chrome normal + janela anônima) para simular dois clientes independentes (RF01).

## 1. Preparação antes da apresentação (5 min antes)

1. Abrir a URL HTTPS da distribuição CloudFront em duas janelas lado a lado (**Cliente A** e **Cliente B**), ambas na tela de entrada (`/entrar`), com o **DevTools → Console** aberto no Cliente A para exibir os logs de presença, reconexão e reenvio (seção 4.6 da [arquitetura](arquitetura.md)).
2. Deixar uma terceira aba pronta no console da AWS com:
   - **CloudWatch → Dashboards → `HubWebSocket-dev`** (período `Últimos 15 minutos`, atualização automática ligada);
   - **CloudWatch → Log groups → `/aws/lambda/HubWebSocket-dev-app*`** (Live Tail ou filtro recente pronto).
3. Ter à mão o vídeo de backup da demonstração caso a rede do auditório fique indisponível.

## 2. Sequência da demonstração

### Bloco 1 — Conexão persistente, diretório e presença em tempo real (2 min)
**Requisitos evidenciados:** RF01, RF07, T1, T6.

1. No **Cliente A**, entrar como `ana` (nome de exibição `Ana Silva`); no **Cliente B**, entrar como `bruno` (`Bruno Costa`).
2. Explicar rapidamente o fluxo de `$connect` → gravação em `Connections` e `Users.connections` → `sync` inicial.
3. Abrir uma segunda aba no mesmo navegador do **Cliente B** para mostrar que a segunda conexão entra automaticamente e que fechar apenas uma das abas mantém Bruno **online** para Ana; ao fechar a última (ou sair), Ana recebe o evento `presence` (`online: false`) em tempo real.

### Bloco 2 — Chat privado, grupos, isolamento e autorização (2,5 min)
**Requisitos evidenciados:** RF02, RF03, RF04, RF05, RF10, RNF01, T2, T3.

1. No **Cliente A**, usar a busca (`search`) por `bruno` e iniciar um chat privado (`openDirect`). Destacar que o chat ainda **não aparece** para Bruno antes da primeira mensagem (D11 — participação oculta).
2. Enviar a primeira mensagem de Ana para Bruno: mostrar a conversa surgindo em tempo real no **Cliente B** (`conversationAdded`), marcada com nova atividade, e responder pelo Cliente B comprovando comunicação bidirecional via `@connections`.
3. Criar um grupo `Equipe SD` com Bruno pelo botão `+`, mostrar a entrega instantânea e o histórico carregado ao abrir (`getHistory`).
4. Comentar a autorização por requisição (**RNF01**): qualquer tentativa de envio, leitura de histórico ou alteração de grupo por um não-membro recebe `forbidden`, validado na bateria automatizada ([docs/testes.md](testes.md)).

### Bloco 3 — Tolerância a falhas ao vivo: queda de rede, backoff e fila local (3 min)
**Requisitos evidenciados:** RF07, RF08, RF12, T7.

1. No DevTools do **Cliente A** (aba *Network*), alternar para **Offline** (simulando queda abrupta sem `$disconnect`).
2. Observar imediatamente: as ações que dependem do backend ficam desabilitadas (`connected = false`), mas o banner e a ocultação de presença só aparecem após **3 segundos** (evitando ruído em quedas breves como o limite de 2 h, L02).
3. Ainda offline, enviar **duas mensagens** pelo **Cliente A** (elas ficam como pendentes na fila local) e enviar **uma mensagem** pelo **Cliente B** para Ana.
4. Mostrar no Console do **Cliente A** os intervalos crescentes de backoff exponencial (`0 ms`, `1 s`, `2 s`, `4 s`…).
5. Religar a rede (**Online** no DevTools):
   - O Cliente A reconecta sozinho, executa `sync(since)` + `getHistory(after)` (recuados 30 s) e exibe o aviso **`Conectado novamente.`**.
   - As duas mensagens pendentes são reenviadas em ordem, uma por vez, com confirmação idempotente (RF12) e sem duplicação.
   - A mensagem enviada por Bruno enquanto Ana estava offline aparece exatamente uma vez e na mesma ordem cronológica (`sk`) nos dois clientes (RNF04).

### Bloco 4 — Telemetria no cliente, logs anonimizados e painel CloudWatch (2 min)
**Requisitos evidenciados:** RNF03, RNF06, T8.

1. No menu da conta do **Cliente A**, abrir **Telemetria e eventos** e ativar **Exibir latência (RTT) na barra superior** para mostrar o RTT em milissegundos e o registro de eventos (reconexões, presença, reenvios).
2. Alternar para a aba do **CloudWatch Logs**: mostrar uma linha JSON real com `route`, `result`, `durationMs` e `connectionId`/`username`/`conversationId` anonimizados em **12 caracteres hexadecimais** (`HMAC-SHA256` com segredo no SSM Parameter Store), sem nenhum identificador em claro nem texto das mensagens.
3. Alternar para o **Dashboard `HubWebSocket-dev`**: exibir `ConnectCount`, `OpenConnections` (métrica customizada do `presenceSweeper`), `MessageCount`, `IntegrationLatency` e ausência de erros nas Lambdas.

### Bloco 5 — Resultados experimentais e decisões arquiteturais (1,5 min)
**Requisitos evidenciados:** RNF02, RNF04, R05, R06.

1. Apresentar os gráficos da [avaliação de desempenho](avaliacao-desempenho.md) (2, 5 e 10 usuários simultâneos, aquecimento vs. rodada medida, consumo DynamoDB).
2. Destacar: ordenação 100% consistente (110/110 mensagens únicas no T8), média de `368 ms` com 10 usuários simultâneos, redução de `56,4%` ao aquecer as Lambdas (R05), e o achado prático da cota inicial `ConcurrentExecutions = 10` da conta nova (recuperada sem perda pela fila idempotente).

## 3. Pontos de atenção durante a demo

- Não expor o endereço `wss://` cru em tela de edição de arquivos se não for necessário; a aplicação publicada já o consome via `/config.json`.
- Caso o teste offline no DevTools demore mais de 30 s, o `heartbeat` ou o `onclose` dispara o ciclo de reconexão normalmente; basta aguardar o próximo passo de backoff após religar a rede.
- Para limpar usuários de teste antes da apresentação, usar nomes frescos (ex.: `demo_ana`, `demo_bruno`).
