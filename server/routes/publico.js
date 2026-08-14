import { Router } from "express";
import { sql } from "../db.js";
import { criarSessaoCliente, encerrarSessaoCliente, exigirCliente } from "../auth.js";
import { normalizarCodigo } from "../codigoAcesso.js";

const router = Router();

const ESFERA_HORARIOS = [
  "08:00", "09:00", "10:00", "11:00",
  "14:00", "15:00", "16:00", "17:00", "18:00", "19:00",
];

const limpaTelefone = (t) => String(t || "").replace(/\D/g, "");

const eUUID = (str) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(str || ""));

const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

// Hoje em Brasília, como 'YYYY-MM-DD'.
//
// O resto do projeto pergunta isso ao Postgres
// (`(now() at time zone 'America/Sao_Paulo')::date`). Aqui a resposta é
// necessária ANTES de tocar no banco, para recusar a requisição sem gastar
// consulta — e `new Date()` sozinho daria o dia em UTC, que vira o dia seguinte
// depois das 21h de Brasília. `en-CA` é o locale que formata em ISO.
const hojeEmBrasilia = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

// Até onde a agenda pública aceita marcação. Sem teto, uma sessão de cliente
// pode semear agendamentos em 2099 — que ninguém vê na tela do dono (a agenda
// abre na semana corrente) e ficam ocupando horário para sempre.
const HORIZONTE_DIAS = 180;

// Iniciais e cor do selo da barbearia, derivadas do nome.
//
// A tela desenha um quadrado com a sigla sobre um degradê (ver LogoLoja em
// src/cliente/ui.jsx). Os dois campos vinham do antigo modo demonstração e a
// rota nunca os mandou: sem eles o selo saía vazio e sem cor. Derivar do nome
// mantém a mesma barbearia sempre com a mesma cor, sem coluna nova no banco.
const PALETA = ["#7C3AED", "#fc570a", "#0EA5E9", "#10B981", "#F59E0B", "#EC4899"];

const siglaDe = (nome) =>
  String(nome || "Barbearia")
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map(p => p[0].toUpperCase()).join("") || "B";

const corDe = (chave) => {
  let soma = 0;
  for (const c of String(chave || "")) soma = (soma + c.charCodeAt(0)) % 997;
  return PALETA[soma % PALETA.length];
};

// Só o que a barbearia realmente informou.
//
// Esta função devolvia endereço "Rua Principal, 100", bairro "Centro", cidade
// "São Paulo - SP", nota 4,9 com 12 avaliações, foto de capa e logo de banco de
// imagens, um texto "sobre" genérico, comodidades e horário de funcionamento —
// tudo fixo no código, igual para toda barbearia, inventado. Chegava ao cliente
// final como se fosse informação real da loja que ele ia visitar.
//
// Campo que o sistema não coleta não é devolvido. Quando existir cadastro de
// endereço e horário, eles entram aqui vindos do banco.
//
// `contato` decide se o telefone do dono entra na resposta. Na ficha de UMA
// barbearia ele é informação de negócio: quem abriu a página quer ligar. Já na
// LISTA, devolver o telefone de todas entrega, numa requisição sem
// autenticação, a agenda inteira de donos do sistema — pronta para spam.
const resumoBarbearia = (b, { contato = false } = {}) => ({
  id: b.id,
  nome: b.barbearia || "Barbearia",
  dono: b.nome || "Proprietário",
  sigla: siglaDe(b.barbearia),
  cor: corDe(b.id || b.barbearia),
  telefone: contato ? b.whatsapp || "" : "",
  whatsapp: contato ? b.whatsapp || "" : "",
});

