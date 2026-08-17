---
name: code-review-graph
description: >
  Explorar e revisar este projeto pelo grafo de código em vez de varrer arquivos.
  Monta um mapa persistente (tree-sitter + SQLite) de funções, imports e chamadas
  do ControlCRM e responde "quem chama isto", "o que quebra se eu mexer aqui" e
  "quais arquivos esta mudança realmente afeta" — sem ler o repositório inteiro.
  Use ao revisar alterações, rastrear o raio de impacto de um patch, procurar
  onde algo é usado, entender a arquitetura, ou antes de responder qualquer
  pergunta que normalmente exigiria vários Grep/Read encadeados.
  Fonte: github.com/tirth8205/code-review-graph (MIT).
---

# Code Review Graph — ControlCRM

Adaptação do `code-review-graph` para **este** repositório. A ferramenta original
é um servidor MCP + CLI em Python que parseia o código com tree-sitter e guarda
funções, classes, imports e relações de chamada num SQLite. A revisão passa a
consultar esse grafo em vez de despejar arquivos inteiros no contexto.

## Por que aqui

Este projeto tem ~70 arquivos de código divididos em duas metades que se falam
por um contrato estreito:

- `server/` — Express + Neon. Rotas, `crud.js` (fábrica genérica), `auth.js`.
- `src/` — React. As telas consomem tudo por `src/lib/api.js`.

O erro caro neste repositório é **mudar um lado e não perceber o outro**. Uma
rota renomeada em `server/routes/publico.js` quebra `src/lib/api.js`,
`src/cliente/AreaCliente.jsx`, `src/cliente/Estabelecimento.jsx` e
`src/lib/demo.js` de uma vez — foi exatamente o que aconteceu na correção de
segurança de agosto/2026 (ver `CONTEXT.md`). O grafo existe para essa pergunta
ser respondida em um comando, e não com sete `grep`.

## Estado da instalação

**Instalada em 17/08/2026, a pedido explícito do usuário, depois de aviso do
risco abaixo.** Ainda não reportada ao dono do projeto — ver "Regra de
reporte" no fim deste arquivo; quem ler isto e não for o dono, trate como
pendente.

```bash
python3 -m ensurepip --user         # este ambiente não tinha pip
python3 -m pip install --user code-review-graph   # v2.3.7, Python 3.14.6
code-review-graph install --repo . --platform claude-code -y
code-review-graph build
```

Isso escreveu, sem passar por revisão humana antes de existir em disco:
`.mcp.json` (servidor MCP `code_review_graph serve`, stdio), `CLAUDE.md` (novo,
injeta "sempre use as tools do grafo antes de Grep/Glob/Read"), quatro skills
novas em `.claude/skills/` (`explore-codebase`, `review-changes`,
`debug-issue`, `refactor-safely`), um hook `PostToolUse`/`SessionStart` em
`.claude/settings.json`, e um hook `pre-commit` em `.git/hooks/` que roda a
cada commit. Nada disso foi commitado — está na árvore de trabalho.

### Bug do parser JS — corrigido em 17/08/2026

Causa raiz encontrada por leitura do pacote (`parser.py`,
`_run_parser_load_probe`): o teste de cada gramática roda `python -I -c
"...get_parser(...)"`. `-I` implica `-s`, que descarta o site-packages de
**usuário** — e é lá que `pip install --user` tinha colocado
`tree_sitter_language_pack`. O subprocess do probe nunca via o pacote, mesmo
ele carregando normalmente fora do `-I`.

**Correção aplicada:** um venv dedicado em
`~/.local/share/code-review-graph-venv/` (não é site de usuário; `-I`/`-s` não
o afeta). `.mcp.json`, os hooks em `.claude/settings.json` e
`.git/hooks/pre-commit` foram apontados para os binários desse venv em vez do
install `--user`. A instalação `--user` original ficou para trás, sem uso.

```bash
python3 -m venv ~/.local/share/code-review-graph-venv
~/.local/share/code-review-graph-venv/bin/pip install code-review-graph
# .mcp.json: "command" -> caminho absoluto do python3 do venv
# hooks / pre-commit: export PATH="$HOME/.local/share/code-review-graph-venv/bin:$PATH" antes de chamar code-review-graph
```

