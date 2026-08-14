-- ControlCRM — Barbearia · schema Postgres (Neon)
--
-- Idempotente: `npm run db:migrate` pode rodar quantas vezes quiser e nunca
-- apaga dados. Para recriar do zero use `npm run db:reset` (destrutivo).
--
-- Dois princípios que atravessam o schema:
--
--   1. Todo registro pertence a um `barbeiro_id` (o dono da conta). Toda
--      consulta filtra por ele usando o id do cookie de sessão, nunca um id
--      vindo do navegador. É o que separa uma barbearia da outra.
--
--   2. Dinheiro que já aconteceu é fato consumado, não consulta. Visitas e
--      agendamentos congelam valor, percentual de comissão, duração e os nomes
--      envolvidos. Reajustar um preço hoje não pode reescrever o mês passado.

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

-- ── Contas ────────────────────────────────────────────────────────────────────

-- Quem assinou o sistema: uma linha por barbearia.
create table if not exists barbeiros (
  id          uuid primary key default gen_random_uuid(),
  nome        text        not null,
  barbearia   text        not null,
  email       text        not null,
  whatsapp    text        not null default '',
  senha_hash  text        not null,
  criado_em   timestamptz not null default now()
);

create unique index if not exists barbeiros_email_uk on barbeiros (lower(email));

-- Cadastro é fechado: só cria conta quem tem um código válido e não usado.
create table if not exists convites (
  id         uuid primary key default gen_random_uuid(),
  codigo     text        not null,
  observacao text        not null default '',
  criado_em  timestamptz not null default now(),
  usado_em   timestamptz,
  usado_por  uuid        references barbeiros(id) on delete set null
);

create unique index if not exists convites_codigo_uk on convites (upper(codigo));

-- ── Catálogo da barbearia ─────────────────────────────────────────────────────

-- Barbeiros que trabalham na barbearia. Não têm login: quem acessa o sistema é
-- o dono da conta. `ativo` em vez de remoção, para não perder o histórico de
-- quem já saiu da equipe.
-- Unidades (filiais) de uma conta.
--
-- Quem compra o SaaS é o dono (`barbeiros`). Ele pode ter mais de uma loja
-- física, e é a UNIDADE — não a conta — que tem teto de funcionários. Toda
-- conta tem pelo menos uma unidade: o cadastro cria a "Unidade principal"
-- junto com a conta, para nunca existir equipe sem casa.
create table if not exists unidades (
  id          uuid        primary key default gen_random_uuid(),
  barbeiro_id uuid        not null references barbeiros(id) on delete cascade,
  nome        text        not null,
  endereco    text        not null default '',
  ativo       boolean     not null default true,
  criado_em   timestamptz not null default now()
);

create index if not exists unidades_barbeiro_idx on unidades (barbeiro_id, nome);

create table if not exists equipe (
  id          uuid primary key default gen_random_uuid(),
  barbeiro_id uuid        not null references barbeiros(id) on delete cascade,
  nome        text        not null,
  ativo       boolean     not null default true,
  criado_em   timestamptz not null default now()
);

create index if not exists equipe_barbeiro_idx on equipe (barbeiro_id, ativo, nome);

create table if not exists servicos (
  id           uuid primary key default gen_random_uuid(),
  barbeiro_id  uuid          not null references barbeiros(id) on delete cascade,
  nome         text          not null,
  duracao_min  integer       not null default 30 check (duracao_min > 0 and duracao_min <= 480),
  preco        numeric(10,2) not null default 0 check (preco >= 0),
  comissao_pct numeric(5,2)  not null default 40 check (comissao_pct >= 0 and comissao_pct <= 100),
  ativo        boolean       not null default true,
  criado_em    timestamptz   not null default now()
);

create index if not exists servicos_barbeiro_idx on servicos (barbeiro_id, ativo, nome);

create table if not exists produtos (
  id          uuid primary key default gen_random_uuid(),
  barbeiro_id uuid          not null references barbeiros(id) on delete cascade,
  nome        text          not null,
  preco       numeric(10,2) not null default 0 check (preco >= 0),
  quantidade  integer       not null default 0 check (quantidade >= 0),
  minimo      integer       not null default 0 check (minimo >= 0),
  criado_em   timestamptz   not null default now()
);

create index if not exists produtos_barbeiro_idx on produtos (barbeiro_id, nome);

-- ── Clientes ──────────────────────────────────────────────────────────────────

