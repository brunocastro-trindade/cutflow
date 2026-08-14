// Cliente HTTP da API. O Vite faz proxy de /api para o servidor Node em dev, e
// em produção os dois são servidos pela mesma origem — por isso o cookie de
// sessão viaja sozinho, sem token no localStorage.
//
// TODAS as telas falam só com a API real. Não há modo demonstração, dados de
// exemplo nem atalho de acesso: entrar exige conta registrada e sessão assinada
// pelo servidor.


// Além da mensagem, o erro carrega os campos extras que o servidor mandou no
// corpo. É assim que sinalizadores como `precisaNome` (cliente sem cadastro,
// veja docs/API-CONTRATO.md §8) chegam até a tela em vez de virar só texto.
export class ErroApi extends Error {
  constructor(mensagem, status, corpo) {
    super(mensagem);
    this.name = "ErroApi";
    this.status = status;
    if (corpo && typeof corpo === "object") {
      for (const [chave, valor] of Object.entries(corpo)) {
        if (chave !== "erro" && !(chave in this)) this[chave] = valor;
      }
    }
  }
}

async function pedir(metodo, caminho, corpo) {
  let resposta;
  try {
    resposta = await fetch(`/api${caminho}`, {
      method: metodo,
      headers: corpo === undefined ? undefined : { "Content-Type": "application/json" },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      credentials: "same-origin",
    });
  } catch {
    throw new ErroApi("Não foi possível falar com o servidor. Ele está rodando?", 0);
  }

  const texto = await resposta.text();
  let dados = null;
  try {
    dados = texto ? JSON.parse(texto) : null;
  } catch {
    // Resposta não-JSON (página de erro, proxy fora do ar, etc.)
    if (!resposta.ok) throw new ErroApi(`Erro ${resposta.status} no servidor.`, resposta.status);
  }

  if (!resposta.ok) {
    throw new ErroApi(dados?.erro || `Erro ${resposta.status} no servidor.`, resposta.status, dados);
  }
  return dados;
}

const get = (c) => pedir("GET", c);
const post = (c, corpo) => pedir("POST", c, corpo ?? {});
const patch = (c, corpo) => pedir("PATCH", c, corpo);
const remove = (c) => pedir("DELETE", c);

// Os cadastros da barbearia (equipe, serviços, produtos, despesas, planos) têm
// todos o mesmo formato no servidor — ver server/crud.js. Um molde só aqui
// evita que cada tela invente um caminho diferente.
const cadastro = (caminho) => ({
  listar: () => get(caminho),
  criar: (dados) => post(caminho, dados),
  atualizar: (id, dados) => patch(`${caminho}/${id}`, dados),
  remover: (id) => remove(`${caminho}/${id}`),
});

// NÃO existe modo demonstração.
//
// Havia aqui um `comQuedaParaDemo` que, quando o servidor não respondia,
// silenciosamente trocava a API por dados fictícios guardados no navegador
// (src/lib/demo.js, removido). A área do cliente exibia barbearias, horários e
// avaliações inventados como se fossem reais — em produção, isso é enganar
// quem está tentando marcar um corte, e o dono nem ficava sabendo da queda.
//
// Agora API fora do ar é erro visível. Todo acesso exige registro e sessão
// assinada pelo servidor; nada neste arquivo tem caminho alternativo.

