# Contribuindo

## Branches

O projeto segue o Git Flow:

- `main`: código entregue.
- `develop`: integração do trabalho em andamento.
- `feature/<nome>`: nova funcionalidade, criada a partir da `develop`.
- `release/<nome>`: preparação de uma entrega, criada a partir da `develop`.
- `hotfix/<nome>`: correção urgente, criada a partir da `main`.

Nada é commitado diretamente na `main` ou na `develop`: toda mudança entra por pull request, com pelo menos uma aprovação de outro integrante.

## Fluxo

1. Crie a branch a partir da base atualizada:

   ```sh
   git switch develop
   git pull
   git switch -c feature/<nome>
   ```

2. Faça os commits e envie: `git push -u origin feature/<nome>`.
3. Abra um pull request para a `develop`.

Branches `release/*` e `hotfix/*` precisam de dois pull requests: um para a `main` e outro para a `develop`.

## Commits

Usamos [Conventional Commits](https://www.conventionalcommits.org/pt-br/v1.0.0/), com a descrição em português:

```text
feat: adicionar seletor de salas
fix: corrigir reconexão após queda
docs: atualizar diagrama de arquitetura
```

## Código e documentação

Comentários devem explicar o porquê, não o que o código já diz. Na documentação, prefira uma frase a uma tabela e deixe de fora detalhes internos de baixo nível.

O código, incluindo nomes, comentários e docstrings, é escrito em inglês.

Uma mudança de comportamento atualiza a documentação no mesmo pull request.

## Onde documentar

- **Especificação:** o que o sistema faz e o que o usuário vê, sem detalhes de tela, em requisitos, riscos, limitações e plano de testes.
- **Arquitetura:** como o sistema funciona por dentro, com serviços da AWS, nomes e dados, rotas e eventos, logs e métricas, decisões e limitações. O funcionamento do cliente por trás do que o usuário vê fica na seção "Comportamento do cliente".
- **Design no Figma:** telas, layout, componentes e decisões visuais. Uma nota no arquivo indica o commit de `docs/` que o design segue e é atualizada quando o design é ajustado a uma mudança em `docs/`.
- **README:** visão geral do projeto e links para os documentos.