-- `codigo_acesso` é a senha do cliente na área pública.
--
-- Existe porque não há canal de verificação (WhatsApp/SMS) no projeto: sem ele,
-- o telefone seria a única credencial, e quem soubesse o número entraria como o
-- cliente. Como o barbeiro cadastra cada cliente à mão, o código nasce junto com
-- a ficha e é entregue pessoalmente — a prova de posse acontece no balcão, não
-- por mensagem.
--
-- Não é hash: é um código curto, descartável e visível ao barbeiro na ficha (ele
-- precisa poder ler para ditar). O que ele protege é o histórico do cliente, e o
-- custo de trocá-lo é zero. Se um dia guardar algo mais sensível, vira hash.
create table if not exists clientes (
  id            uuid primary key default gen_random_uuid(),
  barbeiro_id   uuid        not null references barbeiros(id) on delete cascade,
  nome          text        not null,
  telefone      text        not null default '',
  tipo          text        not null default 'avulso' check (tipo in ('assinante', 'avulso')),
  obs           text        not null default '',
  equipe_pref   uuid        references equipe(id) on delete set null,
  codigo_acesso text        not null default '',
  criado_em     timestamptz not null default now()
);

create index if not exists clientes_barbeiro_idx on clientes (barbeiro_id, nome);

-- ── Atendimentos ──────────────────────────────────────────────────────────────

-- Visitas = atendimentos concluídos. É o livro-caixa: alimenta o histórico da
-- ficha, o faturamento e as comissões. Nasce da baixa de pagamento na agenda,
-- do "atender" na fila, ou de registro manual na ficha.
--
-- Os campos *_nome são cópias do momento do atendimento, e os *_id apontam para
-- o cadastro atual. Apagar um cliente, serviço ou barbeiro anula o id mas
-- preserva o nome — e, principalmente, preserva o dinheiro no caixa.
create table if not exists visitas (
  id           uuid primary key default gen_random_uuid(),
  barbeiro_id  uuid          not null references barbeiros(id) on delete cascade,

  cliente_id   uuid          references clientes(id) on delete set null,
  cliente_nome text          not null,
  servico_id   uuid          references servicos(id) on delete set null,
  servico_nome text          not null,
  equipe_id    uuid          references equipe(id) on delete set null,
  equipe_nome  text          not null default '',

  data         date          not null default (now() at time zone 'America/Sao_Paulo')::date,
  valor        numeric(10,2) not null default 0,
  comissao_pct numeric(5,2)  not null default 0,

  origem       text          not null default 'manual' check (origem in ('manual', 'agenda', 'fila')),
  criado_em    timestamptz   not null default now()
);

create index if not exists visitas_barbeiro_idx on visitas (barbeiro_id, data desc);
create index if not exists visitas_cliente_idx  on visitas (cliente_id, data desc);
create index if not exists visitas_equipe_idx   on visitas (equipe_id, data desc);

-- Agendamentos ocupam um intervalo, não um instante: `periodo` é derivado de
-- data + hora_inicio + duracao_min. A restrição de exclusão impede, no próprio
-- banco, que dois atendimentos não cancelados se sobreponham para o mesmo
-- barbeiro — inclusive quando duas pessoas marcam ao mesmo tempo.
create table if not exists agendamentos (
  id           uuid primary key default gen_random_uuid(),
  barbeiro_id  uuid          not null references barbeiros(id) on delete cascade,

  cliente_id   uuid          references clientes(id) on delete set null,
  cliente_nome text          not null,
  servico_id   uuid          references servicos(id) on delete set null,
  servico_nome text          not null,
  equipe_id    uuid          references equipe(id) on delete set null,
  equipe_nome  text          not null default '',

  data         date          not null,
  hora_inicio  time          not null,
  duracao_min  integer       not null default 30 check (duracao_min > 0 and duracao_min <= 480),
  valor        numeric(10,2) not null default 0,
  comissao_pct numeric(5,2)  not null default 0,

  status       text          not null default 'Confirmado' check (status in ('Confirmado', 'Pago', 'Cancelado')),
  criado_em    timestamptz   not null default now(),

  periodo      tsrange generated always as (
                 tsrange(
                   (data + hora_inicio),
                   (data + hora_inicio) + make_interval(mins => duracao_min),
                   '[)'
                 )
               ) stored
);

create index if not exists agendamentos_barbeiro_idx on agendamentos (barbeiro_id, data, hora_inicio);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agendamentos_sem_sobreposicao') then
    alter table agendamentos add constraint agendamentos_sem_sobreposicao
      exclude using gist (equipe_id with =, periodo with &&)
      where (status <> 'Cancelado' and equipe_id is not null);
  end if;
end $$;

create table if not exists fila_espera (
  id           uuid primary key default gen_random_uuid(),
  barbeiro_id  uuid        not null references barbeiros(id) on delete cascade,
  cliente_id   uuid        references clientes(id) on delete set null,
  nome         text        not null,
  servico_id   uuid        references servicos(id) on delete set null,
  servico_nome text        not null,
  equipe_id    uuid        references equipe(id) on delete set null,
  tipo         text        not null default 'avulso' check (tipo in ('assinante', 'avulso')),
  entrou_em    timestamptz not null default now()
);

