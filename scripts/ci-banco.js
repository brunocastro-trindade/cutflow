// Cria e apaga a branch efêmera do Neon que o CI usa para rodar `smoke` e
// `isolamento`. Chamado só pelo .github/workflows/ci-banco.yml.
//
//   node scripts/ci-banco.js criar     → cria e escreve as saídas no GITHUB_OUTPUT
//   node scripts/ci-banco.js apagar    → apaga a branch de NEON_BRANCH_ID
//
// ── Por que uma branch efêmera, e não um Postgres do runner ──────────────────
//
// `server/db.js` usa `neon(url)`, o driver HTTP do Neon: ele fala com o endpoint
// da Neon, não com um Postgres qualquer. Um `services: postgres:16` do Actions
// não serve — o driver não sabe conversar com ele. Ou se sobe o proxy HTTP da
// Neon no runner (o que obrigaria a mexer em server/db.js), ou se usa uma branch
// de verdade. É a segunda, e ela é o item 4 do checklist em CONTEXT.md.
//
// ── Por que schema-only ──────────────────────────────────────────────────────
//
// `init_source: "schema-only"` copia a ESTRUTURA sem os dados. Duas razões:
//
// 1. `scripts/isolamento.js` se recusa a rodar se a API enxergar qualquer
//    barbearia que não seja do próprio teste — trava que nasceu do incidente de
//    12/08/2026. Uma branch com dados copiados faria o CI abortar sempre, e com
//    razão. Schema-only nasce vazia, então a trava passa limpa.
// 2. `isolamento` e `smoke` CRIAM E APAGAM contas. Rodar isso sobre uma cópia de
//    dado real é destrutivo por desenho — mesmo sendo cópia descartável, é uma
//    cópia a menos das barbearias circulando por aí.
//
// Isto é o oposto do `ensaiar-migracao`, que quer os dados de propósito: lá o
// objetivo é ver a migração sobreviver ao que já está gravado. São perguntas
// diferentes, e por isso dois scripts.
import crypto from "node:crypto";
import fs from "node:fs";

const API = "https://console.neon.tech/api/v2";

const CHAVE = process.env.NEON_API_KEY;
const PROJETO = process.env.NEON_PROJECT_ID;

// O banco de dev e o papel dono. Os mesmos nomes do .env.local.
const BANCO = process.env.NEON_DATABASE || "cutflow_dev";
const PAPEL_DONO = process.env.NEON_ROLE || "neondb_owner";

if (!CHAVE || !PROJETO) {
  console.error(
    "\nFaltam NEON_API_KEY e/ou NEON_PROJECT_ID.\n" +
    "No CI, são segredos do repositório (Settings → Secrets and variables → Actions).\n"
  );
  process.exit(1);
}

const api = async (metodo, caminho, corpo) => {
  const r = await fetch(API + caminho, {
    method: metodo,
    headers: { Authorization: `Bearer ${CHAVE}`, "Content-Type": "application/json" },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const t = await r.text();
  let d; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
  if (!r.ok) throw new Error(`${metodo} ${caminho} → ${r.status}: ${JSON.stringify(d).slice(0, 220)}`);
  return d;
};

/** Escreve em $GITHUB_OUTPUT. Sem o arquivo (rodando na mão), só informa. */
const saida = (chave, valor) => {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${chave}=${valor}\n`);
  } else {
    console.log(`  (saída ${chave} — sem GITHUB_OUTPUT, não gravada)`);
  }
};

/** Pede ao Actions para esconder o valor de todo log desta execução. */
const mascarar = (valor) => {
  if (valor) console.log(`::add-mask::${valor}`);
};

const comando = process.argv[2];

if (comando === "criar") {
  // A branch precisa de um pai. Sem NEON_PARENT_ID, usa a branch padrão do
  // projeto — que é onde vivem `neondb` e `cutflow_dev` (os dois bancos
  // compartilham o mesmo endpoint; ver a nota no CONTEXT.md).
  let pai = process.env.NEON_PARENT_ID;
  if (!pai) {
    const { branches } = await api("GET", `/projects/${PROJETO}/branches`);
    const padrao = branches.find((b) => b.default) || branches[0];
    if (!padrao) throw new Error("o projeto não tem nenhuma branch");
    pai = padrao.id;
    console.log(`Branch pai: ${padrao.name} (${pai}) — a padrão do projeto.`);
  }

  // O nome carrega o número do PR e o id da execução: duas execuções não
  // colidem, e uma branch esquecida é rastreável até o job que a criou.
  const sufixo = process.env.GITHUB_RUN_ID || crypto.randomBytes(4).toString("hex");
  const pr = process.env.PR_NUMERO ? `pr${process.env.PR_NUMERO}-` : "";
  const NOME = `ci-${pr}${sufixo}`;

  console.log(`Criando a branch efêmera "${NOME}" (schema-only, sem dados)...`);
  const criada = await api("POST", `/projects/${PROJETO}/branches`, {
    branch: { name: NOME, parent_id: pai, init_source: "schema-only" },
    endpoints: [{ type: "read_write" }],
  });
  const branchId = criada.branch.id;
  console.log(`  branch ${branchId} criada.`);

  // Pedir a connection_uri explicitamente é determinístico: a resposta do POST
  // só a traz quando o endpoint já terminou de provisionar.
  const uri =
    criada.connection_uris?.[0]?.connection_uri ||
    (await api("GET",
      `/projects/${PROJETO}/connection_uri` +
      `?branch_id=${branchId}&database_name=${BANCO}&role_name=${PAPEL_DONO}&pooled=true`
    )).uri;

  if (!uri) throw new Error("a API não devolveu connection_uri para a branch");

  mascarar(uri);
  saida("branch_id", branchId);
  saida("uri_dono", uri);
  console.log(`  connection_uri obtida para ${PAPEL_DONO}@${BANCO} (mascarada no log).`);

} else if (comando === "apagar") {
  const branchId = process.env.NEON_BRANCH_ID;
  if (!branchId) {
    console.log("Nada a apagar: NEON_BRANCH_ID vazio (a criação provavelmente falhou antes).");
    process.exit(0);
  }
  // Trava de segurança: só apaga o que tem cara de branch de CI. Um id colado
  // errado, ou a variável apontando para a branch padrão, não deve virar um
  // DELETE — este projeto já apontou para o banco errado uma vez.
  const { branches } = await api("GET", `/projects/${PROJETO}/branches`);
  const alvo = branches.find((b) => b.id === branchId);
  if (!alvo) {
    console.log(`Branch ${branchId} já não existe. Nada a fazer.`);
    process.exit(0);
  }
  if (alvo.default || !alvo.name.startsWith("ci-")) {
    console.error(
      `\nRECUSADO: ${alvo.name} (${branchId}) não é uma branch de CI` +
      `${alvo.default ? " — é a branch PADRÃO do projeto" : ""}.\n` +
      "Só apago branches criadas por este script, cujo nome começa com \"ci-\".\n"
    );
    process.exit(1);
  }
  await api("DELETE", `/projects/${PROJETO}/branches/${branchId}`);
  console.log(`Branch ${alvo.name} (${branchId}) apagada.`);

} else {
  console.error("\nUso: node scripts/ci-banco.js criar|apagar\n");
  process.exit(1);
}
