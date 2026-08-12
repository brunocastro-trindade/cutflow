# CONTEXT — ControlCRM (Barber-shop)

Documento de contexto do projeto. Quem chega agora — pessoa ou agente — lê isto
antes de mexer em qualquer coisa.

---

## ⚠️ Regra permanente — todo agente deve ler antes de trabalhar

**Este projeto teve o front alterado.** As telas da área do cliente
(`src/cliente/`), o cliente HTTP (`src/lib/api.js`), o modo demonstração
(`src/lib/demo.js`) e a ficha de clientes do painel (`src/painel/Clientes.jsx`)
mudaram junto com uma correção de segurança no servidor.

A partir daqui, vale o seguinte:

> Se a alteração encostar no **backend** (`server/`, `db/`, `scripts/`), em
> **qualquer validação** (regra de entrada, permissão, autenticação,
> restrição de schema) ou introduzir **dependência nova** (npm, pip, serviço
> externo, ferramenta de terceiros), **ela deve ser reportada ao dono do
> projeto antes de ser dada por concluída.**

O reporte é obrigatório mesmo quando a mudança parece pequena, mesmo quando o
lint e o build passam, e mesmo quando ela foi pedida explicitamente. Descrever o
que mudou, por que, e o que passa a depender daquilo.

Não vale decidir sozinho que "é só um ajuste de front" quando o ajuste depende de
um campo novo na resposta da API — isso é backend. Na dúvida sobre a fronteira,
reporte.

### Por que esta regra existe

O front e o servidor deste projeto se falam por um contrato estreito e não
verificado por tipos. Uma rota renomeada em `server/routes/publico.js` quebra
`src/lib/api.js`, `src/cliente/AreaCliente.jsx`, `src/cliente/Estabelecimento.jsx`
e `src/lib/demo.js` ao mesmo tempo — e o modo demonstração só falha quando o
servidor cai, ou seja, em produção degradada. Validação e dependência entram na
regra porque foram as duas coisas que a auditoria encontrou quebradas.

---

## Workflow do produto — quem compra, quem trabalha

```
  PESSOA COMPRA O SaaS
          │
          ▼
  ┌───────────────────┐   1 conta = 1 dono, e é o dono quem faz login.
  │  CONTA (barbeiro) │   Funcionário NÃO tem acesso ao sistema.
  └─────────┬─────────┘
            │  1..N
            ▼
  ┌───────────────────┐   Filial / loja física. Toda conta nasce com a
  │     UNIDADE       │   "Unidade principal"; dá para criar outras.
  └─────────┬─────────┘
            │  0..3   ◄── TETO DA FASE DE VALIDAÇÃO
            ▼
  ┌───────────────────┐   Cadastrado à mão pelo dono, na tela Equipe.
  │   FUNCIONÁRIO     │   Só conta quem está ATIVO.
  └───────────────────┘
```

### As regras, e o porquê de cada uma

**O teto é 3 funcionários ativos por UNIDADE, não por conta.** Uma rede com três
lojas tem direito a nove pessoas — três em cada. Precisando de mais gente numa
loja só, a saída é o plano maior, não uma unidade fictícia.

**Só conta quem está ativo.** Desativar quem saiu libera a vaga na hora, sem
apagar o histórico dele. Reativar alguém quando a unidade já está cheia é
recusado, pela mesma trava.

**O número mora no banco, em um lugar só.** A função
`cc_limite_equipe_por_unidade()` (em `db/schema.sql`) retorna `3`, e a trigger
`equipe_limite_por_unidade` o impõe. A API lê esse valor por
`server/limites.js`; o front recebe em `GET /api/unidades` como
`limitePorUnidade`. **Não escreva `3` em nenhum outro lugar** — um limite
repetido vira dois limites diferentes no dia em que alguém mudar só um, e a
tela passa a prometer vaga que o banco recusa.

**Para mudar o teto, mude a função e rode `npm run db:migrate`.** Nada mais.

**A trava é do banco, não da rota.** A rota checa antes só para dar mensagem
decente; quem decide é a trigger, que trava a linha da unidade (`for update`)
antes de contar. Sem isso, dois cadastros simultâneos passariam os dois pela
contagem e a quarta pessoa entraria.

**Contas que já passavam do teto foram preservadas.** A migração cria a coluna e
faz o backfill ANTES de criar a trigger, de propósito: quem já tinha mais gente
mantém todo mundo e só é impedido de crescer.

### O que continua sendo por CONTA, não por unidade

Agenda, fila, clientes, serviços, estoque, financeiro e assinaturas seguem
filtrados por `barbeiro_id` — **não** por unidade. Só a equipe é organizada por
unidade nesta fase.

