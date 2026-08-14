import { Router } from "express";
import bcrypt from "bcryptjs";
import { sql } from "../db.js";
import { criarSessao, encerrarSessao, exigirLogin } from "../auth.js";
import { minutosDeBloqueio, registrarFalha, limparTentativas } from "../tentativas.js";

const router = Router();

const publico = (b) => ({
  id: b.id, nome: b.nome, barbearia: b.barbearia, email: b.email, whatsapp: b.whatsapp,
});

// ── Política de senha ────────────────────────────────────────────────────────
//
// O mínimo era 6. Quem entra aqui carrega a base de clientes, a agenda e o
// financeiro de um negócio inteiro, e 6 caracteres não sustentam isso: o que
// segura adivinhação hoje é o bloqueio de 3 erros por e-mail
// (server/tentativas.js), e ele é a ÚLTIMA linha, não a primeira.
//
// O bcrypt custo 12 protege do ataque offline; este mínimo protege do online e
// do reaproveitamento de senha óbvia. Não há exigência de símbolo ou maiúscula
// de propósito — regra de composição empurra o dono para "Senha@1" e para o
// papelzinho colado no monitor. Comprimento e uma lista curta do que já é
// público valem mais.
//
// A regra vale para cadastro novo e para troca. Login NÃO revalida: quem já
// tem conta com senha de 6 continua entrando, e só esbarra na regra no dia em
// que for trocar. Subir o mínimo não pode trancar do lado de fora quem já está
// dentro.
const SENHA_MINIMA = 8;

// Curta e honesta: as que aparecem primeiro em qualquer lista de senha vazada,
// mais as que este domínio convida (barbearia, o nome do produto).
const SENHAS_OBVIAS = new Set([
  "12345678", "123456789", "1234567890", "senha123", "password", "password1",
  "qwerty123", "abc12345", "barbearia", "cutflow123", "controlcrm",
]);

function validarSenha(senha) {
  const s = String(senha ?? "");
  if (s.length < SENHA_MINIMA) {
    return `A senha deve ter pelo menos ${SENHA_MINIMA} caracteres.`;
  }
  if (/^\d+$/.test(s)) {
    return "A senha não pode ser só números.";
  }
  if (SENHAS_OBVIAS.has(s.toLowerCase())) {
    return "Esta senha é fácil demais de adivinhar. Escolha outra.";
  }
  return null;
}

// Cadastro de barbeiros e salões (SaaS B2B): aberto para novos clientes do sistema.
router.post("/register", async (req, res) => {
  const nome = (req.body?.nome || "").trim();
  const barbearia = (req.body?.barbearia || "").trim();
  const whatsapp = (req.body?.whatsapp || "").trim();
  const email = (req.body?.email || "").trim().toLowerCase();
  const senha = req.body?.senha || "";

  if (!nome) return res.status(400).json({ erro: "Informe seu nome completo." });
  if (!barbearia) return res.status(400).json({ erro: "Informe o nome da barbearia." });
  if (!whatsapp) return res.status(400).json({ erro: "Informe seu WhatsApp." });
  if (!email.includes("@")) return res.status(400).json({ erro: "Informe um e-mail válido." });

  const senhaFraca = validarSenha(senha);
  if (senhaFraca) return res.status(400).json({ erro: senhaFraca });

  const [existente] = await sql`select id from barbeiros where lower(email) = ${email}`;
  if (existente) return res.status(409).json({ erro: "Este e-mail já está cadastrado. Faça login." });

  const senhaHash = await bcrypt.hash(senha, 12);
  const [barbeiro] = await sql`
    insert into barbeiros (nome, barbearia, email, whatsapp, senha_hash)
    values (${nome}, ${barbearia}, ${email}, ${whatsapp}, ${senhaHash})
    returning id, nome, barbearia, email, whatsapp
  `;

  // A conta nasce vazia de catálogo e de dados de exemplo — mas COM uma
  // unidade. Todo funcionário pertence a uma unidade, e o teto de equipe é por
  // unidade; sem esta linha o primeiro cadastro de funcionário não teria onde
  // cair, e a conta abriria num estado impossível de usar.
  await sql`insert into unidades (barbeiro_id, nome) values (${barbeiro.id}, 'Unidade principal')`;

  criarSessao(res, barbeiro.id);
  res.status(201).json(publico(barbeiro));
});