// 1. POST /api/publico/identificar
//
// Entrada da área do cliente. Exige telefone E código de acesso — o código é
// gerado quando o barbeiro cadastra a ficha e entregue pessoalmente.
//
// Por que código, e não só telefone: sem canal de verificação (o projeto não
// tem integração de WhatsApp/SMS), o telefone não prova nada. Qualquer um que
// soubesse o número de um cliente veria o histórico dele, os valores gastos e
// poderia cancelar os agendamentos. O código é a prova de posse possível hoje —
// acontece no balcão, entre barbeiro e cliente.
//
// Esta rota também NÃO cria cadastro. Quem cadastra é o barbeiro, no painel.
// Antes, o auto-cadastro jogava todo cliente novo na PRIMEIRA barbearia do
// banco, independentemente de onde ele estava agendando — misturava a base de
// clientes entre contas diferentes.
router.post("/identificar", async (req, res) => {
  const telLimpo = limpaTelefone(req.body?.telefone);
  const codigo = normalizarCodigo(req.body?.codigo);

  if (telLimpo.length < 10) {
    return res.status(400).json({ erro: "Informe um número de WhatsApp válido (DDD + número)." });
  }
  if (!codigo) {
    return res.status(400).json({ erro: "Informe o código de acesso que a barbearia te passou." });
  }

  // `\\D` e não `\D`: num template literal do JS, `\D` é escape desconhecido e
  // a barra some — o SQL chegava como regexp_replace(telefone, 'D', ...), que
  // remove a letra D em vez dos não-dígitos, e o telefone nunca casava. A dupla
  // barra faz chegar `\D` no Postgres, igual ao índice clientes_acesso_idx
  // (que vive num .sql e por isso não passa por esse escape).
  const [cliente] = await sql`
    select id, nome, tipo
    from clientes
    where regexp_replace(telefone, '\\D', '', 'g') = ${telLimpo}
      and codigo_acesso = ${codigo}
    limit 1
  `;

  // Uma mensagem só para telefone desconhecido e código errado: separar as duas
  // transformaria a rota num verificador de "este número está cadastrado?".
  if (!cliente) {
    return res.status(401).json({
      erro: "Telefone ou código incorretos. Peça o código na sua barbearia.",
    });
  }

  criarSessaoCliente(res, cliente.id);
  res.json(cliente);
});

// 1b. POST /api/publico/sair
router.post("/sair", (req, res) => {
  encerrarSessaoCliente(res);
  res.json({ ok: true });
});

// 1c. GET /api/publico/eu — quem está na sessão (o front usa para retomar).
router.get("/eu", exigirCliente, (req, res) => {
  res.json({ id: req.cliente.id, nome: req.cliente.nome, tipo: req.cliente.tipo });
});

// 2. GET /api/publico/barbearias
router.get("/barbearias", async (req, res) => {
  const termo = (req.query.termo || "").trim().toLowerCase();
  // O join com `avaliacoes` existia só para a nota média que a listagem
  // mostrava — e que caía em 4,9 fixo quando não havia avaliação nenhuma.
  const barbeiros = await sql`
    select b.id, b.nome, b.barbearia, b.whatsapp
    from barbeiros b
    order by b.barbearia
  `;

  let resultado = barbeiros.map(b => resumoBarbearia(b));
  if (termo) {
    // Sem `cidade` — a busca por cidade filtrava contra "São Paulo - SP" fixo,
    // devolvido igual para toda barbearia. Sobra o que é real: nome e dono.
    resultado = resultado.filter(b =>
      b.nome.toLowerCase().includes(termo) ||
      b.dono.toLowerCase().includes(termo)
    );
  }

  res.json(resultado);
});

// 3. GET /api/publico/barbearias/:id
router.get("/barbearias/:id", async (req, res) => {
  if (!eUUID(req.params.id)) return res.status(404).json({ erro: "Barbearia não encontrada." });

  const [b] = await sql`
    select b.id, b.nome, b.barbearia, b.whatsapp
    from barbeiros b
    where b.id = ${req.params.id}
  `;
  if (!b) return res.status(404).json({ erro: "Barbearia não encontrada." });

  // `avaliacoes` sai daqui porque a aba de avaliações da ficha as lê.
  //
  // A rota nunca as devolveu: a tela vinha lendo `loja.avaliacoes`, campo que só
  // existia no antigo modo demonstração. Sem ele, `.length` de `undefined`
  // derrubava o React e a ficha abria em branco — e, mesmo sem quebrar, a aba
  // ficaria vazia para sempre, apesar de a tabela existir e a rota de avaliar
  // já gravar nela.
  //
  // O primeiro nome basta: quem avalia é cliente de uma barbearia, não precisa
  // ter o nome completo exposto para os outros clientes dela.
  const [servicos, equipe, avaliacoes] = await Promise.all([
    sql`select id, nome, preco::float8 as preco, duracao_min as duracao from servicos where barbeiro_id = ${b.id} and ativo = true order by nome`,
    // Sem `nota`: era 5.0 fixo no SQL, nota inventada para todo funcionário.
    sql`select id, nome, 'Barbeiro' as cargo from equipe where barbeiro_id = ${b.id} and ativo = true order by nome`,
    sql`
      select split_part(c.nome, ' ', 1) as nome, a.nota, a.texto,
             to_char(a.criado_em, 'YYYY-MM-DD') as data
        from avaliacoes a
        join clientes c on c.id = a.cliente_id
       where a.barbeiro_id = ${b.id}
       order by a.criado_em desc
       limit 30
    `,
  ]);

  // Ficha de uma barbearia só: aqui o telefone é o contato que o cliente veio buscar.
  const resumo = resumoBarbearia(b, { contato: true });
  res.json({
    ...resumo,
    servicos,
    avaliacoes,
    barbeiros: equipe.length ? equipe : [{ id: b.id, nome: b.nome, cargo: "Proprietário" }],
  });
});