Isso é escolha, não pendência esquecida: mover tudo para unidade é uma
re-arquitetura grande, que toca praticamente todas as consultas do sistema, e
não era o que a fase de validação pedia. O vínculo indireto existe — um
agendamento aponta para um `equipe_id`, e aquele funcionário pertence a uma
unidade —, então o dado necessário para essa separação futura já está no lugar.

## Acesso: só com conta registrada

Não existe modo demonstração, dados de exemplo nem atalho de acesso. Entrar no
painel exige conta registrada e sessão assinada pelo servidor.

### O que foi removido em 07/08/2026, e por quê

**1. Botão "⚡ Acessar Painel Demo (1-Clique)" na tela de login.**
Era o problema grave. Ele tentava entrar com `demo@barbearia.com` / `demo123`
e, se a conta não existisse, **criava a conta** com essas credenciais e entrava
assim mesmo. Consequências:

- Qualquer visitante da tela de login abria um painel completo em um clique.
- Apagar a conta no banco **não resolvia**: o próximo clique a recriava.
- As credenciais ficavam legíveis em texto claro no bundle enviado ao navegador.

**2. `src/lib/demo.js` e o `comQuedaParaDemo` da `api.js`.**
Quando o servidor não respondia, a área do cliente trocava a API por dados
fictícios do navegador e exibia barbearias, horários e avaliações inventados
**como se fossem reais**. Em produção isso engana quem está tentando marcar um
corte, e o dono nem fica sabendo da queda. Agora API fora do ar é erro visível.

O bundle encolheu de 389 kB para 375 kB, e não contém mais nenhuma credencial.

### Regra

Para demonstrar o produto, **crie uma conta real com senha própria** e entregue
as credenciais a quem for ver. Não recoloque atalho de acesso na tela de login,
nem dados de exemplo que se passem por reais.

### Por que a auditoria não pegou isso antes

Registro honesto, porque o erro é instrutivo: as varreduras anteriores
procuraram pelo *módulo* de demonstração (`apiDemo`, `demoAtivo`, `ativarDemo`)
e por termos como "demonstração". O botão não usava nada disso — ele chamava
`api.auth.entrar` e `api.auth.cadastrar`, as funções legítimas, com credenciais
fixas. Procurar pelo nome do mecanismo em vez de perguntar **"quem mais chama a
função de autenticação, e com quais argumentos?"** deixou a porta passar.

A varredura certa, e que deve ser repetida a cada auditoria:

```bash
grep -rn "api\.auth\.cadastrar\|api\.auth\.entrar" src/     # quem autentica
grep -rnEi "senha:\s*[\"']|password:\s*[\"']|creds" src/    # credencial fixa
```

## A área pública só mostra dado real

A vitrine da barbearia (`resumoBarbearia` em `server/routes/publico.js`) devolvia
endereço "Rua Principal, 100", bairro "Centro", cidade "São Paulo - SP",
**nota 4,9 com 12 avaliações**, capa e logo de banco de imagens, um texto
"sobre" genérico, comodidades e horário de atendimento — tudo fixo no código,
idêntico para toda barbearia. Cada barbeiro da equipe também vinha com nota
`5.0`, escrita direto no SQL.

Isso chegava ao cliente final como informação da loja que ele ia visitar. Foi
removido inteiro em 10/08/2026, junto com as seções de tela que o exibiam.

**A regra: campo que o sistema não coleta não é devolvido.** Nada de valor
padrão bonito para preencher espaço. Quando existir cadastro de endereço,
horário e comodidades, eles voltam vindos do banco.

O que a vitrine mostra hoje: nome da barbearia, nome do dono, sigla e cor
(derivadas do nome), telefone — só na ficha individual, nunca na listagem —,
serviços, equipe e as **avaliações reais** da tabela `avaliacoes`.

Também saíram `loja.distancia` (não há geolocalização) e o estado inicial do
coração de favorito (a rota pública não sabe quem está logado; o clique
funciona e a rota devolve o estado novo).

## Checklist de blindagem do banco

Verificado no projeto em 11/08/2026. Marcado com o que foi conferido, não com o
que se espera. `[x]` = confirmado por medição; `[ ]` = pendente de fato.

### [x] 1. Connection string só no servidor

Conferido no bundle de produção: **zero ocorrências** de `postgresql://`,
`neon.tech`, `DATABASE_URL` ou `JWT_SECRET`. Não existe nenhuma variável `VITE_`
nem `import.meta.env` em `src/` — o front não lê ambiente, só fala com `/api`.

O risco do prefixo `VITE_` é real e vale saber: qualquer variável com esse
prefixo entra no bundle e vira pública. Aqui não há nenhuma, e não deve passar a
haver.

### [x] 2. Isolamento entre contas — coberto por teste, RLS adiado com motivo