router.post("/login", async (req, res) => {
  const email = (req.body?.email || "").trim().toLowerCase();
  const senha = req.body?.senha || "";
  if (!email || !senha) return res.status(400).json({ erro: "Preencha e-mail e senha." });

  // Bloqueio antes de tocar no banco: nem consulta, nem compara hash. Além de
  // barrar a adivinhação, evita gastar bcrypt (que é caro de propósito) com
  // quem já estourou o limite.
  const minutos = await minutosDeBloqueio(email);
  if (minutos > 0) {
    return res.status(429).json({
      erro: `Muitas tentativas. Tente novamente em ${minutos} minuto${minutos > 1 ? "s" : ""}.`,
    });
  }

  const [barbeiro] = await sql`
    select id, nome, barbearia, email, whatsapp, senha_hash
    from barbeiros
    where lower(email) = ${email}
  `;

  // Mesma mensagem para e-mail inexistente e senha errada: não entrega para um
  // atacante quais e-mails estão cadastrados.
  const ok = barbeiro && (await bcrypt.compare(senha, barbeiro.senha_hash));
  if (!ok) {
    await registrarFalha(email);
    return res.status(401).json({ erro: "E-mail ou senha incorretos." });
  }

  // Entrou: a contagem zera, para um erro de digitação de ontem não somar com o
  // de hoje.
  await limparTentativas(email);
  criarSessao(res, barbeiro.id);
  res.json(publico(barbeiro));
});

router.post("/logout", (req, res) => {
  encerrarSessao(res);
  res.json({ ok: true });
});

router.get("/me", exigirLogin, (req, res) => {
  res.json(publico(req.barbeiro));
});

// POST /auth/senha — troca a própria senha.
//
// Não existia rota nenhuma para isso. Um dono que suspeitasse da própria senha
// não tinha o que fazer: nem trocar, nem recuperar. A saída era mexer no banco
// à mão, que é exatamente o tipo de operação que faz credencial de produção
// circular por conversa de WhatsApp.
//
// ── Três travas ─────────────────────────────────────────────────────────────
//
// 1. Exige a senha ATUAL. Só a sessão não basta: um notebook destravado ou um
//    cookie roubado não deve virar a troca da senha, que é o que fecharia a
//    conta para o dono legítimo.
//
// 2. Erro aqui conta no MESMO balde do login (server/tentativas.js). Sem isso,
//    esta rota viraria o caminho sem bloqueio para adivinhar a senha de uma
//    conta cuja sessão já se tem — e ela está sob o limite de 20 requisições
//    por 15 min do /api/auth, o que é frouxo demais sozinho.
//
// 3. Trocar a senha DERRUBA as outras sessões, via `senha_alterada_em`. É o
//    ponto do sistema em que a falta de revogação de JWT deixa de ser teórica:
//    trocar a senha porque alguém entrou na conta não serve de nada se o token
//    de 7 dias que essa pessoa levou continuar valendo. Ver server/auth.js.
//
// Não há recuperação por e-mail: o projeto não tem canal de envio. Quem perder
// a senha ainda depende do dono do sistema. Está registrado no CONTEXT.md.
router.post("/senha", exigirLogin, async (req, res) => {
  const atual = req.body?.atual || "";
  const nova = req.body?.nova || "";
  const email = req.barbeiro.email;

  const minutos = await minutosDeBloqueio(email);
  if (minutos > 0) {
    return res.status(429).json({
      erro: `Muitas tentativas. Tente novamente em ${minutos} minuto${minutos > 1 ? "s" : ""}.`,
    });
  }

  const fraca = validarSenha(nova);
  if (fraca) return res.status(400).json({ erro: fraca });

  const [barbeiro] = await sql`select senha_hash from barbeiros where id = ${req.barbeiroId}`;
  if (!barbeiro || !(await bcrypt.compare(atual, barbeiro.senha_hash))) {
    await registrarFalha(email);
    return res.status(401).json({ erro: "Senha atual incorreta." });
  }

  if (atual === nova) {
    return res.status(400).json({ erro: "A senha nova precisa ser diferente da atual." });
  }

  await limparTentativas(email);

  // `date_trunc('second')` e o `returning`: os dois existem para o cookie novo
  // nascer do MESMO relógio que gravou o carimbo. Ver server/auth.js.
  const [linha] = await sql`
    update barbeiros
       set senha_hash = ${await bcrypt.hash(nova, 12)},
           senha_alterada_em = date_trunc('second', now())
     where id = ${req.barbeiroId}
    returning extract(epoch from senha_alterada_em)::bigint as em
  `;

  // Cookie novo para esta aba: o antigo acabou de ser invalidado junto com os
  // outros. Sem isto, quem troca a senha é deslogado no próprio clique.
  criarSessao(res, req.barbeiroId, { iat: Number(linha.em) });
  res.json({ ok: true });
});

export default router;
