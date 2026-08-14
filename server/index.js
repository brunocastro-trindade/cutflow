import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { exigirLogin } from "./auth.js";
import { criarRateLimit } from "./rateLimit.js";
import authRoutes from "./routes/auth.js";
import publicoRoutes from "./routes/publico.js";
import clientesRoutes from "./routes/clientes.js";
import agendaRoutes from "./routes/agenda.js";
import filaRoutes from "./routes/fila.js";
import visitasRoutes from "./routes/visitas.js";
import assinaturasRoutes from "./routes/assinaturas.js";
import dashboardRoutes from "./routes/dashboard.js";
import equipeRoutes from "./routes/equipe.js";
import unidadesRoutes from "./routes/unidades.js";
import { servicos, produtos, despesas, planos } from "./routes/catalogo.js";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = express();

// Quantos proxies existem à frente da aplicação.
//
// Padrão 0 (desligado): `req.ip` vira o endereço real do socket, que o cliente
// não tem como falsificar. Ligar isto sem ter proxy de verdade na frente
// devolveria o controle do IP para quem manda o X-Forwarded-For — e o rate
// limit voltaria a ser contornável trocando o header a cada requisição.
// Em produção atrás de um proxy só (Nginx, Render, Fly), use TRUST_PROXY=1.
const proxies = Number(process.env.TRUST_PROXY) || 0;
if (proxies > 0) app.set("trust proxy", proxies);

const emProducao = process.env.NODE_ENV === "production";

// Configuração exigida em produção, conferida ANTES de aceitar a primeira
// requisição. Subir sem NODE_ENV=production deixa o cookie de sessão sem a
// marca `secure` (ver server/auth.js) e ele trafega em HTTP puro — o tipo de
// erro que ninguém percebe até alguém interceptar.
if (!emProducao) {
  console.warn(
    "\n[ControlCRM] ATENÇÃO: NODE_ENV não é 'production'.\n" +
    "  O cookie de sessão está SEM a marca `secure` e trafega em HTTP puro.\n" +
    "  Isso é esperado em desenvolvimento. Em produção, defina NODE_ENV=production.\n"
  );
} else if (proxies === 0) {
  console.warn(
    "\n[ControlCRM] ATENÇÃO: rodando em produção com TRUST_PROXY=0.\n" +
    "  Se houver um proxy reverso na frente, todos os visitantes chegam com o\n" +
    "  IP dele e dividem o mesmo limite de requisições. Use TRUST_PROXY=1.\n"
  );
}

// Cabeçalhos de segurança.
//
// A CSP é montada à mão porque a padrão do helmet quebraria a aplicação: o
// front usa estilos inline em quase todo componente (ver src/ui/base.jsx) e
// carrega fonte do Google. Liberar exatamente isso, e nada mais, vale mais do
// que desligar a CSP inteira.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // 'unsafe-inline' aqui é inevitável enquanto o estilo for inline no JSX.
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "https://images.unsplash.com"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],   // ninguém embute esta aplicação num iframe
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: emProducao ? [] : null,
    },
  },
  // O front carrega imagens do Unsplash; a política padrão (same-origin) as
  // bloquearia.
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  // HSTS só faz sentido sob HTTPS de verdade.
  hsts: emProducao ? { maxAge: 15552000, includeSubDomains: true } : false,
}));

app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

app.get("/api/health", (req, res) => res.json({ ok: true }));

// Limites de requisições por IP contra abusos e força bruta
// `escopo` separa os baldes: sem ele, as três rotas dividiriam a mesma chave no
// banco e o limite mais apertado derrubaria os outros dois.
const limitAuth = criarRateLimit({ escopo: "auth", janelaMs: 15 * 60 * 1000, max: 20, mensagem: "Muitas tentativas de login/cadastro. Aguarde 15 minutos." });
const limitPublico = criarRateLimit({ escopo: "publico", janelaMs: 15 * 60 * 1000, max: 120, mensagem: "Muitas requisições públicas. Aguarde 15 minutos." });

// Adivinhar o código de acesso é o único ataque restante contra a área do
// cliente, então esta rota tem limite próprio e bem mais apertado que o resto
// do /api/publico. São ~1 bilhão de códigos possíveis; a 10 tentativas por
// quarto de hora, tentar 0,001% do espaço já levaria séculos.
const limitIdentificar = criarRateLimit({ escopo: "identificar", janelaMs: 15 * 60 * 1000, max: 10, mensagem: "Muitas tentativas de acesso. Aguarde 15 minutos." });