`npm run isolamento` (`scripts/isolamento.js`) cria duas contas, faz uma delas
criar um registro de **cada** entidade, e tenta alcançá-lo pela outra em **toda
rota autenticada**: 13 listagens, leitura por id, 15 escritas e 10 exclusões.
Depois confere que os dados da vítima continuam intactos.

**O teste foi validado quebrando o isolamento de propósito**: removido o
`where barbeiro_id` da listagem de clientes, ele acusou `VAZOU GET /clientes` e
saiu com código 1. Teste que não sabe falhar não vale nada.

Roda junto do smoke, a cada deploy.

#### Por que RLS não foi implementado agora

Avaliado e adiado, com dois motivos medidos:

**1. Não há Data API.** Verificado no banco novo: não existe papel `anon` nem
`authenticated`, não há schema `neon_auth` nem extensão PostgREST. Só o servidor
Node alcança as tabelas. O cenário que justificaria RLS — tabela exposta por
HTTP — não existe aqui.

**2. RLS não protege contra a credencial da aplicação vazar.** A política
precisaria identificar o inquilino por `current_setting('app.barbeiro_id')`.
Quem rouba a string define essa variável sozinho. RLS defende contra *bug da
aplicação*, e é exatamente isso que o teste acima cobre — em tempo de teste, não
de execução.

**Custo, se for implementado depois:** o driver HTTP (`neon()` em
`server/db.js`) **não mantém sessão entre consultas** — medido: `set_config`
numa chamada e leitura na seguinte se perde. Só sobrevive dentro de
`sql.transaction([...])` ou na mesma instrução. Ou seja, RLS exigiria que toda
consulta passasse a rodar em transação com a variável do inquilino. Dá para
fazer sem tocar nos ~111 pontos de chamada, com um wrapper em `db.js` usando
`AsyncLocalStorage`, mas isso muda como toda consulta do sistema executa.

Vale reavaliar quando: a Data API for ligada, ou o volume de rotas escritas à
mão crescer a ponto do teste não dar conta.

### [ ] 2b. RLS propriamente dito — se a Data API for ligada

**RLS está desligado nas 16 tabelas.** Hoje isso não é exposição, porque o único
caminho até o banco é o servidor Node, que filtra por `barbeiro_id` em toda
consulta (`server/crud.js` e as rotas). RLS seria uma segunda trava, não a
primeira.

Vira exposição **se a Data API do Neon estiver habilitada**, porque aí as tabelas
ficam alcançáveis por HTTP sem passar pelo servidor. Isso é configuração de
projeto no console da Neon, não dá para ver por SQL — **confira lá**.

Duas observações que mudam o cálculo:

- O papel da aplicação tem **`bypassrls = true`**. Ligar RLS sem trocar o papel
  não muda nada: ele ignora as políticas. RLS depende do item 3.
- O banco ANTIGO (São Paulo) tinha um schema `neon_auth` provisionado, com
  `user`, `session`, `jwks`, `organization` — origem da coluna órfã
  `barbeiros.auth_user_id`. O banco NOVO (Ohio) **não tem**: só `public`. A
  migração deixou essa superfície abandonada para trás, o que é bom.

### [x] 3. Papel de menor privilégio — IMPLEMENTADO em 11/08/2026

A aplicação passou a conectar como **`cutflow_app`**, criado por
`npm run db:papel-app`. Medido depois de criar:

```
createdb=false  createrole=false  bypassrls=false  superuser=false
CREATE no schema public: false
```

Testado executando de verdade, não por inspeção. O papel **consegue**: ler,
inserir, atualizar, apagar, `select ... for update` (a trigger do teto usa) e
executar `cc_limite_equipe_por_unidade()`. E **não consegue**: criar tabela,
apagar tabela, alterar tabela, criar papel, criar banco, desligar a trigger do
teto, nem ler `pg_authid`.

O smoke completo passa com a aplicação usando esse papel, e o teto de 3
funcionários continua sendo imposto.

**A migração usa outra credencial.** `db/schema.sql` tem 46 instruções de DDL, e
o papel restrito falha nelas — confirmado: *"permission denied for schema
public"*. Por isso o `render.yaml` declara duas variáveis:

| Variável | Papel | Onde é usada |
| --- | --- | --- |
| `DATABASE_URL` | `cutflow_app` | o processo que atende requisição |
| `DATABASE_URL_MIGRACAO` | `neondb_owner` | só na linha do release, dentro do build |

O ganho: a string que fica no processo em produção não cria tabela, não apaga
dados e não cria papel. Um vazamento dali expõe os dados, não o projeto.

`alter default privileges` já está aplicado, então tabela criada por migração
futura nasce com os grants certos — sem isso a aplicação quebraria no primeiro
acesso à tabela nova.

<details>
<summary>Como era antes (para saber o que se ganhou)</summary>

