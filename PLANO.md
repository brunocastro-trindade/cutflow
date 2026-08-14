# ControlCRM — Plano, estado e armadilhas

Documento de trabalho. Última atualização: **13/08/2026**.

O projeto nasceu como CRM multi-nicho (clínica, barbearia, mecânica) e foi
reduzido a **barbearia apenas**. Depois virou SaaS multi-inquilino com Postgres
no Neon. Este arquivo registra o que foi decidido, o que já roda e onde as
coisas já quebraram — para não quebrarem de novo.

> **Onde cada coisa mora.** Quando este arquivo e o [`CONTEXT.md`](CONTEXT.md)
> discordarem, **o CONTEXT.md vence** — ele é o canônico, e é onde estão a
> auditoria de segurança, o checklist de blindagem do banco e a regra de reporte
> obrigatório. O valor deste arquivo é a seção 4, **Armadilhas já encontradas**:
> os erros que já custaram tempo aqui.

---

## 1. Decisões de produto

Definidas em sessão de perguntas, 04/08/2026. Não são deriváveis do código.

| # | Tema | Decisão |
|---|---|---|
| 1 | Propósito | SaaS multi-inquilino, começando por piloto fechado |
| 2 | Equipe | Barbeiros da barbearia são tabela própria, **sem login**. Só o dono acessa |
| 3 | Histórico | Valor, comissão e duração **congelados no atendimento** |
| 4 | Assinaturas | Reais no banco, com vencimento — **só registro**, sem gateway de pagamento |
| 5 | Senha esquecida | Reset **manual**, direto no banco. Sem e-mail transacional |
| 6 | Cadastro | **Aberto para barbeiros e salões (SaaS B2B)** — sem necessidade de convite |
| 7 | Publicação | **Adiada**. Roda local enquanto as funcionalidades são terminadas |
| 8 | Conta nova | Nasce **totalmente vazia** — sem catálogo padrão, sem dados de exemplo |
| 9 | Estoque e despesas | Ambos no banco |
| 10 | Agenda | Intervalo real, grade de 30 min. Conflito por sobreposição, não por horário exato |
| 11 | Login social | **Não haverá.** Só e-mail + senha — ver abaixo |
| 12 | Tentativas de login | **3 erros bloqueiam o e-mail por 15 min** |

### Por que não existe "Entrar com Google" (decisão 11)

Chegou a ser cogitado e foi **descartado por regra de negócio**: o acesso ao
painel é pago, e o convite é o que controla quem entra. Login social abriria uma
porta em que qualquer pessoa com uma conta Google se autentica sozinha — o
controle de quem pode usar o produto sairia da mão de quem cobra por ele.

Não é dificuldade técnica: é o portão do negócio. Só volta à mesa junto com
cobrança automatizada, se um dia existir.

**Adiado de propósito** (volta à mesa só ao publicar): HTTPS/deploy, login
individual por barbeiro, e como o dono do SaaS recebe.

**Aceito no escopo:** fuso fixo `America/Sao_Paulo` — produto só para o Brasil.

---

## 2. O que já foi executado

### Etapa 0 — Redução a barbearia (feito)
Removidas as verticais de clínica e mecânica: telas, navegação, rotas e config.
`src/App.jsx` caiu de 3360 para ~2100 linhas.

### Etapa 1 — Schema (feito e testado)
`db/schema.sql`, 12 tabelas:

```
barbeiros   convites   equipe      servicos   produtos   clientes
visitas     agendamentos   fila_espera   planos   assinaturas   despesas
```

Dois princípios atravessam tudo:

1. **Todo registro tem `barbeiro_id`** e toda consulta filtra por ele usando o id
   que veio do cookie assinado — nunca um id vindo do navegador.
2. **Dinheiro que já aconteceu é fato consumado.** Visitas e agendamentos
   congelam valor, percentual de comissão, duração e os nomes envolvidos.

Destaques:
- Restrição de exclusão GiST em `agendamentos` impede sobreposição por barbeiro
  no próprio banco, inclusive sob concorrência. Coluna `periodo` gerada de
  `data + hora_inicio + duracao_min`.
- Índice único parcial garante **uma assinatura ativa por cliente**.
- Contadores (visitas, total gasto, última visita) **não são colunas**: saem de
  agregação sobre `visitas`, então nunca dessincronizam do caixa.

### Etapa 2 — API (feito e testado)
Rotas em `server/routes/`: auth (com convite), clientes, agenda, fila, visitas,
assinaturas, dashboard e catálogo (equipe/serviços/produtos/despesas/planos).

- `server/crud.js` — fábrica de CRUD por barbearia. Existe por segurança, não
  por economia: o filtro `barbeiro_id` fica escrito **uma vez só**.
