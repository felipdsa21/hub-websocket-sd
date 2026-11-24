# Roteiro de demonstração ao vivo

**Projeto:** Hub Colaborativo WebSocket (Sistemas Distribuídos 2026.2 — Tema 4)  
**Duração estimada:** 10 a 12 minutos  
**Pré-requisitos:** aplicação web publicada via CloudFront (HTTPS), painel `HubWebSocket-dev` (ou `prod`) aberto no console AWS CloudWatch e dois perfis/janelas de navegador distintos (por exemplo, Chrome normal + janela anônima) para simular dois clientes independentes (RF01).

## 1. Preparação antes da apresentação (5 min antes)

1. Abrir a URL HTTPS da distribuição CloudFront em dois perfis/sessões de navegador distintos lado a lado (**Cliente A** e **Cliente B**), ambos na tela de entrada (`/entrar`), com o **DevTools → Console** aberto no Cliente A para exibir os logs de presença, reconexão e reenvio (seção 4.6 da [arquitetura](arquitetura.md)).
2. Deixar uma terceira aba pronta no console da AWS com:
   - **CloudWatch → Dashboards → `HubWebSocket-dev`** (período `Últimos 15 minutos`, atualização automática ligada);
   - **CloudWatch → Log groups → `HubWebSocket-dev-appLogs*`** (Live Tail ou filtro recente pronto).
3. Ter à mão o vídeo de backup da demonstração caso a rede do auditório fique indisponível.

## 2. Sequência da demonstração

### Bloco 1 — Conexão persistente, diretório, troca de nome paralela e presença multi-aba (2 min)

**Requisitos evidenciados:** RF01, RF07, T1, T6.

1. No **Cliente A**, entrar como `ana` (nome de exibição `Ana Silva`); no **Cliente B**, entrar como `bruno` (`Bruno Costa`). (Opcionalmente demonstrar a escolha do tema (sistema, claro ou escuro) na tela de entrada ou no menu da conta.)
2. Explicar rapidamente o fluxo de `$connect` → gravação em `Connections` e `Users.connections` → `sync` inicial.
3. No **Cliente A**, alterar o nome de exibição para `Ana S.` pelo menu da conta e mostrar que o **Cliente B** vê o novo nome imediatamente (reconexão paralela sem nenhum evento `offline`).
4. Abrir uma segunda aba no mesmo navegador do **Cliente B**: ela restaura automaticamente a sessão pelo usuário atual guardado no navegador; fechar apenas uma das abas mantém Bruno **online** para Ana, e ao clicar em **Sair** em uma aba, a outra também desconecta automaticamente via evento `storage` (anunciando `online: false` em tempo real para Ana).

### Bloco 2 — Chat privado, grupos, isolamento e autorização (2,5 min)

**Requisitos evidenciados:** RF02, RF03, RF04, RF05, RF10, RNF01, T2, T3, T4.

1. No **Cliente A**, usar a busca (`search`, tolerante a acentos `pt-BR`) por `bruno` e iniciar um chat privado (`openDirect`). Destacar que o chat ainda **não aparece** para Bruno antes da primeira mensagem (D11 — participação oculta).
2. Enviar a primeira mensagem de Ana para Bruno: mostrar a conversa surgindo em tempo real no **Cliente B** (`conversationAdded`), marcada com nova atividade, e responder pelo Cliente B comprovando comunicação bidirecional via `@connections`.
3. Criar um grupo `Equipe SD` com Bruno pelo botão `+`, mostrar a entrega instantânea e o histórico carregado ao abrir (`getHistory`).
4. Comentar a autorização por requisição (**RNF01**): qualquer tentativa de envio, leitura de histórico ou alteração de grupo por um não-membro recebe `forbidden`, validado na bateria automatizada de 12 cenários ([docs/testes.md](testes.md)).

### Bloco 3 — Tolerância a falhas ao vivo: queda de rede, backoff e fila local (3 min)

**Requisitos evidenciados:** RF07, RF08, RF12, T7.

