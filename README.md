# ControlCRM — Barbearia

CRM para barbearias, em dois produtos sobre a mesma base:

- **Painel do dono** (`/`) — agenda, fila, fichas, financeiro e comissões.
- **Área do cliente** (`/cliente`) — o cliente final busca barbearias, agenda o
  corte e acompanha o histórico pelo celular.

> ### 📌 Chegou agora?
>
> Leia **[`CONTEXT.md`](CONTEXT.md)** antes de mexer em qualquer coisa. Ele é o
> documento canônico: registra as decisões, a auditoria de segurança, o
> checklist de blindagem do banco e a **regra de reporte obrigatório** para
> mudanças que encostem em `server/`, `db/`, `scripts/`, em validação ou em
> dependência nova.
>
> [`PLANO.md`](PLANO.md) tem as armadilhas já encontradas — cada uma custou
> tempo pelo menos uma vez.

## Dois ambientes

Feature nova nunca chega direto às barbearias. O caminho é sempre o mesmo:

```
  branch main  ──►  cutflow-dev  ──►  PR  ──►  branch producao  ──►  cutflow
                   banco cutflow_dev                              banco neondb
                   (descartável)                                  (dados reais)
```

| | Produção | Desenvolvimento |
|---|---|---|
| Serviço na Render | `cutflow` | `cutflow-dev` |
| Branch | `producao` | `main` |
| Banco Neon | `neondb` | `cutflow_dev` |
| Papel da aplicação | `cutflow_app` | `cutflow_dev_app` |
| `JWT_SECRET` | próprio | próprio — sessão de dev não vale em produção |

O desenho, com o porquê de cada linha, está em [`render.yaml`](render.yaml).

## Funcionalidades

- **Visão geral** com KPIs, faturamento da semana e atividade recente
- **Agenda** semanal com criação de horários, cancelamento e baixa de pagamento
- **Fila de espera** em tempo real para clientes walk-in
- **Fichas de clientes** com preferências de corte, barbeiro preferido e histórico
- **Serviços** com duração, preço e comissão do barbeiro
- **Estoque** de produtos com alerta de reposição
- **Financeiro** com recebimentos, despesas e resultado do mês
- **Assinaturas mensais** — planos, serviços incluídos, assinantes e MRR
- **Equipe** por unidade, com teto de 3 ativos por unidade na fase de validação
- **Unidades** (filiais), toda conta nasce com a "Unidade principal"
- **Exportação PDF** por seção ou completa

## Persistência

Tudo no Postgres (Neon). São **16 tabelas**:

```
barbeiros   convites    unidades      equipe      servicos    produtos
clientes    visitas     agendamentos  fila_espera planos      assinaturas
despesas    favoritos   avaliacoes    limites_uso
```

| Tabela | Guarda |
|---|---|
| `barbeiros` | Quem assinou o sistema: nome, barbearia, e-mail, WhatsApp e senha em hash bcrypt |
| `clientes` | Clientes da barbearia, com tipo, observações de corte e código de acesso |
| `visitas` | Atendimentos concluídos — é o livro-caixa que alimenta ficha, financeiro e KPIs |
| `agendamentos` | Horários marcados, com status Confirmado / Pago / Cancelado |
| `limites_uso` | Rate limit e bloqueio de login, compartilhados entre instâncias |

Toda linha carrega `barbeiro_id`, e **todas** as consultas filtram por ele usando
o id que vem do cookie de sessão — nunca um id enviado pelo navegador. É isso que
impede uma conta de enxergar dados de outra, e `npm run isolamento` prova rota a
rota que continua verdade.

Visitas nascem de três lugares: baixa de pagamento na agenda, "Atender" na fila,
ou registro manual na ficha. Contadores como total gasto, número de visitas e
última visita não são colunas: saem de `SUM`/`COUNT`/`MAX` sobre `visitas`, então
nunca ficam dessincronizados.

**Conta nova nasce vazia.** Sem catálogo padrão, sem dados de exemplo.

## Segurança

- Senhas gravadas só como hash **bcrypt** (custo 12), nunca em texto puro.
- Sessão em **JWT dentro de cookie `httpOnly`**, invisível para o JavaScript da
  página. O token carrega um claim `tipo`: cookie de cliente não vira sessão de
  dono.
- A área do cliente exige **telefone + código de acesso**, entregue pelo barbeiro
  no balcão. O id do cliente não viaja em URL: as rotas são `/api/publico/eu/*`,
  sob o middleware `exigirCliente`.
- A connection string vive só no servidor. O front não lê variável de ambiente:
  só chama `/api`.
- Queries 100% parametrizadas (`sql\`... ${valor}\``) — não há concatenação de SQL.
- A aplicação conecta com papel de menor privilégio, que **não** faz DDL.
- **Não existe modo demonstração nem atalho de acesso.** Para demonstrar o
  produto, crie uma conta real e entregue as credenciais.

## Stack

- Vite + React 19 (JSX, sem TypeScript)
- Express 5 + `@neondatabase/serverless` (API)
- bcryptjs + jsonwebtoken (autenticação)
- Lucide React (ícones) · jsPDF (exportação)
- Inline styles (sem CSS framework)

## Configurar

**1. Crie um projeto no Neon** em [neon.tech](https://neon.tech) (o free serve).

**2. Preencha o `.env.local`** na raiz, usando [`.env.example`](.env.example) como
modelo. São **duas** connection strings, de propósito: `DATABASE_URL` com o papel
da aplicação e `DATABASE_URL_MIGRACAO` com o papel dono. As duas apontam para o
banco de desenvolvimento, nunca para produção.

**3. Crie as tabelas:**

```bash
npm run db:migrate
```

Idempotente — rodar de novo não apaga nada.

**4. Suba a aplicação:**

```bash
npm run dev
```

API na 3001 e Vite na 5173, com proxy de `/api` configurado. Acesse
`http://localhost:5173` e crie uma conta — o cadastro é aberto.

## Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | API + front juntos (uso normal) |
| `npm run dev:api` / `dev:web` | Só a API / só o Vite |
| `npm run lint` | ESLint em `src`, `server` e `scripts` |
| `npm run build` | Compila o front para `dist/` |
| `npm run guardas` | Quatro invariantes de segurança, sem precisar de banco |
| `npm run smoke` | Contrato real contra a API no ar — **o teste que importa** |
| `npm run isolamento` | Prova que uma conta não alcança dados de outra |
| `npm run db:migrate` | Aplica `db/schema.sql`. Nunca destrói |
| `npm run db:reset` | **Destrutivo.** Recusa rodar com dados, salvo `-- --force` |
| `npm run db:papel-app` | Cria o papel restrito da aplicação |
| `npm run ensaiar-migracao` | Ensaia a migração contra uma cópia de produção |
| `npm start` | API servindo o `dist/` — é o que roda em produção |

Antes de abrir PR para `producao`, rode `lint`, `build`, `guardas`, `smoke` e
`isolamento`. O CI cobre os três primeiros; os dois últimos precisam de banco e,
por ora, rodam na sua máquina.
