import jwt from "jsonwebtoken";
import { sql } from "./db.js";

const SECRET = process.env.JWT_SECRET;

if (!SECRET || SECRET.length < 32) {
  console.error(
    "\n[ControlCRM] JWT_SECRET ausente ou curta demais (mínimo 32 caracteres).\n" +
    "Gere uma com:  node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"\n" +
    "e coloque em .env.local.\n"
  );
  process.exit(1);
}

const COOKIE = "cc_sessao";
const COOKIE_CLIENTE = "cc_cliente";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

// Os dois tipos de sessão usam a mesma chave, então o token carrega `tipo` e
// cada middleware exige o seu. Sem isso, bastaria copiar o valor do cookie de
// cliente para o cookie de dono para virar dono da barbearia.
const TIPO_BARBEIRO = "barbeiro";
const TIPO_CLIENTE = "cliente";

const opcoesCookie = {
  httpOnly: true,                                  // fora do alcance de JS no browser
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",   // exige HTTPS em produção
  maxAge: MAX_AGE_MS,
  path: "/",
};

// `iat` (segundos epoch) só é passado pela troca de senha, e existe para tirar
// o relógio do Node da conta.
//
// A revogação abaixo compara o `iat` do token com `senha_alterada_em`, que é
// gravado pelo `now()` do POSTGRES. São dois relógios diferentes: se o do Node
// estiver alguns milissegundos atrás, o cookie emitido logo após a troca nasce
// "anterior" a ela e desloga justo quem acabou de trocar a senha. Assinando com
// o carimbo que o próprio banco devolveu, os dois lados passam a falar do mesmo
// instante e não sobra folga arbitrária para calibrar.
export function criarSessao(res, barbeiroId, { iat } = {}) {
  const conteudo = { sub: barbeiroId, tipo: TIPO_BARBEIRO };
  // jsonwebtoken respeita um `iat` já presente no payload e calcula o `exp` a
  // partir dele — os 7 dias continuam contando da emissão.
  if (iat) conteudo.iat = iat;
  const token = jwt.sign(conteudo, SECRET, { expiresIn: "7d" });
  res.cookie(COOKIE, token, opcoesCookie);
}

export function encerrarSessao(res) {
  res.clearCookie(COOKIE, { path: "/" });
}

export function criarSessaoCliente(res, clienteId) {
  const token = jwt.sign({ sub: clienteId, tipo: TIPO_CLIENTE }, SECRET, { expiresIn: "7d" });
  res.cookie(COOKIE_CLIENTE, token, opcoesCookie);
}

export function encerrarSessaoCliente(res) {
  res.clearCookie(COOKIE_CLIENTE, { path: "/" });
}

// Middleware: exige sessão válida e injeta req.barbeiroId.
// Todas as rotas de dados passam por aqui — o id do dono NUNCA vem do corpo da
// requisição, sempre do cookie assinado, para uma conta não ler dados de outra.
export async function exigirLogin(req, res, next) {
  const token = req.cookies?.[COOKIE];
  if (!token) return res.status(401).json({ erro: "Não autenticado" });

  let payload;
  try {
    payload = jwt.verify(token, SECRET);
  } catch {
    encerrarSessao(res);
    return res.status(401).json({ erro: "Sessão expirada" });
  }

  // Token de cliente não vira sessão de dono. Tokens antigos (anteriores ao
  // campo `tipo`) não têm a marca e seguem valendo como barbeiro.
  if (payload.tipo === TIPO_CLIENTE) {
    encerrarSessao(res);
    return res.status(401).json({ erro: "Não autenticado" });
  }

  const [barbeiro] = await sql`
    select id, nome, barbearia, email, whatsapp, senha_alterada_em
    from barbeiros
    where id = ${payload.sub}
  `;
  if (!barbeiro) {
    encerrarSessao(res);
    return res.status(401).json({ erro: "Conta não encontrada" });
  }

  // Revogação por troca de senha.
  //
  // O JWT é auto-contido: `encerrarSessao` só apaga o cookie do navegador que
  // pediu, e um token copiado antes disso seguiria valendo os 7 dias inteiros.
  // Enquanto não havia rota de trocar senha, isso era um limite aceito. Deixou
  // de ser no momento em que trocar a senha virou a reação a "alguém entrou na
  // minha conta": a troca precisa derrubar o token que essa pessoa levou.
  //
  // Um carimbo por conta resolve sem tabela de sessões: todo token assinado
  // antes da última troca morre. É por isso que a consulta acima já trazia a
  // linha do banco a cada requisição — o custo extra aqui é uma coluna.
  //
  // A comparação é em segundos inteiros dos dois lados: `iat` do JWT é epoch em
  // segundos, e a coluna é gravada com `date_trunc('second', now())`. Sem esse
  // truncamento, o carimbo teria microssegundos, o `iat` arredondado para baixo
  // ficaria sempre "antes" dele, e o cookie recém-emitido seria recusado na
  // requisição seguinte.
  //
  // Sobra uma janela de menos de um segundo: um token emitido no MESMO segundo
  // da troca sobrevive. Fechá-la exigiria carimbo com fração e um `iat` que o
  // JWT não sabe representar — e um segundo não é o que separa quem invadiu a
  // conta de quem a recuperou.
  const trocadaEm = barbeiro.senha_alterada_em
    ? new Date(barbeiro.senha_alterada_em).getTime()
    : 0;
  if (trocadaEm && (payload.iat ?? 0) * 1000 < trocadaEm) {
    encerrarSessao(res);
    return res.status(401).json({ erro: "Sessão encerrada porque a senha foi alterada." });
  }

  req.barbeiroId = barbeiro.id;
  req.barbeiro = barbeiro;
  next();
}

// Middleware da área do cliente: exige sessão de cliente e injeta req.clienteId.
//
// Existe pelo mesmo motivo do `exigirLogin`: antes, o id do cliente viajava na
// URL (`/publico/clientes/:clienteId/horarios`) e o servidor confiava nele. Quem
// tivesse um id lia o histórico, os valores gastos e cancelava agendamentos de
// outra pessoa. Agora o id só vem do cookie assinado, e a URL não tem como
// contradizê-lo.
export async function exigirCliente(req, res, next) {
  const token = req.cookies?.[COOKIE_CLIENTE];
  if (!token) return res.status(401).json({ erro: "Não autenticado" });

  let payload;
  try {
    payload = jwt.verify(token, SECRET);
  } catch {
    encerrarSessaoCliente(res);
    return res.status(401).json({ erro: "Sessão expirada" });
  }

  if (payload.tipo !== TIPO_CLIENTE) {
    encerrarSessaoCliente(res);
    return res.status(401).json({ erro: "Não autenticado" });
  }

  const [cliente] = await sql`
    select id, nome, telefone, tipo, barbeiro_id
    from clientes
    where id = ${payload.sub}
  `;
  if (!cliente) {
    encerrarSessaoCliente(res);
    return res.status(401).json({ erro: "Cadastro não encontrado" });
  }

  req.clienteId = cliente.id;
  req.cliente = cliente;
  next();
}