A aplicação conecta como `neondb_owner`, que tem:

```
createdb: true   createrole: true   bypassrls: true   CREATE no schema public
```

Ou seja, a credencial que a aplicação carrega pode criar bancos, criar papéis e
ignorar RLS. Vazando essa string, perde-se o projeto inteiro, não só os dados.

O desenho certo são dois papéis:

```sql
-- Papel da aplicação: só o que as rotas precisam.
create role cutflow_app login password '<forte>';
grant usage on schema public to cutflow_app;
grant select, insert, update, delete on all tables in schema public to cutflow_app;
grant usage, select on all sequences in schema public to cutflow_app;
-- Sem CREATE, sem DROP, sem createdb/createrole/bypassrls.
```

**Atenção ao aplicar:** `npm run release` roda `db/schema.sql`, que faz DDL
(`create table`, `alter table`, `create trigger`). Ele precisa continuar usando
o papel dono. Na prática: `DATABASE_URL` da aplicação aponta para `cutflow_app`,
e a fase de release usa uma variável separada com o papel dono. Como hoje o
release roda dentro do `buildCommand` (ver `render.yaml`), essa separação exige
mudar o comando — não é troca de uma linha.

</details>

**Ainda falta**: o item 2 (RLS) volta a fazer sentido agora, porque
`cutflow_app` **não** tem `bypassrls`. Se a Data API do Neon estiver ligada,
ligar RLS passa a ser proteção real, e não decoração.

### [ ] 4. Testar em branch efêmera, não em produção

Os testes de injeção desta análise rodaram contra o banco de desenvolvimento, e
criaram e apagaram contas nele. Funcionou porque não há dado real ainda.

Depois que houver barbearia de verdade, teste em branch: no console da Neon,
**Branches → New branch** a partir de `main`, use a connection string dela e
apague no fim. A branch nasce com os dados copiados e não afeta produção.

### [~] 5. Rate limit e validação na borda

**Rate limit: feito.** `server/rateLimit.js` com contagem compartilhada em
`limites_uso`, escopo por rota, e limite estrito de 10/15min em
`/api/publico/identificar`. Bloqueio de login por e-mail em `server/tentativas.js`.

**Validação: existe, mas é artesanal.** `textoObrigatorio` e `numeroNaFaixa` em
`server/crud.js`, mais checagens espalhadas nas rotas (`eUUID`, faixa de nota,
tipo de cliente). Cobre o que as telas mandam; não é um schema declarado.

Zod cortaria payload malformado num lugar só e documentaria o contrato — mas é
dependência nova e reescrita de validação em todas as rotas. **Não é urgente
para injeção de SQL** (as consultas são parametrizadas; 33 payloads reais não
passaram), e sim para robustez e clareza. Fica como melhoria, não como correção.

### [x] 6. Rodar a senha do banco — FEITO em 12/08/2026

A senha do `neondb_owner` foi colada em conversa e valia para o cluster inteiro:
com ela, trocar o nome do banco na string bastava para abrir produção pelo
console SQL, e nenhuma defesa da aplicação alcança isso.

Trocada pela API da Neon. Medido depois, e não suposto:

```
velha -> producao              RECUSOU   password authentication failed
velha -> dev                   RECUSOU   password authentication failed
nova  -> producao              CONECTOU  neondb_owner @ neondb (barbeiros=4)
cutflow_app -> producao        CONECTOU  cutflow_app @ neondb (barbeiros=4)
```

**A troca não derrubou o site**, e isso foi verificado antes de rodar: um
`pg_stat_activity` em produção mostrou que quem atende requisição é o
`cutflow_app`, não o dono. O dono só aparece no build, no `npm run release`.

Sobra disso: a variável **`DATABASE_URL_MIGRACAO` da Render está com a senha
velha**. Enquanto não for atualizada, o site segue no ar normalmente e é o
próximo *build* que falha, em `npm run release`. A string nova está em
`.neondb_owner.local` (ignorado pelo git).

### [x] 7. Apagar o projeto Neon antigo — FEITO em 12/08/2026

O projeto de São Paulo tinha uma cópia da conta admin e convidava a apontar para
o banco errado — já tinha acontecido uma vez neste projeto. Confirmado pela API
que sumiu: sobrou `cutflow-prod` (Ohio) e um `neon-citron-fence` sem relação,
criado pela integração da Vercel.

Junto com ele morreram `VITE_NEON_AUTH_URL` e `NEON_AUTH_URL`, que apontavam
para o endpoint de Neon Auth de lá. Nenhum arquivo do projeto lê essas duas
variáveis, então nada quebrou — mas a de prefixo `VITE_` era uma armadilha
armada: bastaria alguém escrever `import.meta.env.VITE_NEON_AUTH_URL` para ela
passar a ser servida ao navegador. Removidas do `.env.local`.