create index if not exists fila_barbeiro_idx on fila_espera (barbeiro_id, entrou_em);

-- ── Assinaturas (clube do cliente) ────────────────────────────────────────────
-- O sistema registra quem vence quando; a cobrança acontece fora dele. Dar
-- baixa no pagamento empurra `vencimento` para o mês seguinte. "Vencida" não é
-- status gravado: é vencimento < hoje, para não depender de rotina diária.

create table if not exists planos (
  id          uuid primary key default gen_random_uuid(),
  barbeiro_id uuid          not null references barbeiros(id) on delete cascade,
  nome        text          not null,
  preco       numeric(10,2) not null default 0 check (preco >= 0),
  incluidos   text[]        not null default '{}',
  ativo       boolean       not null default true,
  criado_em   timestamptz   not null default now()
);

create index if not exists planos_barbeiro_idx on planos (barbeiro_id, ativo);

create table if not exists assinaturas (
  id          uuid primary key default gen_random_uuid(),
  barbeiro_id uuid        not null references barbeiros(id) on delete cascade,
  cliente_id  uuid        not null references clientes(id) on delete cascade,
  plano_id    uuid        not null references planos(id) on delete cascade,
  inicio      date        not null default (now() at time zone 'America/Sao_Paulo')::date,
  vencimento  date        not null,
  status      text        not null default 'ativa' check (status in ('ativa', 'cancelada')),
  criado_em   timestamptz not null default now()
);

-- Um cliente não pode ter duas assinaturas ativas ao mesmo tempo.
create unique index if not exists assinaturas_cliente_ativa_uk
  on assinaturas (cliente_id) where (status = 'ativa');

create index if not exists assinaturas_barbeiro_idx on assinaturas (barbeiro_id, vencimento);

-- ── Despesas ──────────────────────────────────────────────────────────────────

create table if not exists despesas (
  id          uuid primary key default gen_random_uuid(),
  barbeiro_id uuid          not null references barbeiros(id) on delete cascade,
  descricao   text          not null,
  valor       numeric(10,2) not null default 0 check (valor >= 0),
  data        date          not null default (now() at time zone 'America/Sao_Paulo')::date,
  status      text          not null default 'Pago' check (status in ('Pago', 'Pendente')),
  criado_em   timestamptz   not null default now()
);

create index if not exists despesas_barbeiro_idx on despesas (barbeiro_id, data desc);

-- ── Área do Cliente (Pública) ──────────────────────────────────────────────────

create table if not exists favoritos (
  id          uuid primary key default gen_random_uuid(),
  cliente_id  uuid not null references clientes(id) on delete cascade,
  barbeiro_id uuid not null references barbeiros(id) on delete cascade,
  criado_em   timestamptz not null default now(),
  unique(cliente_id, barbeiro_id)
);

create table if not exists avaliacoes (
  id          uuid primary key default gen_random_uuid(),
  cliente_id  uuid not null references clientes(id) on delete cascade,
  barbeiro_id uuid not null references barbeiros(id) on delete cascade,
  nota        integer not null check (nota >= 1 and nota <= 5),
  texto       text not null default '',
  criado_em   timestamptz not null default now()
);

create index if not exists avaliacoes_barbeiro_idx on avaliacoes (barbeiro_id, criado_em desc);

-- ── Ajustes incrementais ──────────────────────────────────────────────────────
--
-- `create table if not exists` não mexe em tabela que já existe: bancos criados
-- antes destas colunas precisam do ALTER. Tudo aqui é idempotente e roda depois
-- das tabelas, na mesma passada do `npm run db:migrate`.

-- Código de acesso do cliente à área pública (ver comentário em `clientes`).
alter table clientes add column if not exists codigo_acesso text not null default '';

-- Fichas antigas nasceram sem código. Gera um para cada uma, no mesmo alfabeto
-- sem ambiguidade usado pelo servidor (server/codigoAcesso.js): sem O/0/I/1.
update clientes
   set codigo_acesso = (
     select string_agg(
       substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
              1 + floor(random() * 32)::int, 1), '')
     from generate_series(1, 6)
   )
 where codigo_acesso = '';

-- Login público: telefone só com dígitos + código.
create index if not exists clientes_acesso_idx
  on clientes (regexp_replace(telefone, '\D', '', 'g'), codigo_acesso);

-- Quando a senha desta conta foi trocada pela última vez.
--
-- É o que permite derrubar sessões: o cookie carrega um JWT auto-contido, e
-- apagar o cookie de um navegador não invalida a cópia que outra pessoa tenha
-- levado. `server/auth.js` recusa todo token assinado antes deste carimbo, e
-- `POST /api/auth/senha` o atualiza — então trocar a senha porque alguém entrou
-- na conta realmente expulsa essa pessoa, em vez de só mudar o que ela já não
-- precisa saber.
--
-- Nulo (o padrão, e o valor de toda conta que existia antes desta coluna)
-- significa "nunca trocada": nenhuma sessão é recusada, e as de hoje seguem
-- valendo. Ninguém é deslogado por causa desta migração.
alter table barbeiros add column if not exists senha_alterada_em timestamptz;

