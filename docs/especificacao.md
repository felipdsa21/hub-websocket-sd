# Especificação de Requisitos, Matriz de Riscos e Plano de Testes
**Projeto:** Hub Colaborativo WebSocket (mini-Teams)
**Fase 1:** Escopo (14/10 a 20/10/2026)

---

## 1. Requisitos do Sistema

### Requisitos Funcionais (RF)
* **RF01 - Conexão de Sessão:** O backend na AWS deve aceitar e manter conexões bidirecionais persistentes via protocolo WebSocket (`$connect` e `$disconnect`).
* **RF02 - Troca de Mensagens em Broadcast:** O sistema deve retransmitir eventos/mensagens enviadas por um cliente para todos os demais usuários ativos na sessão.
* **RF03 - Mensagens Diretas (DM):** O sistema deve permitir o envio de mensagens privadas de ponto a ponto utilizando o ID de conexão (`connectionId`).
* **RF04 - Gestão de Canais/Salas:** O sistema deve isolar mensagens de uma determinada sala para que não vazem para clientes conectados em outros canais.
* **RF05 - Painel de Presença:** O sistema deve registrar e informar em tempo real quando um usuário entra ou sai da aplicação.

### Requisitos Não-Funcionais (RNF)
* **RNF01 - Baixa Latência:** As mensagens devem ser retransmitidas e entregues aos clientes conectados com tempo de resposta inferior a **500 ms**.
* **RNF02 - Limite de Carga de Payload:** O tamanho máximo de cada mensagem enviada via API Gateway WebSocket não deve exceder **128 KB**.
* **RNF03 - Timeout por Inatividade:** Sessões inativas ou sem sinal de vida (*heartbeat*) por mais de **10 minutos** devem ser desconectadas automaticamente.
* **RNF04 - Escala e Concorrência:** A arquitetura Serverless (AWS Lambda + DynamoDB) deve suportar múltiplas conexões simultâneas sem degradação do serviço.

---

## 2. Matriz de Riscos Técnicos Distribuídos

| ID | Risco Identificado | Impacto | Probabilidade | Mitigação / Ação de QA |
| :--- | :--- | :--- | :--- | :--- |
| **R01** | **Conexões Fantasma (`GoneException`):** Cliente perde conexão sem disparar a rota `$disconnect`, mantendo o `connectionId` no DynamoDB. | Alto | Alta | Implementar e validar fluxo de ping/heartbeat (Fase 6) para remover conexões órfãs. |
| **R02** | **Vazamento entre Salas:** Falha nos filtros da função Lambda enviando mensagens de um canal para usuários de outro. | Alto | Média | Executar testes simultâneos em abas/terminais separados com payloads específicos por canal. |
| **R03** | **Estouro de Carga no API Gateway:** Envio de payloads superiores ao limite de 128 KB travando a transmissão. | Médio | Baixa | Criar testes de estresse enviando mensagens com tamanhos limítrofes via `wscat`. |
| **R04** | **Falha de Reconexão:** O cliente não se reconecta automaticamente após uma breve queda de rede. | Alto | Média | Simular interrupção de rede e validar a implementação do algoritmo de reconexão exponencial no frontend. |

---

## 3. Plano Inicial de Testes e Experimentos

### Experimento 1: Homologação do Cliente de Testes (`wscat`)
* **Objetivo:** Garantir a capacidade de simulação e inspeção de pacotes WebSocket via linha de comando no Windows/VS Code.
* **Ferramenta:** `wscat` no PowerShell do VS Code.
* **Status:** **Concluído com Sucesso** (Conexão e troca de pacotes validadas via servidor público de testes).

### Experimento 2: Validação de Endpoints na AWS (Fase 2 & 3)
* **Passos:**
  1. Conectar ao endpoint do API Gateway (`wss://<id-da-api>.execute-api.us-east-1.amazonaws.com/dev`).
  2. Confirmar se o `connectionId` foi gravado corretamente na tabela do DynamoDB.
  3. Desconectar o cliente e validar se a rota `$disconnect` removeu o registro da tabela.

### Experimento 3: Teste de Transmissão Múltipla (Fase 4)
* **Passos:**
  1. Abrir 3 instâncias concorrentes do `wscat` no terminal do VS Code.
  2. Enviar uma mensagem pelo Cliente 1.
  3. Confirmar a recepção instantânea nos Clientes 2 e 3.