- `server/snapshots.js` — resolve serviço/barbeiro/cliente e congela os dados.
- `server/seed.js` foi **deletado**; `SEED_DEMO_DATA` não existe mais.

Testado ponta a ponta: convite obrigatório e de uso único, conta nascendo vazia,
sobreposição de agenda recusada, baixa gerando visita, reajuste de preço **não**
alterando o histórico, fila, assinatura e dashboard.

### Etapa 3 — Front (feito e testado)
O catálogo fixo `N.services` / `N.products` / `N.pros` não existe mais: `N` é só
marca e cor. Todas as telas do painel falam o contrato do servidor
(`servico_id`, `equipe_id`, `hora_inicio`, `servico_nome`, `equipe_nome`), e
Serviços, Estoque, Equipe, Assinaturas e Despesas persistem no banco.

Todo `<select>` de catálogo sai do helper `opcoes()`, que usa **sempre o id
como valor** — é o que impede a volta do casamento por nome.

O painel deixou de ter modo demonstração.

> **Desatualizado.** Esta etapa dizia que "a demo sobrou só na área do cliente".
> Não sobrou: `src/lib/demo.js` foi **apagado** em 07/08/2026, junto com o
> `comQuedaParaDemo` da `api.js`. Hoje API fora do ar é erro visível, não dado
> inventado. Ver CONTEXT.md, "Acesso: só com conta registrada".

### Etapa 4 — Organização do front (feito)
`src/App.jsx` saiu de 2.638 para ~160 linhas. Hoje é só a raiz: sessão,
navegação e qual tela mostrar. O resto virou `src/ui/` (tokens + peças),
`src/painel/` (uma tela por arquivo), `src/landing/` e `src/auth/`.

Os dois produtos têm UI própria de propósito: `ui/` + tokens `B` para o painel
(desktop, escuro), `cliente/ui.jsx` + `LP` para a área do cliente (mobile).
Componentes homônimos nos dois (`Girando`, `Carregando`, `Vazio`) **não são
duplicação a unificar** — têm implementações diferentes.

### Etapa 5 — Tela de login (feito)
Cadastro estava quebrado: o servidor exigia convite e o formulário não tinha o
campo. Voltou, como primeiro campo.

As duas telas viraram `<form>` de verdade, com `autoComplete` — é o que faz
gerenciador de senha salvar e preencher. Senha tem olho para revelar. Limite de
3 tentativas (decisão 12) e uma linha dizendo que a redefinição é manual.

**Preenchido `CONTATO_SUPORTE`** em `src/auth/Telas.jsx`: configurado com `ag.sekoia@gmail.com` (virou link mailto no suporte).

### Etapa 6 — API Pública para Área do Cliente (feito)
Criadas as rotas públicas `/api/publico/*` em `server/routes/publico.js` e adicionadas as tabelas `favoritos` e `avaliacoes` ao schema Postgres.

> **Parcialmente desatualizado.** A auditoria de 07/08/2026 reescreveu a
> autenticação desta área: `/identificar` exige **telefone + código de acesso**
> (não cria mais cliente), e as rotas por id viraram `/api/publico/eu/*` sob o
> middleware `exigirCliente`. O contrato válido está no CONTEXT.md.

- `POST /api/publico/identificar`: busca/cria cliente pelo número de WhatsApp;
- `GET /api/publico/barbearias` e `GET /api/publico/barbearias/:id`: lista e detalha barbearias, serviços e barbeiros;
- `GET /api/publico/barbearias/:id/horarios`: calcula grade de horários livres x ocupados no dia;
- `POST /api/publico/agendar`: cria agendamentos na tabela `agendamentos` com congelamento de valores e trava de sobreposição GiST;
- `GET /api/publico/clientes/:id/inicio` e `/horarios`: histórico, agendamentos futuros e passados do cliente;
- `POST /api/publico/clientes/:id/favoritos` e `/avaliacoes`: gerencia barbearias favoritas e avaliações.

### Etapa 8 — Seção de Preços & Fluxo de Checkout (feito)
- Adicionada a seção `#precos` na Landing Page com alternância entre os ciclos Mensal e Anual e valores sob consulta (`R$ --`);
- Criado o componente `src/auth/CheckoutPlanos.jsx` para onboarding em 2 passos (Escolha de Plano e Pagamento Simulado);
- Atualizado o fluxo de entrada do sistema: ao clicar em "Criar conta", o usuário seleciona o plano, confirma o pagamento e a página de cadastro abre com o selo do plano ativo.

### Etapa 9 — Auditoria e blindagem (feito, 07 a 12/08/2026)
Registrada por inteiro no [`CONTEXT.md`](CONTEXT.md); aqui só o índice.