// 4. GET /api/publico/barbearias/:barbeariaId/horarios
router.get("/barbearias/:barbeariaId/horarios", async (req, res) => {
  const { data, profissional } = req.query;
  if (!eUUID(req.params.barbeariaId)) return res.status(400).json({ erro: "Barbearia inválida." });
  if (!data) return res.status(400).json({ erro: "Informe a data." });

  let sqlEquipe = sql``;
  if (profissional && profissional !== "Qualquer") {
    if (eUUID(profissional)) {
      sqlEquipe = sql`and equipe_id = ${profissional}`;
    } else {
      sqlEquipe = sql`and equipe_nome = ${profissional}`;
    }
  }

  const agendados = await sql`
    select to_char(hora_inicio, 'HH24:MI') as hora
    from agendamentos
    where barbeiro_id = ${req.params.barbeariaId}
      and data = ${data}
      and status <> 'Cancelado'
      ${sqlEquipe}
  `;

  const ocupados = new Set(agendados.map(a => a.hora));
  const slots = ESFERA_HORARIOS.map(h => ({
    hora: h,
    livre: !ocupados.has(h),
  }));

  res.json(slots);
});

// 5. POST /api/publico/agendar
//
// `cliente_id` não vem mais do corpo: vem do cookie de sessão. Antes, mandar o
// id de outra pessoa criava agendamento no nome dela.
//
// ── Por que a validação aqui é tão estrita quanto a do painel ────────────────
//
// Esta rota é o único ponto do sistema em que um visitante autenticado como
// CLIENTE escreve na agenda de uma barbearia — e de QUALQUER barbearia, porque
// a listagem pública é aberta. A rota irmã do painel (server/routes/agenda.js)
// sempre conferiu formato de data e hora; aqui só se conferia se os campos
// estavam preenchidos, e o resto ia direto para o banco:
//
//   • `data` e `hora` malformados viravam erro do Postgres → 500 com stack no
//     log, em vez de um 400 que a tela sabe mostrar;
//   • nada exigia que a hora fosse uma das da grade, nem que a data fosse
//     futura: dava para marcar às 03:17 de um dia do ano passado;
//   • serviço ou profissional inexistente CAÍA no primeiro ativo da barbearia,
//     então um corpo de lixo ainda criava um agendamento de verdade.
//
// A restrição `agendamentos_sem_sobreposicao` impedia empilhar tudo no mesmo
// horário, mas não impedia varrer a grade. Agora entrada inválida é 400, e o
// único fallback que sobrou é o legítimo: "Qualquer" profissional.
router.post("/agendar", exigirCliente, async (req, res) => {
  const { barbearia_id, servico, profissional, data, hora } = req.body || {};
  if (!eUUID(barbearia_id)) return res.status(400).json({ erro: "Selecione a barbearia." });

  if (!DATA_ISO.test(String(data || ""))) {
    return res.status(400).json({ erro: "Data inválida." });
  }
  // A grade de horários é fixa e a própria rota /horarios só oferece estes —
  // aceitar qualquer 'HH:MM' deixaria marcar num horário que a barbearia não
  // atende e que nenhuma tela mostra.
  if (!ESFERA_HORARIOS.includes(String(hora || ""))) {
    return res.status(400).json({ erro: "Horário inválido." });
  }

  // Comparação de texto: as duas pontas são 'YYYY-MM-DD', formato em que a
  // ordem alfabética e a cronológica coincidem.
  const hoje = hojeEmBrasilia();
  if (data < hoje) return res.status(400).json({ erro: "Não é possível marcar em data passada." });

  const limite = new Date(`${hoje}T00:00:00Z`);
  limite.setUTCDate(limite.getUTCDate() + HORIZONTE_DIAS);
  if (data > limite.toISOString().slice(0, 10)) {
    return res.status(400).json({ erro: "Esta data está longe demais para marcar agora." });
  }

  const cliente = req.cliente;

  // Sem fallback: serviço que não é desta barbearia (ou não existe) é erro de
  // quem mandou, não convite para escolher outro no lugar dele.
  const [svc] = await sql`
    select id, nome, duracao_min, preco::float8, comissao_pct::float8
    from servicos
    where (id::text = ${String(servico)} or lower(nome) = ${String(servico || "").toLowerCase()})
      and barbeiro_id = ${barbearia_id}
      and ativo = true
    limit 1
  `;
  if (!svc) return res.status(400).json({ erro: "Serviço não encontrado nesta barbearia." });

  // ── Quem vai atender ─────────────────────────────────────────────────────────
  //
  // Três casos, e o terceiro é o que quase virou uma regressão aqui:
  //
  //   a) "Qualquer" (padrão da tela) → o primeiro barbeiro ativo.
  //   b) um barbeiro específico da equipe → tem que existir e estar ativo.
  //   c) barbearia SEM equipe cadastrada → o dono atende.
  //
  // O (c) não é caso de borda: `register` cria a conta com uma unidade e
  // NENHUM funcionário, e a ficha pública devolve o próprio dono na lista de
  // barbeiros quando `equipe` está vazia (ver a rota 3 acima). A tela manda o
  // nome dele de volta, e ele não está na tabela `equipe` — exigir que
  // estivesse tornaria impossível marcar em toda barbearia recém-cadastrada.
  //
  // Nos três casos `equipe_id` pode ser null (é o que já acontecia): o nome
  // fica congelado em `equipe_nome`, que é o que a agenda do dono mostra.
  const [barbearia] = await sql`
    select id, nome, barbearia, whatsapp from barbeiros where id = ${barbearia_id}
  `;
  if (!barbearia) return res.status(404).json({ erro: "Barbearia não encontrada." });

  const pediuQualquer = !profissional || String(profissional) === "Qualquer";
  const pedido = String(profissional ?? "");

  const equipeAtiva = await sql`
    select id, nome
    from equipe
    where barbeiro_id = ${barbearia_id} and ativo = true
    order by nome
  `;

  let eqId = null;
  let eqNome;

  if (!equipeAtiva.length) {
    // Caso (c): só o dono atende. Aceita "Qualquer" ou o nome/id dele —
    // qualquer outra coisa continua sendo 400.
    const eDono =
      pediuQualquer ||
      pedido === barbearia.id ||
      pedido.toLowerCase() === String(barbearia.nome || "").toLowerCase();
    if (!eDono) return res.status(400).json({ erro: "Profissional não encontrado nesta barbearia." });
    eqNome = barbearia.nome || "Proprietário";
  } else if (pediuQualquer) {
    eqId = equipeAtiva[0].id;
    eqNome = equipeAtiva[0].nome;
  } else {
    const eq = equipeAtiva.find(
      (e) => e.id === pedido || e.nome.toLowerCase() === pedido.toLowerCase()
    );
    if (!eq) return res.status(400).json({ erro: "Profissional não encontrado nesta barbearia." });
    eqId = eq.id;
    eqNome = eq.nome;
  }

  try {
    const [novo] = await sql`
      insert into agendamentos (
        barbeiro_id, cliente_id, cliente_nome, servico_id, servico_nome,
        equipe_id, equipe_nome, data, hora_inicio, duracao_min, valor, comissao_pct
      ) values (
        ${barbearia_id}, ${cliente.id}, ${cliente.nome},
        ${svc.id}, ${svc.nome}, ${eqId}, ${eqNome},
        ${data}, ${hora}, ${svc.duracao_min}, ${svc.preco}, ${svc.comissao_pct}
      )
      returning id, cliente_id, cliente_nome, servico_nome as servico, equipe_nome as profissional,
                to_char(data, 'YYYY-MM-DD') as data, to_char(hora_inicio, 'HH24:MI') as hora,
                valor::float8, status
    `;

    res.status(201).json({
      ...novo,
      barbearia: resumoBarbearia(barbearia, { contato: true }),
    });
  } catch (e) {
    if (e.message?.includes("agendamentos_sem_sobreposicao")) {
      return res.status(409).json({ erro: "Este horário já foi preenchido por outro cliente." });
    }
    throw e;
  }
});