// Login, cadastro e área do cliente são as rotas abertas (públicas).
app.use("/api/auth", limitAuth, authRoutes);
app.use("/api/publico/identificar", limitIdentificar);
app.use("/api/publico", limitPublico, publicoRoutes);

// Daqui para baixo tudo exige sessão, e cada consulta é filtrada pelo
// barbeiro_id que veio do cookie assinado.
app.use("/api/clientes", exigirLogin, clientesRoutes);
app.use("/api/agendamentos", exigirLogin, agendaRoutes);
app.use("/api/fila", exigirLogin, filaRoutes);
app.use("/api/visitas", exigirLogin, visitasRoutes);
app.use("/api/assinaturas", exigirLogin, assinaturasRoutes);
app.use("/api/dashboard", exigirLogin, dashboardRoutes);

// Cadastros da barbearia — todos com o mesmo formato de CRUD (ver server/crud.js).
app.use("/api/unidades", exigirLogin, unidadesRoutes);
app.use("/api/equipe", exigirLogin, equipeRoutes);
app.use("/api/servicos", exigirLogin, servicos);
app.use("/api/produtos", exigirLogin, produtos);
app.use("/api/despesas", exigirLogin, despesas);
app.use("/api/planos", exigirLogin, planos);

app.use("/api", (req, res) => res.status(404).json({ erro: "Rota não encontrada" }));

// Em produção o mesmo processo entrega o front já compilado (npm run build).
const dist = path.join(raiz, "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.use((req, res) => res.sendFile(path.join(dist, "index.html")));
}

// Erros não tratados viram 500 genérico: o detalhe fica no log do servidor, não
// na resposta, para não vazar estrutura do banco.
//
// O log sai em JSON de uma linha para ser pesquisável no agregador da
// plataforma. `console.error(err)` despejava a stack em várias linhas, que a
// maioria dos coletores quebra em eventos separados e ninguém consegue
// correlacionar depois.
app.use((err, req, res, next) => {
  console.error(JSON.stringify({
    nivel: "erro",
    metodo: req.method,
    caminho: req.originalUrl,
    msg: err?.message,
    stack: err?.stack?.split("\n").slice(0, 4).join(" | "),
  }));
  if (res.headersSent) return next(err);
  res.status(500).json({ erro: "Erro interno do servidor." });
});

// Qual banco este processo está usando — host, base e papel, nunca a senha.
//
// Sem isto, um servidor apontado para o banco errado é indistinguível de um
// certo: ele sobe, responde /api/health e só se denuncia quando alguém percebe
// dado estranho. Foi o que houve em 12/08/2026 — um processo esquecido de outra
// sessão, com credenciais de produção, atendia a porta 3001 e recebeu dados de
// teste que acabaram visíveis no site no ar.
const alvoDoBanco = () => {
  try {
    const u = new URL(process.env.DATABASE_URL);
    return { host: u.hostname, base: u.pathname.slice(1), papel: u.username };
  } catch {
    return { host: "?", base: "?", papel: "?" };
  }
};

const porta = Number(process.env.PORT) || 3001;
const servidor = app.listen(porta, () => {
  console.log(JSON.stringify({
    nivel: "info",
    msg: "API no ar",
    porta,
    ambiente: process.env.NODE_ENV || "development",
    trustProxy: proxies,
    banco: alvoDoBanco(),
  }));
});

// Encerramento gracioso.
//
// Aqui existiam um `process.stdin.resume()` e um `setInterval` vazio de uma
// hora, postos para o processo não morrer no terminal do Windows. O efeito
// colateral em produção era grave: o orquestrador manda SIGTERM ao trocar de
// versão, o processo NÃO saía por causa do timer, e levava SIGKILL alguns
// segundos depois — no meio das requisições em voo.
//
// Um servidor HTTP escutando já segura o event loop sozinho; a muleta era
// desnecessária. Agora o SIGTERM fecha a porta, espera o que está em voo
// terminar, e sai.
const encerrar = (sinal) => {
  console.log(JSON.stringify({ nivel: "info", msg: "encerrando", sinal }));
  servidor.close(() => {
    console.log(JSON.stringify({ nivel: "info", msg: "encerrado" }));
    process.exit(0);
  });
  // Rede de segurança: se alguma conexão não fechar, não ficamos pendurados
  // para sempre.
  setTimeout(() => {
    console.error(JSON.stringify({ nivel: "erro", msg: "encerramento forcado apos 10s" }));
    process.exit(1);
  }, 10_000).unref();
};

process.on("SIGTERM", () => encerrar("SIGTERM"));
process.on("SIGINT", () => encerrar("SIGINT"));