export const api = {
  auth: {
    eu: () => get("/auth/me"),
    entrar: (dados) => post("/auth/login", dados),
    cadastrar: (dados) => post("/auth/register", dados),
    sair: () => post("/auth/logout"),
    // Troca a senha do dono. Exige a senha atual e derruba as OUTRAS sessões
    // (ver server/routes/auth.js); esta aba recebe um cookie novo e continua.
    trocarSenha: (dados) => post("/auth/senha", dados),
  },
  clientes: {
    listar: () => get("/clientes"),
    criar: (dados) => post("/clientes", dados),
    atualizar: (id, dados) => patch(`/clientes/${id}`, dados),
    remover: (id) => remove(`/clientes/${id}`),
    // Troca o código de acesso do cliente à área pública. Serve para quando ele
    // perde o código ou quando alguém que não devia viu.
    novoCodigo: (id) => post(`/clientes/${id}/codigo`),
    visitas: (id) => get(`/clientes/${id}/visitas`),
    registrarVisita: (id, dados) => post(`/clientes/${id}/visitas`, dados),
    removerVisita: (id, visitaId) => remove(`/clientes/${id}/visitas/${visitaId}`),
  },
  agenda: {
    listar: (inicio, fim) => get(`/agendamentos?inicio=${inicio}&fim=${fim}`),
    criar: (dados) => post("/agendamentos", dados),
    cancelar: (id) => post(`/agendamentos/${id}/cancelar`),
    pagar: (id) => post(`/agendamentos/${id}/pagar`),
    remover: (id) => remove(`/agendamentos/${id}`),
  },
  fila: {
    listar: () => get("/fila"),
    entrar: (dados) => post("/fila", dados),
    atender: (id, dados) => post(`/fila/${id}/atender`, dados),
    remover: (id) => remove(`/fila/${id}`),
  },
  visitas: {
    listar: (limite = 20) => get(`/visitas?limite=${limite}`),
    resumo: () => get("/visitas/resumo"),
  },
  dashboard: {
    carregar: () => get("/dashboard"),
  },

  // ── Cadastros da barbearia ──────────────────────────────────────────────────
  // Estas rotas já existiam no servidor e ficaram sem uso enquanto as telas
  // guardavam o catálogo em memória.
  // `equipe` segue o mesmo formato dos cadastros, mas cada funcionário carrega
  // `unidade_id` — criar sem informar cai na unidade mais antiga da conta.
  // Estourar o teto da unidade responde 409 com a mensagem pronta.
  equipe: cadastro("/equipe"),

  // Devolve { limitePorUnidade, unidades: [{ ..., funcionarios, vagas }] }.
  // O limite vem do banco (cc_limite_equipe_por_unidade), não de um número
  // repetido no front — ver server/limites.js.
  unidades: {
    listar: () => get("/unidades"),
    criar: (dados) => post("/unidades", dados),
    atualizar: (id, dados) => patch(`/unidades/${id}`, dados),
    remover: (id) => remove(`/unidades/${id}`),
  },

  servicos: cadastro("/servicos"),
  produtos: cadastro("/produtos"),
  despesas: cadastro("/despesas"),
  planos: cadastro("/planos"),

  assinaturas: {
    listar: () => get("/assinaturas"),
    criar: (dados) => post("/assinaturas", dados),
    pagar: (id) => post(`/assinaturas/${id}/pagar`),
    cancelar: (id) => post(`/assinaturas/${id}/cancelar`),
  },
  // Área do cliente da barbearia.
  //
  // O cliente entra com telefone + código de acesso (que o barbeiro entrega no
  // balcão) e recebe um cookie de sessão assinado, igual ao do dono. Por isso
  // nenhum método aqui recebe `clienteId`: o servidor tira a identidade do
  // cookie. Enquanto o id andava na URL, quem tivesse um id lia o histórico e
  // cancelava agendamentos de qualquer pessoa.
  publico: {
    barbearias: ({ termo = "", modo = "nome" } = {}) =>
      get(`/publico/barbearias?termo=${encodeURIComponent(termo)}&modo=${modo}`),
    barbearia: (id, { registrarAcesso = false } = {}) =>
      get(`/publico/barbearias/${id}${registrarAcesso ? "?acesso=1" : ""}`),
    identificar: (dados) => post("/publico/identificar", dados),
    eu: () => get("/publico/eu"),
    sair: () => post("/publico/sair"),
    inicio: () => get("/publico/eu/inicio"),
    favoritar: (barbeariaId) => post(`/publico/eu/favoritos/${barbeariaId}`),
    horariosDoDia: (barbeariaId, data, profissional) =>
      get(`/publico/barbearias/${barbeariaId}/horarios?data=${data}&profissional=${encodeURIComponent(profissional || "")}`),
    agendar: (dados) => post("/publico/agendar", dados),
    meusHorarios: (filtro) =>
      get(`/publico/eu/horarios?barbearia=${filtro?.barbeariaId || ""}`),
    cancelar: (id) => post(`/publico/eu/horarios/${id}/cancelar`),
    fidelidade: (barbeariaId) => get(`/publico/eu/fidelidade/${barbeariaId}`),
    avaliar: (barbeariaId, dados) => post(`/publico/eu/avaliacoes/${barbeariaId}`, dados),
  },
};
