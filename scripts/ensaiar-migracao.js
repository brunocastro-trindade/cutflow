// Ensaia a migração contra uma CÓPIA dos dados de produção, e joga a cópia fora.
//
//   npm run ensaiar-migracao
//
// Rode isto antes de abrir o PR de `main` para `producao`.
//
// ── Por que existe ───────────────────────────────────────────────────────────
//
// O merge do PR nunca quebra por causa do banco: o que flui é código. O que
// quebra é o `npm run release`, que roda no build de produção e aplica o
// db/schema.sql sobre os DADOS REAIS.
//
// O schema tem operações que dependem do que já está gravado: backfill de
// código de acesso, dedupe antes do índice único de avaliações, `set not null`
// em equipe.unidade_id. Todas passam num banco de dev vazio e podem falhar em
// produção. Este projeto já bateu nisso três vezes — o índice único de
// avaliações precisou de um delete de dedupe porque linhas reais conflitavam.
//
// Uma branch do Neon nasce como cópia exata de produção, dados inclusive. Aqui
// a migração roda contra ela; se sobreviver, sobrevive em produção. No fim a
// branch é apagada, então nenhuma cópia dos dados das barbearias fica parada.
import { Client } from "@neondatabase/serverless";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://console.neon.tech/api/v2";

const CHAVE = process.env.NEON_API_KEY;
const PROJETO = process.env.NEON_PROJECT_ID;

// O ensaio precisa do papel DONO: o schema.sql faz DDL, que o papel restrito da
// aplicação não consegue rodar de propósito.
const BANCO = process.env.NEON_DATABASE || "neondb";
const PAPEL_DONO = process.env.NEON_ROLE || "neondb_owner";

if (!CHAVE || !PROJETO) {
  console.error(
    "\nFaltam variáveis no .env.local:\n" +
    "  NEON_API_KEY     chave da API (console.neon.tech → Account settings → API keys)\n" +
    "  NEON_PROJECT_ID  id do projeto de PRODUÇÃO\n"
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

// O nome carrega o horário para duas execuções não colidirem, e para uma branch
// esquecida ser reconhecível no console.
const carimbo = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const NOME = `ensaio-${carimbo}`;
let branchId = null;

try {
  console.log(`\nCriando a branch de ensaio "${NOME}" a partir de produção...`);
  const criada = await api("POST", `/projects/${PROJETO}/branches`, {
    branch: { name: NOME },
    endpoints: [{ type: "read_write" }],
  });
  branchId = criada.branch.id;
  console.log(`  branch ${branchId} criada (cópia dos dados de produção).`);

  // A resposta do POST às vezes traz `connection_uris`, às vezes não — depende
  // de a Neon já ter terminado de provisionar o endpoint. Pedir explicitamente
  // é determinístico, e é o que a documentação recomenda.
  const uri =
    criada.connection_uris?.[0]?.connection_uri ||
    (await api("GET",
      `/projects/${PROJETO}/connection_uri` +
      `?branch_id=${branchId}&database_name=${BANCO}&role_name=${PAPEL_DONO}&pooled=true`
    )).uri;

  if (!uri) throw new Error("a API não devolveu connection_uri para a branch");

  // O que veio junto — serve para confirmar que a cópia tem dado de verdade.
  const c = new Client(uri);
  await c.connect();
  const antes = {};
  for (const t of ["barbeiros", "equipe", "clientes", "agendamentos", "visitas"]) {
    antes[t] = (await c.query(`select count(*)::int as n from ${t}`)).rows[0].n;
  }
  console.log("  dados copiados:", Object.entries(antes).map(([k, v]) => `${k}=${v}`).join(" "));

  console.log("\nAplicando db/schema.sql sobre esses dados...");
  await c.query(fs.readFileSync(path.join(raiz, "db", "schema.sql"), "utf8"));
  console.log("  MIGRAÇÃO SOBREVIVEU AOS DADOS REAIS.");

  // Depois da migração os números não podem ter encolhido: um dedupe mal escrito
  // apaga linha de barbearia real, e é melhor descobrir aqui.
  console.log("\nConferindo que nada sumiu:");
  let perdeu = false;
  for (const [t, n] of Object.entries(antes)) {
    const d = (await c.query(`select count(*)::int as n from ${t}`)).rows[0].n;
    if (d < n) perdeu = true;
    console.log(`  ${d < n ? "PERDEU" : "ok    "} ${t.padEnd(14)} antes=${n} depois=${d}`);
  }
  await c.end();

  if (perdeu) {
    console.log("\nA migração APAGOU linhas. Não promova — revise o db/schema.sql.\n");
    process.exitCode = 1;
  } else {
    console.log("\nPode promover: `main` → `producao`.\n");
  }
} catch (e) {
  console.error("\nO ENSAIO FALHOU:", e.message);
  console.error("Isto teria quebrado o build de produção. Corrija antes de promover.\n");
  process.exitCode = 1;
} finally {
  if (branchId) {
    try {
      await api("DELETE", `/projects/${PROJETO}/branches/${branchId}`);
      console.log(`Branch de ensaio ${branchId} apagada (nenhuma cópia dos dados ficou parada).`);
    } catch (e) {
      console.error(`ATENÇÃO: não consegui apagar a branch ${branchId} — apague no console. (${e.message.slice(0, 80)})`);
    }
  }
}