Autenticação da área do cliente reescrita (telefone + código de acesso), IDOR
fechado com `/publico/eu/*`, rate limit passando a usar `req.ip`, avaliações com
restrição de unicidade, atalho de acesso demo e dados de exemplo removidos,
papel de menor privilégio (`cutflow_app`) em uso, senha do dono do banco
trocada, e o projeto Neon antigo apagado.

### Etapa 10 — Dois ambientes e CI (feito, 12 a 13/08/2026)
`main` → `cutflow-dev` (banco descartável) e `producao` → `cutflow` (dados
reais), pelo [`render.yaml`](render.yaml). Feature nova entra por `main` e só
chega às barbearias por PR.

CI no GitHub Actions (`.github/workflows/ci.yml`): lint, build e
`npm run guardas` nos dois extremos da faixa do Node (22 e 24). As guardas
(`scripts/guardas.js`) transformam em teste quatro invariantes que antes eram só
regra escrita — front sem variável de ambiente, front sem credencial literal,
bundle sem segredo, e `engines.node` com teto.

**Pendente:** `smoke` e `isolamento` não rodam no CI (precisam de banco), e nada
impede push direto em `producao` — ver seção 5.

---

## 3. Comandos

| Comando | O que faz |
|---|---|
| `npm run dev` | API (3001) + front (5173) juntos |
| `npm run lint` / `npm run build` | Front e servidor |
| `npm run guardas` | Quatro invariantes de segurança. Não precisa de banco |
| `npm run smoke` | Contrato real contra a API no ar. **É o que importa** |
| `npm run isolamento` | Prova que uma conta não alcança dados de outra |
| `npm run db:migrate` | Aplica o schema. Nunca destrói |
| `npm run db:reset` | **Destrutivo**. Recusa rodar com dados, salvo `-- --force` |
| `npm run db:papel-app` | Cria o papel restrito da aplicação |
| `npm run ensaiar-migracao` | Ensaia a migração contra uma cópia de produção |

Credenciais em `.env.local` (fora do git). São **duas** connection strings —
papel da aplicação e papel dono. Modelo em `.env.example`.

O `npm run convite` continua existindo, mas o **cadastro é aberto** (decisão 6):
`server/routes/auth.js` não pede convite. A tabela `convites` e o script são
resíduo da fase de piloto fechado.

---

## 4. Armadilhas já encontradas

Cada uma custou tempo pelo menos uma vez. Estão aqui para não custar de novo.

### Driver do Neon

**`sql.query()` devolve array, não `{ rows }`.**
As rotas respondiam **vazio sem lançar erro** — falha silenciosa, a pior espécie.
Só `Client.query()` (usado nos scripts de migração) é compatível com `pg`.

```js
const linhas = await sql.query(texto, params);   // array
const { rows } = await client.query(texto);      // só com Client
```

**Colunas `numeric` voltam como string.** `preco` chegava como `"75.00"` e
qualquer soma no front viraria concatenação. Sempre `::float8` na saída.

### Datas e fuso

**Nunca use `toISOString()` para extrair o dia.** Converte para UTC e, no Brasil,
joga qualquer horário após as 21h para o dia seguinte. Use formatação local
(`src/lib/formato.js`) no front e `to_char(campo, 'YYYY-MM-DD')` no SQL.

**`current_date` do Postgres é UTC.** Use
`(now() at time zone 'America/Sao_Paulo')::date` — vale para `WHERE`, para
`default` de coluna e para "hoje" no dashboard.

**`to_char(data, 'Dy')` devolve o nome em inglês**, conforme o `lc_time` do banco.
Formate nomes de dia e mês no front.

### Modelagem

**`on delete cascade` em `visitas.cliente_id` apagava o faturamento.** Remover um
cliente encolhia a receita do mês passado, sem aviso. Correto é `set null`, com o
nome preservado em `cliente_nome`: o cliente sai, o dinheiro fica.

**Comissão calculada ao vivo reescreve o passado.** A versão anterior consultava
o catálogo atual ao renderizar — reajustar de 40% para 50% mudava o relatório de
março. Por isso `comissao_pct` é congelado na visita.

**Casar barbeiro por substring do primeiro nome dá pagamento errado.** Dois
"Carlos" recebiam as comissões um do outro. Por isso `equipe_id`.

### React / front

**`Row` não repassava `onClick`** — todos os toggles do sistema eram inertes e
ninguém notou. Componente de layout que aceita eventos precisa repassá-los.

**Toggle ignorava o padrão configurado**: `type="toggle"` renderizava desligado.
Inicialização precisa considerar o tipo.