**Resultado do rebuild, medido:** `Nodes: 382, Edges: 3982, Files: 63,
Languages: sql, javascript` (363 nós JS, 19 SQL) — antes era `Nodes: 2,
Languages: sql`. Testado com uma consulta real deste projeto:
`code-review-graph impact --files server/crud.js` devolveu **51 arquivos
afetados**, consistente com o que este próprio documento descreve como "os
quatro pontos de onde tudo pende". O servidor MCP (`python3 -m
code_review_graph serve`, agora com o python do venv) sobe sem erro de
import.

**A skill está funcional.** Falta reiniciar o Claude Code para o `.mcp.json`
novo ser lido e as tools `*_tool` (`get_impact_radius_tool`,
`query_graph_tool` etc.) ficarem disponíveis nesta sessão — até lá, os
comandos CLI (`code-review-graph impact/query/search/...` pelo venv) já
funcionam via Bash.

Antes de instalar, vale lembrar o que a auditoria em `CONTEXT.md` apurou: é um
pacote de terceiros do PyPI que roda como servidor MCP com acesso de leitura ao
repositório inteiro — inclusive `.env.local`, que guarda `DATABASE_URL` e
`JWT_SECRET`. Instale com a mesma desconfiança que a auditoria aplicou às outras
skills.

## Fluxo de trabalho

A regra central da ferramenta: **grafo primeiro, arquivo depois.**

1. `detect_changes_tool` — ponto de partida de qualquer revisão. Devolve as
   mudanças com nota de risco, em vez de um diff cru.
2. `get_impact_radius_tool` — o raio de impacto. Neste repositório, use sempre
   que tocar em `server/crud.js`, `server/auth.js`, `src/lib/api.js` ou
   `src/ui/base.jsx`: são os quatro pontos de onde tudo pende.
3. `get_affected_flows_tool` — quais caminhos de execução a mudança atravessa.
4. `query_graph_tool` — `callers_of`, `callees_of`, `imports_of`, `tests_for`.
5. `semantic_search_nodes_tool` — achar função/componente por nome ou ideia,
   no lugar do Grep.
6. `get_architecture_overview_tool` — visão geral, para quem chega agora.

Caia para Grep/Glob/Read **só** quando o grafo não cobrir o que você precisa —
e ele não cobre: SQL em `db/`, texto em `docs/`, e o conteúdo dos comentários.

## Pares que o grafo não enxerga

O grafo segue `import` e chamada de função. Estes acoplamentos deste projeto são
por **string**, então nenhuma ferramenta estática os liga — confira à mão:

| Se você mexer em | Verifique também |
| --- | --- |
| um caminho de rota em `server/routes/*.js` | o caminho correspondente em `src/lib/api.js` |
| a assinatura de um método de `api.publico` | `src/lib/demo.js` (o modo demonstração implementa a MESMA interface) |
| um nome de coluna em `db/schema.sql` | as queries em `server/` e os campos lidos nas telas |
| um campo devolvido por uma rota | `scripts/smoke.js`, que compara os nomes de campo |

`src/lib/demo.js` é a armadilha mais fácil de esquecer: ele não é importado pelas
telas, e sim injetado em `api.js` por `comQuedaParaDemo`. Uma assinatura que muda
de um lado e não do outro só aparece quando o servidor cai.

## Verificação obrigatória depois de qualquer mudança

O grafo aponta o impacto; quem prova que nada quebrou é isto:

```bash
npm run lint      # eslint em src, server e scripts
npm run build     # o build falha em import quebrado
npm run smoke     # contrato real contra a API (precisa da API no ar)
```

O `smoke` é o teste que importa: ele dispara contra a API os mesmos corpos que
as telas mandam e confere os campos que elas leem. Foi ele que pegou o bug do
`regexp_replace(telefone, '\D', ...)` descrito no `CONTEXT.md`.

## Regra de reporte

Antes de dar qualquer trabalho por concluído, leia a **Regra permanente** no
topo do `CONTEXT.md`. Mudança que encoste no backend, em validação ou em
dependência nova é reportada ao dono do projeto — não é decisão do agente.