1. No DevTools do **Cliente A** (aba _Network_), alternar para **Offline** (simulando queda abrupta sem `$disconnect`).
2. Observar: o evento `offline` da `window` dispara uma sondagem de `heartbeat`; quando ela fica 10 s sem `pong` (ou a conexão fecha antes), as ações dependentes do backend ficam desabilitadas e, **3 segundos** depois, entram o banner de queda e a ocultação da presença dos contatos (evitando ruído em quedas breves como o limite de 2 h, L02).
3. Ainda offline, enviar **duas mensagens** pelo **Cliente A** (elas ficam como pendentes na fila local) e enviar **uma mensagem** pelo **Cliente B** para Ana.
4. Mostrar no Console do **Cliente A** os intervalos crescentes de backoff exponencial (`0 ms`, `1 s`, `2 s`, `4 s`…).
5. Religar a rede (**Online** no DevTools):
   - O evento `online` acorda a reconexão imediatamente; o Cliente A executa `sync(since)` + `getHistory` (`after` recuado 30 s quando já há mensagens locais) e exibe **`Conectado novamente.`**.
   - As duas mensagens pendentes são reenviadas em ordem, uma por vez, com confirmação idempotente (RF12) e sem duplicação.
   - A mensagem enviada por Bruno enquanto Ana estava offline aparece exatamente uma vez e na mesma ordem cronológica (`sk`) nos dois clientes (RNF04).

### Bloco 4 — Telemetria no cliente, logs anonimizados e painel CloudWatch (2 min)

**Requisitos evidenciados:** RNF03, RNF06, T8.

1. No menu da conta do **Cliente A**, abrir **Telemetria e eventos** e ativar **Exibir latência (RTT) na barra superior** para mostrar o RTT em milissegundos e o registro de eventos (conexão/reconexões, presença, reenvios e latência).
2. Alternar para a aba do **CloudWatch Logs** (`HubWebSocket-dev-appLogs*`): mostrar uma linha JSON real com `route`, `result`, `durationMs` e `connectionId`/`username`/`conversationId` anonimizados em **12 caracteres hexadecimais** (`HMAC-SHA256` com segredo no SSM Parameter Store), sem nenhum identificador em claro nem texto das mensagens.
3. Alternar para o **Dashboard `HubWebSocket-dev`**: exibir `ConnectCount`, `OpenConnections` (métrica customizada do `presenceSweeper`), `MessageCount`, `IntegrationLatency`, `Throttles`, erros DynamoDB e os 3 alarmes configurados.

### Bloco 5 — Resultados experimentais e decisões arquiteturais (1,5 min)

**Requisitos evidenciados:** RNF02, RNF04, RNF05, RNF06.

1. Apresentar os gráficos da [avaliação de desempenho](avaliacao-desempenho.md) (2, 5 e 10 usuários simultâneos, aquecimento vs. rodada medida, consumo DynamoDB e painel CloudWatch).
2. Destacar: **RNF02 aprovado com folga** em 10 usuários simultâneos (`p95 = 166,05 ms < 500 ms`, média `160,67 ms`, `278,16 entregas/s`), ordenação 100% consistente (110/110 mensagens únicas, RNF04), redução de `67,1%` na média ao aquecer as Lambdas (R05), e ganho de −69,9% no p95 ao migrar para `512 MB` ARM64 + `presenceSweeper` em passagem única (~`105 ms`), em comparação a uma medição anterior sem dados brutos em `docs/dados/`.

## 3. Pontos de atenção durante a demo

- Não expor o endereço `wss://` cru em tela de edição de arquivos se não for necessário; a aplicação publicada já o consome via `/config.json` (sem cache) atrás de CloudFront com CSP e HSTS.
- A arquitetura reserva o `prod` para a apresentação; os exemplos deste roteiro usam o `dev`, e os nomes de painéis e logs seguem o padrão `HubWebSocket-<estágio>`.
- Para limpar usuários de teste antes da apresentação, usar nomes frescos (ex.: `demo_ana`, `demo_bruno`).