### Incidente de 12/08/2026 — servidor esquecido apontado para produção

Um `node server/index.js` iniciado em **11/08 às 14:38**, de outra sessão e
**sem** `--env-file-if-exists=.env.local`, continuou ocupando a porta 3001 com
credenciais de produção herdadas do shell. Consequências, todas reais:

- Um servidor novo iniciado na mesma porta **não subia** (porta ocupada) e não
  reclamava em lugar visível. Tudo que se chamava de "localhost" era o antigo.
- O `npm run isolamento` cria contas **pela API** e limpa pelo `DATABASE_URL`
  **dele**. Com os dois em bancos diferentes, criou em produção e limpou no dev:
  imprimiu "contas de teste removidas" tendo apagado nada.
- "Barbearia A" e "Barbearia B" ficaram listadas na rota pública
  `/api/publico/barbearias` do site no ar, junto das barbearias reais.
- O front local do desenvolvedor vinha falando com produção havia um dia.

Removidas em transação, com cópia antes e conferência de que as contas reais
ficaram idênticas. Junto saiu a conta `priv-teste@local`, que também era lixo de
teste — e cujo `senha_hash` tinha **1 caractere**, não um hash bcrypt.

Duas travas nasceram daqui:

- **`server/index.js`** passa a registrar no start o `host`, a `base` e o
  `papel` do banco — nunca a senha. Servidor apontado para o lugar errado agora
  se denuncia na primeira linha do log.
- **`scripts/isolamento.js`** recusa rodar se a API enxergar qualquer barbearia
  que não seja do próprio teste, e explica onde procurar o processo intruso.

A lição não é "matar o processo": é que **um servidor no banco errado era
indistinguível de um certo**, porque nada dizia para onde ele apontava.

### Como o `.env.local` está agora

Duas credenciais, a mesma separação do `render.yaml`:

| Variável | Papel | Para quê |
| --- | --- | --- |
| `DATABASE_URL` | `cutflow_dev_app` | o que a aplicação usa; lê e escreve, não faz DDL |
| `DATABASE_URL_MIGRACAO` | `neondb_owner` | só o `npm run db:migrate`, que roda DDL |

As duas apontam para o banco **`cutflow_dev`**, nunca para `neondb`. O dev usar
o mesmo papel restrito da produção é de propósito: erro de permissão aparece na
máquina antes de aparecer no ar.

## Deploy

### Variáveis obrigatórias

| Variável | Valor | Por quê |
| --- | --- | --- |
| `DATABASE_URL` | connection string do Neon | sem ela o processo sai no start |
| `JWT_SECRET` | 32+ caracteres aleatórios | assina o cookie; trocar desconecta todo mundo |
| `NODE_ENV` | `production` | **liga o `secure` do cookie e o HSTS** |
| `TRUST_PROXY` | `1` atrás de um proxy | sem isso todos compartilham o mesmo balde de rate limit |
| `PORT` | a que a plataforma injetar | |

O servidor **avisa em voz alta no start** quando `NODE_ENV` não é `production`,
ou quando está em produção com `TRUST_PROXY=0`. Se esses avisos aparecerem no
log de produção, a configuração está errada.

### Versão do Node

`engines.node` é **`>=22 <25`**, e o teto existe de propósito.

Com `>=22.0.0` sem teto, a Render escolheu **Node 26.7.0** — enquanto o projeto
é desenvolvido e testado no **24**. O build passou, mas rodar em produção uma
versão que nunca foi exercitada aqui é risco à toa: basta um Node novo mudar
comportamento no meio de um teste com barbearias reais.

A faixa aceita 22 e 24 (as LTS) e recusa 25 e 26. O piso é 22 porque o código
usa `--env-file-if-exists` e `getSetCookie`.

Ao subir o Node local, suba o teto junto — depois de rodar `npm run smoke` e
`npm run isolamento` na versão nova.

### Ordem do deploy

```bash
npm ci            # NÃO `npm install` — respeita o package-lock, que é o que
                  # você testou. As dependências estão com ^ e um install
                  # solto pode trazer minor diferente.
npm run build     # gera dist/, que o próprio servidor serve
npm run release   # aplica db/schema.sql — FASE DE RELEASE, antes do start
npm start
```

`npm run release` é idempotente e não apaga dados. Precisa rodar **antes** do
processo subir: sem ele a aplicação sobe e quebra na primeira consulta.

O front e a API são o mesmo processo — `server/index.js` serve o `dist/` quando
ele existe. Um container só, sem CDN separada.

### O que muda em produção