-- Uma avaliação por cliente em cada barbearia. Sem isto, a mesma pessoa
-- reavalia em laço e move a média pública da barbearia sozinha.
-- Duplicatas anteriores: mantém a mais recente e apaga o resto.
delete from avaliacoes a
 using avaliacoes b
 where a.cliente_id = b.cliente_id
   and a.barbeiro_id = b.barbeiro_id
   and (a.criado_em, a.id) < (b.criado_em, b.id);

create unique index if not exists avaliacoes_cliente_barbeiro_uk
  on avaliacoes (cliente_id, barbeiro_id);

-- ── Limites de uso (rate limit e bloqueio de login) ───────────────────────────
--
-- Estes contadores viviam em `Map` na memória do processo. Funcionava com UMA
-- instância e mais nada: com duas, cada processo tinha a sua contagem e o
-- limite real virava o dobro do configurado; um restart zerava tudo, e quem
-- estava sendo barrado voltava a tentar do zero.
--
-- No banco, as instâncias compartilham a mesma contagem e o limite volta a ser
-- o que está escrito. O preço é uma ida ao banco por requisição limitada — vale
-- a pena porque é justamente sob ataque que o limite precisa estar certo.
--
-- `chave` carrega o escopo no prefixo: 'ip:<rota>:<ip>' ou 'login:<email>'.
create table if not exists limites_uso (
  chave     text        primary key,
  contagem  int         not null default 0,
  expira_em timestamptz not null
);

-- Para a limpeza periódica varrer só o que venceu.
create index if not exists limites_uso_expira_idx on limites_uso (expira_em);

-- ── Unidades e o teto de funcionários ─────────────────────────────────────────
--
-- A ORDEM aqui não é acidental. A coluna e o backfill vêm ANTES da trigger de
-- limite: assim uma conta que já tenha mais gente do que o teto mantém todo
-- mundo (fica com direito adquirido) e só é impedida de crescer. Criar a
-- trigger primeiro faria a própria migração falhar nesses casos.

alter table equipe add column if not exists unidade_id uuid references unidades(id) on delete cascade;

-- Toda conta ganha a unidade principal, se ainda não tiver nenhuma.
insert into unidades (barbeiro_id, nome)
select b.id, 'Unidade principal'
  from barbeiros b
 where not exists (select 1 from unidades u where u.barbeiro_id = b.id);

-- Equipe existente vai para a unidade mais antiga da conta.
update equipe e
   set unidade_id = (
     select u.id from unidades u
      where u.barbeiro_id = e.barbeiro_id
      order by u.criado_em, u.id
      limit 1
   )
 where e.unidade_id is null;

alter table equipe alter column unidade_id set not null;

create index if not exists equipe_unidade_idx on equipe (unidade_id);

-- Fonte única do teto. A aplicação LÊ este valor em vez de repetir o número:
-- um limite escrito em dois lugares vira dois limites diferentes.
-- Fase de validação: 3 funcionários ativos por unidade.
create or replace function cc_limite_equipe_por_unidade() returns int
  language sql immutable as $$ select 3 $$;

-- O teto mora no banco, não só na rota.
--
-- Só contam os ATIVOS: desativar quem saiu libera a vaga, que é o que se
-- espera de "3 funcionários por unidade". E o `for update` na unidade não é
-- zelo excessivo — sem ele, dois cadastros simultâneos passariam os dois pelo
-- count e a quarta pessoa entraria.
create or replace function cc_checa_limite_equipe() returns trigger
language plpgsql as $$
declare
  ocupadas int;
  teto     int := cc_limite_equipe_por_unidade();
begin
  -- Inativo não ocupa vaga.
  if new.ativo is not true then
    return new;
  end if;

  -- Num UPDATE que não mexe em unidade nem reativa ninguém, nada muda.
  if tg_op = 'UPDATE' and old.ativo is true and new.unidade_id = old.unidade_id then
    return new;
  end if;

  perform 1 from unidades where id = new.unidade_id for update;

  select count(*) into ocupadas
    from equipe
   where unidade_id = new.unidade_id
     and ativo
     and id <> new.id;

  if ocupadas >= teto then
    raise exception 'LIMITE_EQUIPE_UNIDADE:%', teto
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists equipe_limite_por_unidade on equipe;
create trigger equipe_limite_por_unidade
  before insert or update of unidade_id, ativo on equipe
  for each row execute function cc_checa_limite_equipe();