// ── Área do cliente autenticado ───────────────────────────────────────────────
//
// Daqui para baixo o id do cliente vem SEMPRE de `exigirCliente`, ou seja do
// cookie assinado. As rotas antigas traziam o id na URL
// (`/clientes/:clienteId/...`) e o servidor acreditava nele: com um id em mãos
// dava para ler o histórico e os gastos de qualquer pessoa, e cancelar os
// agendamentos dela. O `/eu/` no caminho é literal — só existe "eu".

// 6. GET /api/publico/eu/inicio
router.get("/eu/inicio", exigirCliente, async (req, res) => {
  const clienteId = req.clienteId;

  const [favs, [proximo]] = await Promise.all([
    sql`
      select b.id, b.nome, b.barbearia, b.whatsapp
      from favoritos f
      join barbeiros b on b.id = f.barbeiro_id
      where f.cliente_id = ${clienteId}
    `,
    sql`
      select a.id, a.cliente_id, a.cliente_nome,
             to_char(a.data, 'YYYY-MM-DD') as data,
             to_char(a.hora_inicio, 'HH24:MI') as hora,
             a.servico_nome as servico, a.equipe_nome as profissional,
             a.valor::float8 as valor, a.status,
             b.id as barbearia_id, b.barbearia, b.nome as dono, b.whatsapp
      from agendamentos a
      join barbeiros b on b.id = a.barbeiro_id
      where a.cliente_id = ${clienteId}
        and a.status = 'Confirmado'
        and a.data >= (now() at time zone 'America/Sao_Paulo')::date
      order by a.data, a.hora_inicio
      limit 1
    `,
  ]);

  res.json({
    favoritas: favs.map(b => resumoBarbearia(b, { contato: true })),
    acessos: [],
    proximo: proximo ? { ...proximo, barbearia: resumoBarbearia({ id: proximo.barbearia_id, barbearia: proximo.barbearia, nome: proximo.dono, whatsapp: proximo.whatsapp }, { contato: true }) } : null,
  });
});