- Cookie de sessão com `secure`, HSTS de 180 dias.
- CSP restritiva, montada à mão em `server/index.js`. **Ela permite
  `style-src 'unsafe-inline'`** porque o front usa estilo inline em quase todo
  componente; ao trocar isso por CSS de verdade, aperte a diretiva junto.
  `frame-ancestors 'none'` impede que a aplicação seja embutida em iframe.
- Log em JSON de uma linha, para o agregador da plataforma conseguir indexar.
- `SIGTERM` fecha a porta, espera as requisições em voo e sai (10s de teto).

### Escalar para mais de uma instância

Pode. Rate limit e bloqueio de login vivem na tabela `limites_uso`
(`server/limiteStore.js`), compartilhada entre as instâncias — antes eram `Map`
em memória, e o limite real virava N vezes o configurado.

O preço é uma ida ao banco por requisição limitada. Só as rotas sensíveis
(`/api/auth`, `/api/publico`) passam por lá.

## Como verificar qualquer mudança

```bash
npm run lint      # eslint em src, server e scripts
npm run build     # falha em import quebrado
npm run db:migrate  # idempotente; aplica db/schema.sql
npm run smoke     # contrato real contra a API (precisa da API no ar)
```

O `smoke` (`scripts/smoke.js`) é o que importa: dispara contra a API os mesmos
corpos que as telas mandam e confere os campos que elas leem. É o único ponto do
projeto que impede front e servidor de voltarem a discordar sobre nomes de campo.

---

# Auditoria de segurança — 07/08/2026

## Escopo e método

Auditados **211 arquivos**: as 7 skills de terceiros em `.claude/skills/` e todo
o código-fonte da aplicação. Fora do escopo: `node_modules/` (390 MB de
dependências npm) e `dist/` (build gerado a partir de `src/`, já varrido).

Método em duas passadas, seguindo a metodologia do `skill-auditor`:

1. **Passada determinística** — um scanner estático (tree de detecção:
   caracteres invisíveis, overrides bidirecionais/Trojan Source, homóglifos,
   padding de layout, blobs base64/hex, sinais de capacidade, procedência de
   dependências, frases de prompt injection, arquivos órfãos). O scanner foi
   escrito para esta auditoria e **validado contra uma fixture maliciosa** antes
   do uso — detectou os seis tipos de truque plantados.
2. **Passada de julgamento** — leitura dirigida só do que o scanner apontou,
   mais o raciocínio de raio de alcance que script nenhum faz.

O scanner nunca executa o alvo; só lê.

## Veredito

| Alvo | Veredito |
| --- | --- |
| Skills de terceiros (`.claude/skills/`) | **LOW-RISK** — 0 achados críticos |
| Código da aplicação | **HIGH-RISK** — autenticação da área do cliente quebrada |

O risco real do projeto não estava nas skills instaladas. Estava em
`server/routes/publico.js`.

## Raio de alcance

O que uma skill em execução alcança: o repositório inteiro e, sobretudo,
`.env.local` — que guarda `DATABASE_URL` (connection string do Neon) e
`JWT_SECRET`. Quem lê esse arquivo tem o banco inteiro e pode forjar sessão de
qualquer barbeiro.

Verificado: **nenhuma das 7 skills lê `.env.local`, e nenhuma tem canal de rede
bruto** (zero `requests`, `urllib`, `socket`, `axios`, `fetch` em scripts). A
única egressão é via SDK `google-genai`, na skill `design`. A trifecta letal não
fecha.

## Achados na aplicação — todos corrigidos

### 1. ALTA — Autenticação do cliente quebrada

`POST /api/publico/identificar` recebia um telefone e devolvia o registro do
cliente buscando em *qualquer* barbearia, sem código, sem OTP, sem nada. O
`cliente_id` devolvido era a única credencial das rotas seguintes. Com o telefone
de alguém, um atacante obtinha histórico completo com valores, total gasto,
profissional favorito, e podia cancelar agendamentos, favoritar e avaliar como
aquela pessoa. A rota ainda confirmava se um telefone estava cadastrado
(`precisaNome: true`), permitindo enumeração da base.

**Correção.** Passou a exigir **telefone + código de acesso**. Como não há canal
de verificação no projeto (sem WhatsApp/SMS) e o barbeiro cadastra cada cliente à
mão, o código nasce junto com a ficha e é entregue pessoalmente — a prova de
posse acontece no balcão. Gerado com `crypto.randomInt` (CSPRNG, sem viés) num
alfabeto de 32 símbolos sem O/0/I/1, porque é ditado em voz alta.
Ver `server/codigoAcesso.js`.

### 2. ALTA — IDOR nas rotas da área do cliente

O `clienteId` viajava na URL (`/publico/clientes/:clienteId/horarios`) e o
servidor acreditava nele.

