// Teste de fumaça: dispara contra a API exatamente os mesmos corpos que
// src/App.jsx manda, e confere os campos que as telas leem. É o que impede o
// front e o servidor de voltarem a discordar sobre nomes de campo.
//
//   npm run dev        (noutro terminal, a API precisa estar no ar)
//   npm run smoke
//
// Cria uma conta descartável e a apaga no fim — o cascade leva junto tudo que
// ela gerou. Precisa estar dentro do projeto para enxergar node_modules.
import { neon } from "@neondatabase/serverless";

const BASE = `http://localhost:${process.env.PORT || 3001}/api`;
const sql = neon(process.env.DATABASE_URL);

let cookie = "";
let falhas = 0;
const ok = (cond, texto, extra) => {
  console.log(`${cond ? "  ok  " : " FALHA"} ${texto}${extra !== undefined && !cond ? ` → ${JSON.stringify(extra)}` : ""}`);
  if (!cond) falhas++;
};

async function chamar(metodo, caminho, corpo) {
  const r = await fetch(BASE + caminho, {
    method: metodo,
    headers: {
      ...(corpo === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { cookie } : {}),
    },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const set = r.headers.getSetCookie?.() || [];
  if (set.length) cookie = set.map(c => c.split(";")[0]).join("; ");
  const texto = await r.text();
  let dados;
  try { dados = texto ? JSON.parse(texto) : null; } catch { dados = texto; }
  return { status: r.status, dados };
}

const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const codigo = "TEST-" + Array.from({ length: 6 }, (_, i) => ALFABETO[(Date.now() + i * 7) % 32]).join("");
const email = `smoke-${Date.now()}@teste.local`;
let barbeiroId = null;

try {
  // O rate limit agora vive no banco e sobrevive a restart (server/limiteStore.js).
  // Sem zerar o balde deste IP, rodar o smoke duas vezes seguidas estoura o
  // limite de /api/auth e as asserções falham por 429 sem nada estar quebrado.
  await sql`delete from limites_uso where chave like 'ip:%'`;

  console.log("\n── Cadastro direto (SaaS) ─────────────────────────────────");
  const cadastro = await chamar("POST", "/auth/register", {
    nome: "Dono Teste", barbearia: "Barbearia Fumaça",
    whatsapp: "(11) 99999-0000", email, senha: "segredo123",
  });
  ok(cadastro.status === 201, "cadastro direto cria a conta", cadastro);
  barbeiroId = cadastro.dados?.id;

  const eu = await chamar("GET", "/auth/me");
  ok(eu.dados?.barbearia === "Barbearia Fumaça", "sessão pelo cookie assinado");

  console.log("\n── Conta nasce vazia ────────────────────────────────────");
  for (const rec of ["servicos", "equipe", "produtos", "planos", "clientes", "despesas"]) {
    const r = await chamar("GET", `/${rec}`);
    ok(Array.isArray(r.dados) && r.dados.length === 0, `${rec} começa vazio`, r.dados);
  }

  console.log("\n── Cadastros (telas novas) ──────────────────────────────");
  const barbeiro = await chamar("POST", "/equipe", { nome: "Lucas Silva", ativo: true });
  ok(barbeiro.status === 201 && barbeiro.dados.ativo === true, "equipe: criar", barbeiro);

  const servico = await chamar("POST", "/servicos", { nome: "Corte + Barba", duracao_min: 45, preco: 75, comissao_pct: 45, ativo: true });
  ok(servico.status === 201, "serviços: criar", servico);
  ok(typeof servico.dados?.preco === "number", "serviços: preço volta como número, não string", servico.dados?.preco);

  const produto = await chamar("POST", "/produtos", { nome: "Pomada", preco: 8.5, quantidade: 10, minimo: 4 });
  ok(produto.status === 201, "produtos: criar", produto);
  const baixa = await chamar("PATCH", `/produtos/${produto.dados.id}`, { quantidade: 9 });
  ok(baixa.dados?.quantidade === 9 && baixa.dados?.nome === "Pomada", "produtos: baixa de 1 un preserva o resto", baixa.dados);

  console.log("\n── Clientes e agenda ────────────────────────────────────");
  const cliente = await chamar("POST", "/clientes", { nome: "João Cliente", telefone: "(11) 98888-0000", tipo: "avulso", equipe_pref: barbeiro.dados.id });
  ok(cliente.status === 201, "clientes: criar com barbeiro preferido", cliente);

  const listaClientes = await chamar("GET", "/clientes");
  ok(listaClientes.dados[0]?.equipe_pref_nome === "Lucas Silva", "clientes: nome do barbeiro preferido na listagem", listaClientes.dados[0]);

  const hoje = new Date();
  const dia = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}-${String(hoje.getDate()).padStart(2, "0")}`;

  const ag = await chamar("POST", "/agendamentos", {
    cliente_id: cliente.dados.id, cliente_nome: null, data: dia,
    hora_inicio: "09:00", servico_id: servico.dados.id, equipe_id: barbeiro.dados.id,
  });
  ok(ag.status === 201, "agenda: criar com servico_id/equipe_id", ag);
  ok(ag.dados?.hora_inicio === "09:00", "agenda: hora volta como HH:MM", ag.dados?.hora_inicio);
  ok(ag.dados?.duracao_min === 45 && ag.dados?.valor === 75 && ag.dados?.comissao_pct === 45,
    "agenda: duração, valor e comissão congelados do serviço", ag.dados);

  const choque = await chamar("POST", "/agendamentos", {
    cliente_id: null, cliente_nome: "Avulso", data: dia,
    hora_inicio: "09:30", servico_id: servico.dados.id, equipe_id: barbeiro.dados.id,
  });
  ok(choque.status === 409, "agenda: sobreposição de 09:30 sobre 09:00–09:45 recusada", choque);

  const semChoque = await chamar("POST", "/agendamentos", {
    cliente_id: null, cliente_nome: "Avulso Sem Ficha", data: dia,
    hora_inicio: "10:00", servico_id: servico.dados.id, equipe_id: barbeiro.dados.id,
  });
  ok(semChoque.status === 201, "agenda: 10:00 livre é aceito, e avulso sem ficha também", semChoque);

  const semana = await chamar("GET", `/agendamentos?inicio=${dia}&fim=${dia}`);
  ok(semana.dados?.every(a => a.servico_nome && a.equipe_nome && a.hora_inicio),
    "agenda: listagem traz servico_nome, equipe_nome e hora_inicio", semana.dados?.[0]);

  console.log("\n── Baixa, fila e visita manual ──────────────────────────");
  const pago = await chamar("POST", `/agendamentos/${ag.dados.id}/pagar`);
  ok(pago.status === 200 && pago.dados?.status === "Pago", "agenda: dar baixa", pago);

  const fila = await chamar("POST", "/fila", { cliente_id: null, nome: "Walk-in", servico_id: servico.dados.id, equipe_id: null, tipo: "avulso" });
  ok(fila.status === 201, "fila: entrar sem barbeiro definido", fila);
  const filaLista = await chamar("GET", "/fila");
  ok(filaLista.dados[0]?.servico_nome === "Corte + Barba" && filaLista.dados[0]?.equipe_id === null,
    "fila: listagem traz servico_nome e barbeiro vazio", filaLista.dados[0]);
  const atendido = await chamar("POST", `/fila/${fila.dados.id}/atender`, { equipe_id: barbeiro.dados.id });
  ok(atendido.status === 200, "fila: atender escolhendo quem atendeu", atendido);

  const manual = await chamar("POST", `/clientes/${cliente.dados.id}/visitas`, { servico_id: servico.dados.id, equipe_id: barbeiro.dados.id });
  ok(manual.status === 201, "ficha: registrar visita sem informar valor", manual);

  const historico = await chamar("GET", `/clientes/${cliente.dados.id}/visitas`);
  ok(historico.dados?.length === 2, "ficha: histórico com a baixa da agenda e a manual", historico.dados?.length);
  ok(historico.dados?.every(h => h.servico_nome && h.equipe_nome), "ficha: histórico usa servico_nome/equipe_nome", historico.dados?.[0]);

  console.log("\n── Reajuste não reescreve o passado ─────────────────────");
  await chamar("PATCH", `/servicos/${servico.dados.id}`, { preco: 120 });
  const depois = await chamar("GET", `/clientes/${cliente.dados.id}/visitas`);
  ok(depois.dados?.every(h => h.valor === 75), "visitas antigas seguem a R$ 75 depois do reajuste para R$ 120", depois.dados?.map(h => h.valor));

  console.log("\n── Assinaturas ──────────────────────────────────────────");
  const plano = await chamar("POST", "/planos", { nome: "Plano Teste", preco: 99, incluidos: ["Corte ilimitado"], ativo: true });
  ok(plano.status === 201, "planos: criar com serviços incluídos", plano);

  const assinatura = await chamar("POST", "/assinaturas", { cliente_id: cliente.dados.id, plano_id: plano.dados.id });
  ok(assinatura.status === 201, "assinaturas: criar", assinatura);
  const duplicada = await chamar("POST", "/assinaturas", { cliente_id: cliente.dados.id, plano_id: plano.dados.id });
  ok(duplicada.status === 409, "assinaturas: segunda ativa para o mesmo cliente é recusada", duplicada);

  const listaAss = await chamar("GET", "/assinaturas");
  ok(listaAss.dados[0]?.cliente_nome && listaAss.dados[0]?.plano_nome && listaAss.dados[0]?.vencida === false,
    "assinaturas: listagem traz cliente, plano e o cálculo de vencida", listaAss.dados[0]);
  const vencAntes = listaAss.dados[0].vencimento;
  const pagouAss = await chamar("POST", `/assinaturas/${assinatura.dados.id}/pagar`);
  ok(pagouAss.dados?.vencimento > vencAntes, "assinaturas: pagar empurra o vencimento", { vencAntes, depois: pagouAss.dados?.vencimento });

  const planosCom = await chamar("GET", "/planos");
  ok(planosCom.dados[0]?.assinantes === 1, "planos: listagem conta assinantes ativos", planosCom.dados[0]);
  const desativado = await chamar("PATCH", `/planos/${plano.dados.id}`, { ativo: false });
  ok(desativado.dados?.ativo === false && desativado.dados?.nome === "Plano Teste",
    "planos: desativar preserva nome, preço e incluídos", desativado.dados);

  console.log("\n── Despesas ─────────────────────────────────────────────");
  const gasto = await chamar("POST", "/despesas", { descricao: "Energia", valor: 680, data: dia, status: "Pendente" });
  ok(gasto.status === 201, "despesas: criar", gasto);
  const listaGastos = await chamar("GET", "/despesas");
  ok(listaGastos.dados[0]?.data === dia, "despesas: data volta como texto YYYY-MM-DD, sem virar UTC", listaGastos.dados[0]);
  const alternado = await chamar("PATCH", `/despesas/${gasto.dados.id}`, { descricao: "Energia", valor: 680, data: dia, status: "Pago" });
  ok(alternado.dados?.status === "Pago", "despesas: alternar status", alternado.dados);
  const conferindo = await chamar("GET", "/despesas");
  ok(conferindo.dados[0]?.data === dia, "despesas: a data continua no mesmo dia depois do PATCH", conferindo.dados[0]?.data);

  console.log("\n── Painéis ──────────────────────────────────────────────");
  const dash = await chamar("GET", "/dashboard");
  const d = dash.dados || {};
  ok(d.receitaMes === 225, "dashboard: receita do mês soma as 3 visitas de R$ 75", d.receitaMes);
  ok(d.comissoesMes === 101.25, "dashboard: comissões a 45%", d.comissoesMes);
  ok(d.mrr === 99 && d.assinaturasAtivas === 1, "dashboard: MRR e assinaturas ativas", { mrr: d.mrr, ativas: d.assinaturasAtivas });
  ok(d.estoqueBaixo === 0 && d.clientes === 1, "dashboard: estoque e clientes", { estoque: d.estoqueBaixo, clientes: d.clientes });
  ok(Array.isArray(d.semana) && d.semana.length === 7, "dashboard: série de 7 dias", d.semana?.length);
  ok(d.proximos?.[0]?.hora_inicio && d.proximos?.[0]?.servico_nome, "dashboard: próximos com hora_inicio/servico_nome", d.proximos?.[0]);
  ok(d.atividade?.[0]?.servico_nome, "dashboard: atividade com servico_nome", d.atividade?.[0]);

  const resumo = await chamar("GET", "/visitas/resumo");
  ok(resumo.dados?.porServico?.[0]?.servico_nome === "Corte + Barba", "resumo: por serviço usa servico_nome", resumo.dados?.porServico?.[0]);
  ok(resumo.dados?.porBarbeiro?.[0]?.equipe_id === barbeiro.dados.id && resumo.dados?.porBarbeiro?.[0]?.comissao === 101.25,
    "resumo: comissão por barbeiro casada por equipe_id", resumo.dados?.porBarbeiro?.[0]);

  const visitas = await chamar("GET", "/visitas?limite=500");
  ok(visitas.dados?.every(v => v.servico_nome && typeof v.comissao_valor === "number"),
    "visitas: listagem traz servico_nome e comissao_valor", visitas.dados?.[0]);

  console.log("\n── Defaults do CRUD genérico ────────────────────────────");
  // Campo ausente tem que cair no DEFAULT da tabela, não virar null explícito.
  const semData = await chamar("POST", "/despesas", { descricao: "Sem data", valor: 10, status: "Pago" });
  ok(semData.status === 201, "despesa sem `data` usa o default do banco em vez de violar not null", semData);
  ok(semData.dados?.data === dia, "e o default é hoje no fuso de Brasília", semData.dados?.data);

  // PATCH parcial não pode fazer a data dar a volta pelo UTC.
  const soStatus = await chamar("PATCH", `/despesas/${semData.dados.id}`, { status: "Pendente" });
  ok(soStatus.dados?.status === "Pendente", "PATCH parcial altera só o que veio", soStatus.dados?.status);
  ok(soStatus.dados?.data === dia, "e a data continua no mesmo dia", { esperado: dia, veio: soStatus.dados?.data });
  ok(soStatus.dados?.descricao === "Sem data" && soStatus.dados?.valor === 10,
    "os demais campos sobrevivem ao PATCH parcial", soStatus.dados);

  // Guardado antes das seções que trocam de sessão, para a área do cliente
  // conseguir voltar e ler o código gerado na ficha.
  const cookieDono = cookie;

  console.log("\n── Limite de tentativas de login ────────────────────────");
  // E-mail descartável e inexistente: o contador é por e-mail, então isto não
  // tranca a conta de teste nem nenhuma real. E provar que um e-mail que não
  // existe também é bloqueado é o ponto — se só contasse para e-mail
  // cadastrado, a diferença entregaria quem está na base.
  const alvo = `bruteforce-${codigo}@teste.local`;
  const tentar = () => chamar("POST", "/auth/login", { email: alvo, senha: "senha-errada" });

  const t1 = await tentar();
  const t2 = await tentar();
  ok(t1.status === 401 && t2.status === 401, "as duas primeiras tentativas erradas dão 401", [t1.status, t2.status]);

  const t3 = await tentar();
  ok(t3.status === 401, "a terceira ainda responde 401 (é ela que fecha a porta)", t3.status);

  const t4 = await tentar();
  ok(t4.status === 429, "a quarta é bloqueada com 429", t4);
  ok(/minuto/i.test(t4.dados?.erro || ""), "e a mensagem diz quanto tempo esperar", t4.dados?.erro);

  // Outro e-mail não pode ter sido afetado: o bloqueio é por conta, não global.
  const outro = await chamar("POST", "/auth/login", { email: `outro-${codigo}@teste.local`, senha: "x" });
  ok(outro.status === 401, "outro e-mail continua livre — o bloqueio não é global", outro.status);

  console.log("\n── Unidades e teto de funcionários ──────────────────────");
  const u0 = await chamar("GET", "/unidades");
  const teto = u0.dados?.limitePorUnidade;
  ok(teto === 3, "o teto da fase de validação é 3, e vem do banco", u0.dados);
  ok(u0.dados?.unidades?.length === 1 && u0.dados.unidades[0].nome === "Unidade principal",
    "o cadastro já cria a Unidade principal", u0.dados?.unidades);
  ok(u0.dados?.unidades?.[0]?.funcionarios === 1,
    "o funcionário criado sem unidade caiu na principal", u0.dados?.unidades?.[0]);

  // O teste do teto roda numa unidade separada, para não mexer na equipe que as
  // seções anteriores usaram nas comissões.
  const uT = await chamar("POST", "/unidades", { nome: "Unidade Teste" });
  ok(uT.status === 201 && uT.dados?.vagas === teto, "criar unidade nasce com todas as vagas", uT.dados);

  const ids = [];
  for (const nome of ["Func 1", "Func 2", "Func 3"]) {
    const r = await chamar("POST", "/equipe", { nome, unidade_id: uT.dados.id });
    if (r.status === 201) ids.push(r.dados.id);
  }
  ok(ids.length === 3, "os 3 primeiros entram na unidade", ids.length);

  const quarto = await chamar("POST", "/equipe", { nome: "Func 4", unidade_id: uT.dados.id });
  ok(quarto.status === 409, "o 4º é recusado com 409", quarto);
  ok(/limite|3/i.test(quarto.dados?.erro || ""), "e a mensagem explica o limite", quarto.dados?.erro);

  // A unidade principal segue com vaga: o teto é por unidade, não por conta.
  const naPrincipal = await chamar("POST", "/equipe", { nome: "Extra Principal" });
  ok(naPrincipal.status === 201, "a outra unidade continua aceitando (teto é por unidade)", naPrincipal.status);
  await chamar("DELETE", `/equipe/${naPrincipal.dados.id}`);

  await chamar("PATCH", `/equipe/${ids[2]}`, { ativo: false });
  const aposDesativar = await chamar("POST", "/equipe", { nome: "Func 4", unidade_id: uT.dados.id });
  ok(aposDesativar.status === 201, "desativar alguém libera a vaga", aposDesativar.status);

  const reativar = await chamar("PATCH", `/equipe/${ids[2]}`, { ativo: true });
  ok(reativar.status === 409, "reativar acima do teto é recusado", reativar.status);

  const apagarCheia = await chamar("DELETE", `/unidades/${uT.dados.id}`);
  ok(apagarCheia.status === 409, "não dá para apagar unidade com gente dentro", apagarCheia.dados?.erro);

  // Uma conta não pode cadastrar na unidade de outra.
  const cookieDesteDono = cookie;
  const outroEmail = `smoke2-${Date.now()}@teste.local`;
  cookie = "";
  const outra = await chamar("POST", "/auth/register", {
    nome: "Outro Dono", barbearia: "Outra Barbearia",
    whatsapp: "(11) 90000-0000", email: outroEmail, senha: "segredo123",
  });
  const invasao = await chamar("POST", "/equipe", { nome: "Intruso", unidade_id: uT.dados.id });
  ok(invasao.status === 400, "unidade de outra conta é rejeitada", invasao);
  await sql`delete from barbeiros where id = ${outra.dados.id}`;
  cookie = cookieDesteDono;

  console.log("\n── Área do cliente: telefone + código ───────────────────");
  cookie = cookieDono;
  const fichas = await chamar("GET", "/clientes");
  const ficha = fichas.dados?.find(c => c.id === cliente.dados.id);
  ok(/^[A-HJ-NP-Z2-9]{6}$/.test(ficha?.codigo_acesso || ""),
    "cadastro manual já gera o código de acesso", ficha?.codigo_acesso);

  cookie = "";
  const semCodigo = await chamar("POST", "/publico/identificar", { telefone: "(11) 98888-0000" });
  ok(semCodigo.status === 400, "só o telefone não entra", semCodigo.status);

  const codigoErrado = await chamar("POST", "/publico/identificar", {
    telefone: "(11) 98888-0000", codigo: "AAAAAA",
  });
  ok(codigoErrado.status === 401, "telefone certo com código errado não entra", codigoErrado.status);

  const semSessaoCliente = await chamar("GET", "/publico/eu/horarios");
  ok(semSessaoCliente.status === 401, "sem sessão de cliente, o histórico é negado", semSessaoCliente.status);

  const entrou = await chamar("POST", "/publico/identificar", {
    telefone: "(11) 98888-0000", codigo: ficha.codigo_acesso,
  });
  ok(entrou.status === 200 && entrou.dados?.nome === "João Cliente", "telefone + código entra", entrou);
  ok(entrou.dados?.telefone === undefined, "a resposta não devolve o telefone de volta", entrou.dados);

  const meus = await chamar("GET", "/publico/eu/horarios");
  ok(meus.status === 200 && Array.isArray(meus.dados?.historico),
    "o histórico vem pela sessão, sem id na URL", meus.status);

  // Uma avaliação por barbearia, e só de quem foi atendido de verdade.
  const av1 = await chamar("POST", `/publico/eu/avaliacoes/${barbeiroId}`, { nota: 5, texto: "Ótimo" });
  ok(av1.status === 200, "quem já foi atendido consegue avaliar", av1);
  const av2 = await chamar("POST", `/publico/eu/avaliacoes/${barbeiroId}`, { nota: 3, texto: "Mudei de ideia" });
  ok(av2.status === 200, "reavaliar é permitido (substitui a nota)", av2);
  const [{ qtd }] = await sql`
    select count(*)::int as qtd from avaliacoes where barbeiro_id = ${barbeiroId}
  `;
  ok(qtd === 1, "e continua existindo UMA avaliação, não duas", qtd);

  console.log("\n── Agendamento público: entrada validada ────────────────");
  //
  // Esta rota é o único lugar em que uma sessão de CLIENTE escreve na agenda de
  // uma barbearia — e de qualquer uma, porque a listagem é aberta. Ela só
  // conferia se `data` e `hora` estavam preenchidas: valor malformado virava
  // 500, hora fora da grade entrava, data passada entrava, e serviço ou
  // profissional inexistente CAÍA no primeiro ativo do catálogo — um corpo de
  // lixo criava agendamento de verdade. A sessão de cliente segue ativa do
  // bloco acima.
  const daquiA = (dias) => {
    const d = new Date();
    d.setDate(d.getDate() + dias);
    return d.toISOString().slice(0, 10);
  };
  // Três dias de margem para os dois lados: o servidor decide "hoje" no fuso de
  // Brasília e o CI roda em UTC, então ±1 dia poderia cair no mesmo dia.
  const futuro = daquiA(3);
  const pedido = { barbearia_id: barbeiroId, servico: "Corte + Barba", profissional: "Lucas Silva" };

  const dataRuim = await chamar("POST", "/publico/agendar", { ...pedido, data: "31/12/2026", hora: "14:00" });
  ok(dataRuim.status === 400, "agendar: data fora do formato ISO é 400, não 500", dataRuim.status);

  const horaRuim = await chamar("POST", "/publico/agendar", { ...pedido, data: futuro, hora: "03:17" });
  ok(horaRuim.status === 400, "agendar: hora fora da grade é recusada", horaRuim.status);

  const noPassado = await chamar("POST", "/publico/agendar", { ...pedido, data: daquiA(-3), hora: "14:00" });
  ok(noPassado.status === 400, "agendar: data passada é recusada", noPassado.status);

  const muitoLonge = await chamar("POST", "/publico/agendar", { ...pedido, data: daquiA(400), hora: "14:00" });
  ok(muitoLonge.status === 400, "agendar: data além do horizonte é recusada", muitoLonge.status);

  const svcFantasma = await chamar("POST", "/publico/agendar", { ...pedido, servico: "Servico Inexistente", data: futuro, hora: "14:00" });
  ok(svcFantasma.status === 400, "agendar: serviço inexistente é 400 (não cai no primeiro do catálogo)", svcFantasma);

  const profFantasma = await chamar("POST", "/publico/agendar", { ...pedido, profissional: "Ninguem Com Esse Nome", data: futuro, hora: "14:00" });
  ok(profFantasma.status === 400, "agendar: profissional inexistente é 400 (não cai no primeiro da equipe)", profFantasma);

  const valido = await chamar("POST", "/publico/agendar", { ...pedido, data: futuro, hora: "14:00" });
  ok(valido.status === 201 && valido.dados?.profissional === "Lucas Silva",
    "agendar: pedido válido continua passando, com o barbeiro pedido", valido);

  // Sem nome fixo na asserção: a seção de unidades acima já cadastrou outros
  // funcionários, e "o primeiro ativo" agora é o primeiro em ordem de NOME —
  // determinístico, ao contrário do `limit 1` sem `order by` que havia antes.
  // O que importa é que caiu em alguém de verdade, e não no literal "Qualquer"
  // que a versão anterior gravava na agenda quando não achava ninguém.
  const equipeAtiva = (await chamar("GET", "/publico/barbearias/" + barbeiroId)).dados?.barbeiros || [];
  const qualquer = await chamar("POST", "/publico/agendar", { ...pedido, profissional: "Qualquer", data: futuro, hora: "15:00" });
  ok(qualquer.status === 201 && equipeAtiva.some(b => b.nome === qualquer.dados?.profissional),
    "agendar: 'Qualquer' cai num barbeiro ativo de verdade", { veio: qualquer.dados?.profissional, ativos: equipeAtiva.map(b => b.nome) });

  // O token de cliente não pode virar sessão de dono.
  const tokenCliente = cookie.match(/cc_cliente=([^;]+)/)?.[1];
  cookie = `cc_sessao=${tokenCliente}`;
  const escalada = await chamar("GET", "/clientes");
  ok(escalada.status === 401, "token de cliente não vira sessão de dono", escalada.status);

  console.log("\n── Isolamento entre contas ──────────────────────────────");
  cookie = "";
  const semSessao = await chamar("GET", "/clientes");
  ok(semSessao.status === 401, "sem cookie, nada é lido", semSessao);

  console.log("\n── Senha: política e troca ──────────────────────────────");
  // Mesmo motivo da limpeza no início do arquivo: as seções acima já gastaram
  // boa parte do balde de /api/auth (20 por 15 min), e o que vem agora é
  // justamente mais /api/auth. Sem isto o bloco falharia por 429, sem nada
  // estar quebrado.
  await sql`delete from limites_uso where chave like 'ip:auth:%'`;

  cookie = "";
  const senhaCurta = await chamar("POST", "/auth/register", {
    nome: "Dono Fraco", barbearia: "Teste Senha Curta", whatsapp: "(11) 90000-1111",
    email: `curta-${Date.now()}@teste.local`, senha: "123456",
  });
  ok(senhaCurta.status === 400, "cadastro com senha de 6 caracteres é recusado (o mínimo subiu para 8)", senhaCurta);

  const soDigitos = await chamar("POST", "/auth/register", {
    nome: "Dono Numerico", barbearia: "Teste Numeros", whatsapp: "(11) 90000-2222",
    email: `num-${Date.now()}@teste.local`, senha: "12345678",
  });
  ok(soDigitos.status === 400, "cadastro com senha só de números é recusado", soDigitos);

  // ── Troca de senha ──────────────────────────────────────────────────────────
  //
  // O ponto que importa é o último: trocar a senha derruba as OUTRAS sessões.
  // Sem isso, trocar a senha porque alguém entrou na conta não adianta nada —
  // o JWT que essa pessoa levou vale 7 dias e `logout` só apaga o cookie de
  // quem pediu.
  cookie = cookieDono;
  const antesDaTroca = await chamar("GET", "/auth/me");
  ok(antesDaTroca.status === 200, "a sessão do dono vale antes da troca", antesDaTroca.status);

  const atualErrada = await chamar("POST", "/auth/senha", { atual: "nao-e-esta", nova: "trocada-com-folga-2026" });
  ok(atualErrada.status === 401, "trocar a senha sem acertar a atual é 401", atualErrada.status);

  const novaFraca = await chamar("POST", "/auth/senha", { atual: "segredo123", nova: "1234" });
  ok(novaFraca.status === 400, "a senha nova também passa pela política", novaFraca.status);

  const cookieAntigo = cookie;
  const trocou = await chamar("POST", "/auth/senha", { atual: "segredo123", nova: "trocada-com-folga-2026" });
  ok(trocou.status === 200, "trocar a senha com a atual correta funciona", trocou);
  ok(cookie !== cookieAntigo, "a troca emite um cookie novo para esta aba");

  const depoisDaTroca = await chamar("GET", "/auth/me");
  ok(depoisDaTroca.status === 200, "quem trocou a senha continua logado nesta aba", depoisDaTroca.status);

  cookie = cookieAntigo;
  const sessaoVelha = await chamar("GET", "/auth/me");
  ok(sessaoVelha.status === 401, "o token anterior à troca deixa de valer (as outras sessões caem)", sessaoVelha.status);

  cookie = "";
  const comSenhaVelha = await chamar("POST", "/auth/login", { email, senha: "segredo123" });
  ok(comSenhaVelha.status === 401, "a senha antiga não entra mais", comSenhaVelha.status);

  const comSenhaNova = await chamar("POST", "/auth/login", { email, senha: "trocada-com-folga-2026" });
  ok(comSenhaNova.status === 200, "a senha nova entra", comSenhaNova.status);
} catch (e) {
  console.error("\nErro inesperado:", e);
  falhas++;
} finally {
  if (barbeiroId) await sql`delete from barbeiros where id = ${barbeiroId}`;
  console.log(`\nConta de teste removida (cascade). ${falhas === 0 ? "TUDO PASSOU" : `${falhas} FALHA(S)`}\n`);
  process.exit(falhas === 0 ? 0 : 1);
}