// 7. GET /api/publico/eu/horarios
router.get("/eu/horarios", exigirCliente, async (req, res) => {
  const clienteId = req.clienteId;
  const barbeariaId = req.query.barbearia;

  let filtroB = sql``;
  if (eUUID(barbeariaId)) {
    filtroB = sql`and a.barbeiro_id = ${barbeariaId}`;
  }

  const agendamentos = await sql`
    select a.id, a.cliente_id, a.cliente_nome,
           to_char(a.data, 'YYYY-MM-DD') as data,
           to_char(a.hora_inicio, 'HH24:MI') as hora,
           a.servico_nome as servico, a.equipe_nome as profissional,
           a.valor::float8 as valor, a.status,
           b.id as barbearia_id, b.barbearia, b.nome as dono, b.whatsapp
    from agendamentos a
    join barbeiros b on b.id = a.barbeiro_id
    where a.cliente_id = ${clienteId} ${filtroB}
    order by a.data desc, a.hora_inicio desc
  `;

  const hoje = new Date().toISOString().slice(0, 10);
  const comLoja = (a) => ({
    ...a,
    barbearia: resumoBarbearia({ id: a.barbearia_id, barbearia: a.barbearia, nome: a.dono, whatsapp: a.whatsapp }, { contato: true }),
  });

  const proximos = agendamentos
    .filter(a => a.status === "Confirmado" && a.data >= hoje)
    .map(comLoja);

  const passados = agendamentos
    .filter(a => a.status !== "Confirmado" || a.data < hoje)
    .map(comLoja);

  let filtroV = sql``;
  if (eUUID(barbeariaId)) filtroV = sql`and v.barbeiro_id = ${barbeariaId}`;

  const visitas = await sql`
    select v.id, v.cliente_id, v.cliente_nome,
           to_char(v.data, 'YYYY-MM-DD') as data,
           v.servico_nome as servico, v.equipe_nome as profissional,
           v.valor::float8 as valor,
           b.id as barbearia_id, b.barbearia, b.nome as dono, b.whatsapp
    from visitas v
    join barbeiros b on b.id = v.barbeiro_id
    where v.cliente_id = ${clienteId} ${filtroV}
    order by v.data desc, v.criado_em desc
    limit 20
  `;

  const historico = visitas.map(comLoja);

  const porProf = {};
  visitas.forEach(v => { if (v.profissional) porProf[v.profissional] = (porProf[v.profissional] || 0) + 1; });
  const favorito = Object.entries(porProf).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const totalGasto = visitas.reduce((sum, v) => sum + (v.valor || 0), 0);

  res.json({
    proximos,
    passados,
    historico,
    resumo: {
      visitas: visitas.length,
      totalGasto,
      favorito,
      tipo: req.cliente.tipo || "avulso",
    },
  });
});