**Correção.** As rotas viraram `/publico/eu/*` sob o middleware `exigirCliente`
(`server/auth.js`), que lê a identidade de um cookie assinado httpOnly. O id
saiu das URLs e do `localStorage`. Os tokens carregam um claim `tipo`, então um
cookie de cliente não vira sessão de dono — e o `smoke` testa exatamente isso.

### 3. ALTA — Rate limit contornável

`server/rateLimit.js` lia `x-forwarded-for` cru, sem `trust proxy`. Bastava
mandar um valor aleatório por requisição para o limite virar decorativo.

**Correção.** Passou a usar `req.ip`, com `trust proxy` desligado por padrão e
configurável por `TRUST_PROXY` (documentado em `.env.example`). `/identificar`
ganhou limite próprio: 10 tentativas por 15 minutos.

### 4. MÉDIA — Cliente novo caía na barbearia errada

`select id from barbeiros order by criado_em limit 1` criava todo cliente novo
sob a **primeira barbearia do banco**, independentemente de onde ele agendava —
misturando a base de clientes entre contas num sistema multi-inquilino.

**Correção.** O auto-cadastro público foi removido inteiro. Quem cadastra cliente
é o barbeiro, no painel, que é o fluxo real de trabalho.

### 5. MÉDIA — Avaliações sem restrição

`avaliacoes` não tinha `unique(cliente_id, barbeiro_id)` — ao contrário de
`favoritos`, que tinha — e a rota não checava se o cliente já visitara. Como a
nota pública sai de `avg(nota)`, dava para afundar ou inflar a reputação de
qualquer barbearia em laço.

**Correção.** Índice único `avaliacoes_cliente_barbeiro_uk` com dedupe das
duplicatas anteriores, e a rota agora exige visita registrada. Reavaliar
substitui a nota em vez de somar outra.

### 6. BAIXA — WhatsApp dos donos exposto

`GET /api/publico/barbearias` devolvia o telefone do proprietário de todas as
barbearias, sem autenticação e sem paginação.

**Correção.** `resumoBarbearia` ganhou o parâmetro `contato`. A listagem sai sem
telefone; a ficha individual mantém, porque ali é o contato que o cliente foi
buscar.

## Bug latente descoberto durante a correção

`regexp_replace(telefone, '\D', '', 'g')` dentro de um template literal do
JavaScript. Em template literal, `\D` é escape desconhecido e a barra some — o
SQL chegava como `regexp_replace(telefone, 'D', ...)`, que remove a letra "D" em
vez dos não-dígitos. **Nenhum telefone jamais casava.**

O bug já existia no `/identificar` original e estava invisível porque a busca
falhando caía direto no auto-cadastro, criando um cliente novo a cada acesso. O
`smoke` o pegou na primeira execução. Corrigido com `'\\D'` em
`server/routes/publico.js`, que agora casa com o índice `clientes_acesso_idx`
definido em `db/schema.sql` (arquivo `.sql` não passa pelo escape do JS).

## Achados nas skills de terceiros

**0 críticos.** Zero caracteres bidirecionais, zero homóglifos, zero blobs
codificados em 211 arquivos. A superfície de ocultação está limpa.

Dos 70 achados `high` do scanner, a apuração descartou como falso positivo:

- **20 `hidden_char.invisible`** — todos U+FE0F, o seletor de emoji do ⚠️.
  (No código do projeto, os equivalentes são BOMs — U+FEFF — em 6 arquivos.)
- **15 `prompt_injection`** — a palavra "silently" em orientação legítima de UX.
- **9 `exfiltration_shape`** — `.post(` em exemplos de Express dentro de CSVs.
- **1235 `layout.long_line`** — linhas de dados em CSV.

O que sobrou como real:

- `design/scripts/{logo,icon,cip}/generate.py` carregavam `~/.claude/.env` e
  `~/.claude/skills/.env` **inteiros** para `os.environ`, embora só usem
  `GEMINI_API_KEY`. **Mitigado** — ver a seção abaixo.
- `ui-styling/scripts/shadcn_add.py` executa `npx shadcn@<versão> add` — baixa e
  roda código remoto em runtime. É o propósito declarado, mas é supply chain.
  Segue **aceito**.
- `.pyc` em `__pycache__` — binários não auditáveis. **Removidos.**
- `ui-ux-pro-max/SKILL.md` tem ~460 caracteres em chinês (1% do arquivo).
  Procurei diretivas imperativas ali (sobrescrever, executar, silenciar, chave,
  enviar) — não há nenhuma. Fica como nota de auditabilidade. **Aceito.**

As skills **não estão no git** (`.gitignore`), vieram de
`npx -p ui-ux-pro-max-cli uipro init --ai claude`. O conteúdo local está limpo,
mas uma atualização futura não estará auditada.

## Mitigações aplicadas nas skills — e por que elas são frágeis