**Comparar objeto com sua própria cópia espalhada nunca casa.**
`appointments[i] === {...a}` era sempre falso; a seleção da agenda não destacava
nada. Compare por id.

**`Date.now()` durante o render** quebra a regra de pureza do React. Calcule uma
vez em `useState(() => ...)` ou fora do componente.

**`setState` síncrono no corpo de um `useEffect`** também é barrado pelo lint.
Nos callbacks da promise é permitido — e é o padrão correto.

**Contador de tentativas em memória vira 3 × instâncias.** ✅ **Resolvido.** A
contagem morava num `Map` do processo, e o limite real seria 3 × o número de
instâncias. Hoje vive na tabela `limites_uso` (`server/limiteStore.js`),
compartilhada — o que também permitiu escalar para mais de uma instância. O
preço é uma ida ao banco por requisição limitada, e só as rotas sensíveis
(`/api/auth`, `/api/publico`) pagam.

**Contar tentativa só para e-mail cadastrado entrega quem está na base.** Se o
e-mail inexistente nunca bloqueasse, a diferença de comportamento seria um
oráculo de quais contas existem — o mesmo motivo de "e-mail ou senha incorretos"
ser uma mensagem só. Por isso o contador sobe para qualquer e-mail.

**Botão dentro de `<label>` rouba o foco.** O olho de mostrar senha, se ficar
dentro do label, faz o clique focar o input (é o que um label faz) e o cursor
pula para o fim do texto a cada alternância. Fica fora, com `tabIndex={-1}`.

### Ferramental

**ESLint com `globals.browser` aplicado ao servidor** marca `process` como
indefinido. Separe os blocos por pasta (`src/**` browser, `server/**` node).

**Regex complexa dentro de `node -e` quebra no Git Bash.** O shell come as barras
invertidas. Escreva o script num arquivo e execute o arquivo.

**Script fora da pasta do projeto não resolve `node_modules`.** Para testar com
dependências, o arquivo precisa estar dentro do projeto.

**O console do Windows embaralha acentos na saída** (`Degrad?`). É só exibição —
confirme no banco antes de sair caçando bug de encoding.

### Skills instaladas

`.claude/skills/` (ui-ux-pro-max) está no `.gitignore` **de propósito** — não sobe
com o repositório. Os caminhos de script dos `SKILL.md` vinham quebrados de
fábrica e foram corrigidos localmente; **`uipro update` desfaz essas correções**.

---

## 5. Pendências conhecidas

Levantadas em 13/08/2026. Nenhuma é bug: são coisas decididas e não feitas, ou
feitas pela metade — registradas para não virarem surpresa.

### O portão entre dev e produção não é obrigatório

O `render.yaml` diz que nada chega às barbearias sem um PR de `main` para
`producao`. Hoje isso é convenção, não mecanismo: **branch protection não está
disponível** neste repositório (privado em plano free — a API do GitHub responde
`Upgrade to GitHub Pro`). Um push direto em `producao` sobe para as barbearias
sem passar por CI nenhum.

Três saídas, em ordem de custo:

1. **`autoDeploy: false` no serviço `cutflow`** e disparo do deploy hook pelo CI,
   só depois do verde. A trava sai de "não dá para mergear" e vira "não dá para
   deployar" — que é o que de fato protege a barbearia. **Custo zero.**
2. **GitHub Pro**, que libera branch protection em repositório privado.
3. **Tornar o repositório público**, que também libera. Atenção: o `CONTEXT.md`
   descreve a superfície de ataque do sistema, incluindo o que ainda está aberto.

### `smoke` e `isolamento` no CI — escrito, aguardando os segredos

`.github/workflows/ci-banco.yml` roda os dois contra uma branch efêmera do Neon
(`schema-only`, criada e apagada no job). Falta só configurar `NEON_API_KEY` e
`NEON_PROJECT_ID` em Settings → Secrets and variables → Actions. Sem eles o
workflow se declara PULADO em vez de falhar.

**Não foi executado contra a API da Neon ainda** — a primeira execução real vai
ser o primeiro PR depois dos segredos. Até lá, rode os dois na sua máquina.

### O dev divide o compute com produção

As duas connection strings usam o mesmo endpoint e mudam só o nome do banco. Os dados estão separados, o compute não — e trocar o
nome do banco na string escreve em produção, que foi como o incidente de 12/08
aconteceu. Detalhes no CONTEXT.md.

### `docs/` está desatualizado

`docs/HANDOFF-BACKEND.md` e `docs/API-CONTRATO.md` citam `src/lib/demo.js` em
cinco lugares — arquivo apagado em 07/08/2026 — e descrevem a área do cliente
antes da correção de autenticação. Não foram revisados nesta passada.