// 8. POST /api/publico/eu/horarios/:id/cancelar
router.post("/eu/horarios/:id/cancelar", exigirCliente, async (req, res) => {
  const { id } = req.params;
  if (!eUUID(id)) return res.status(404).json({ erro: "Agendamento não encontrado." });

  // O `cliente_id` da cláusula continua sendo a trava: só cancela o que é seu.
  const [alterado] = await sql`
    update agendamentos set status = 'Cancelado'
    where id = ${id} and cliente_id = ${req.clienteId} and status = 'Confirmado'
    returning id
  `;
  if (!alterado) return res.status(404).json({ erro: "Agendamento não encontrado ou já alterado." });

  res.json({ ok: true });
});

// 9. GET /api/publico/eu/fidelidade/:barbeariaId
router.get("/eu/fidelidade/:barbeariaId", exigirCliente, async (req, res) => {
  const { barbeariaId } = req.params;
  if (!eUUID(barbeariaId)) {
    return res.json({ pontos: 0, visitas: 0, premios: [] });
  }

  const [resumo] = await sql`
    select count(*)::int as qtd, coalesce(sum(valor), 0)::float8 as total
    from visitas
    where cliente_id = ${req.clienteId} and barbeiro_id = ${barbeariaId}
  `;

  const pontos = Math.round(resumo?.total || 0);
  const premios = [
    { nome: "Pezinho grátis", custo: 300 },
    { nome: "Barba completa grátis", custo: 700 },
    { nome: "Corte + Barba grátis", custo: 1500 },
  ].map(p => ({ ...p, liberado: pontos >= p.custo }));

  res.json({
    pontos,
    visitas: resumo?.qtd || 0,
    premios,
  });
});

// 10. POST /api/publico/eu/favoritos/:barbeariaId
router.post("/eu/favoritos/:barbeariaId", exigirCliente, async (req, res) => {
  const { barbeariaId } = req.params;
  if (!eUUID(barbeariaId)) return res.status(400).json({ erro: "ID inválido." });

  const [existe] = await sql`
    select id from favoritos where cliente_id = ${req.clienteId} and barbeiro_id = ${barbeariaId}
  `;
  if (existe) {
    await sql`delete from favoritos where id = ${existe.id}`;
  } else {
    await sql`insert into favoritos (cliente_id, barbeiro_id) values (${req.clienteId}, ${barbeariaId})`;
  }

  // O front espera o estado novo para pintar o coração (Estabelecimento.jsx).
  res.json({ ok: true, favorito: !existe });
});

// 11. POST /api/publico/eu/avaliacoes/:barbeariaId
//
// Duas travas que não existiam:
//
//   1. Só avalia quem foi atendido. Antes, qualquer sessão avaliava qualquer
//      barbearia — inclusive uma onde nunca pôs os pés.
//   2. Uma avaliação por barbearia, garantida pelo índice único
//      `avaliacoes_cliente_barbeiro_uk`. Antes dava para inserir em laço e
//      mover sozinho a média pública da barbearia.
//
// Reavaliar agora substitui a nota anterior em vez de somar mais uma.
router.post("/eu/avaliacoes/:barbeariaId", exigirCliente, async (req, res) => {
  const { barbeariaId } = req.params;
  const nota = Number(req.body?.nota);
  const texto = (req.body?.texto || "").trim();

  if (!eUUID(barbeariaId)) return res.status(400).json({ erro: "ID inválido." });
  if (!Number.isInteger(nota) || nota < 1 || nota > 5) {
    return res.status(400).json({ erro: "Escolha de 1 a 5 estrelas." });
  }

  const [visita] = await sql`
    select id from visitas
    where cliente_id = ${req.clienteId} and barbeiro_id = ${barbeariaId}
    limit 1
  `;
  if (!visita) {
    return res.status(403).json({ erro: "Só é possível avaliar uma barbearia onde você já foi atendido." });
  }

  await sql`
    insert into avaliacoes (cliente_id, barbeiro_id, nota, texto)
    values (${req.clienteId}, ${barbeariaId}, ${nota}, ${texto})
    on conflict (cliente_id, barbeiro_id)
    do update set nota = excluded.nota, texto = excluded.texto, criado_em = now()
  `;

  res.json({ ok: true });
});

export default router;