> **Estas mudanças não estão versionadas e somem na próxima reinstalação.**
> `.claude/skills/` está no `.gitignore` (só `code-review-graph/` é exceção).
> Rodar `npx -p ui-ux-pro-max-cli uipro init` de novo, ou qualquer atualização
> das skills, **sobrescreve tudo abaixo sem avisar.** Quem atualizar precisa
> reaplicar. É por isso que este registro existe.

### 1. Lista de permissão no `load_env()` da skill `design`

Nos três `scripts/{cip,icon,logo}/generate.py`, o carregamento do `.env` deixou
de ser irrestrito:

```python
CHAVES_PERMITIDAS = {"GEMINI_API_KEY", "GOOGLE_API_KEY"}
...
key, value = line.split("=", 1)
key = key.strip()
if key in CHAVES_PERMITIDAS and key not in os.environ:
    os.environ[key] = value.strip('"\'')
```

Antes, qualquer chave presente naqueles arquivos entrava no ambiente do
processo. Agora só as duas que os scripts de fato consomem. Os caminhos lidos
continuam os mesmos e nenhum deles alcança o `.env.local` deste projeto.

### 2. Bytecode removido

Apagados os `__pycache__/` sob `.claude/skills/`. Todos os `.pyc` tinham o `.py`
correspondente ao lado, então são regeneráveis. Um `.pyc` é binário: não dá para
auditar lendo, e um adulterado pode divergir do `.py` que está ao lado.

### 3. Como reauditar

```bash
# Windows: use `python`, não `python3`. PYTHONIOENCODING evita o crash de
# console ao imprimir caracteres não-ASCII (cp1252).
set PYTHONIOENCODING=utf-8
python %USERPROFILE%\.claude\skills\skill-auditor\scripts\scan_skill.py .claude\skills\<nome> --json rel.json
```

**Não leia a contagem de achados como medida de risco.** O scanner casa padrões
de texto: a mitigação 1 mudou o comportamento e a contagem de
`capability.credential_access` não caiu — os literais `.env` e `GEMINI_API_KEY`
continuam no arquivo, e a própria linha de mitigação contém um deles. O scanner
também **ignora `__pycache__`**, então os `.pyc` nunca apareceram no inventário
dele. Julgue pelo diff e pelo alcance, nunca pelo número.

## O que já estava certo e deve ser preservado

- SQL 100% parametrizado: tagged templates do Neon e `$n` em `sql.query`.
- O filtro `barbeiro_id` centralizado em `server/crud.js` — boa decisão de
  segurança, escrita uma vez só para que nenhuma rota consiga esquecê-la.
- bcrypt com custo 12; mensagem de erro uniforme no login; bloqueio por e-mail
  (não por IP) em `server/tentativas.js`.
- Cookie `httpOnly` + `sameSite` + `secure` em produção; `JWT_SECRET` validado
  em tamanho; erros 500 genéricos que não vazam estrutura do banco.
- `.env.local` **nunca foi commitado** — confirmado no histórico completo.

## Verificação da correção

Lint limpo, build OK, migração aplicada no Neon, e `npm run smoke` passou
inteiro — incluindo 11 asserções novas que cobrem a área do cliente: código
gerado no cadastro, telefone sozinho recusado, código errado recusado, rota
negada sem sessão, entrada válida, telefone não devolvido na resposta, histórico
lido pela sessão, avaliação exigindo visita, reavaliação substituindo, contagem
única no banco, e token de cliente não virando sessão de dono.

O scanner foi reexecutado sobre o código alterado: nenhum caractere oculto novo.

## Pendência conhecida (não é segurança)

`resumoBarbearia` em `server/routes/publico.js` devolve endereço, bairro, cidade
e comodidades **fixos e inventados**, e usa `4.9` com `12 avaliações` como
padrão quando não há nenhuma. Isso chega ao cliente final como se fosse dado
real. Não foi corrigido: mexer ali muda o que a tela exibe e é decisão de
produto, não de segurança.

## Limites honestos desta auditoria

Análise estática não prova ausência de ameaça. As skills estão limpas quanto ao
que se detecta lendo; ofuscação nova escapa de regra fixa. Para instalação de
alto risco, combine com execução em sandbox descartável, menor privilégio e
humano no circuito para ações irreversíveis.

---

## Ferramenta de apoio

`.claude/skills/code-review-graph/SKILL.md` — adaptação do
[code-review-graph](https://github.com/tirth8205/code-review-graph) (MIT) para
este repositório: revisar pelo grafo de código em vez de varrer arquivos, com a
tabela dos acoplamentos por string que o grafo **não** enxerga. A ferramenta
ainda não está instalada; instalá-la é dependência nova e, pela regra do topo
deste documento, precisa ser reportada e aprovada.
