// Cria (ou atualiza) o papel de MENOR PRIVILÉGIO que a aplicação usa em runtime.
//
//   DATABASE_URL=<string do papel DONO> npm run db:papel-app
//
// Por que existe: hoje a aplicação conecta como o dono do banco, que pode criar
// bancos, criar papéis e ignorar RLS. Vazando essa string, perde-se o projeto
// inteiro — não só os dados. Este papel só faz o que as rotas precisam:
// ler e escrever nas tabelas. Não cria, não apaga, não altera estrutura.
//
// A MIGRAÇÃO CONTINUA COM O DONO. `db/schema.sql` tem 46 instruções de DDL
// (create table, alter, create trigger); o papel restrito não consegue rodá-las,
// de propósito. Por isso a fase de release usa uma variável separada — ver
// render.yaml.
//
// A senha nova é gravada em `.<papel>.local` (ignorado pelo git) em vez de
// impressa na tela: segredo em terminal vira histórico de shell.
import { Client } from "@neondatabase/serverless";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Papel no Postgres é do CLUSTER, não do banco. Rodar este script apontando
// para o banco de dev com o papel de produção trocaria a senha que o site em
// produção usa — e derrubaria o site. Por isso cada ambiente tem o seu:
//
//   npm run db:papel-app                       -> cutflow_app      (produção)
//   PAPEL=cutflow_dev_app npm run db:papel-app -> cutflow_dev_app  (dev)
//
// Credencial separada também vale por si: a de dev vazar não abre produção.
const PAPEL = process.env.PAPEL || "cutflow_app";

if (!/^[a-z][a-z0-9_]{2,40}$/.test(PAPEL)) {
  console.error(`
Nome de papel inválido: ${PAPEL}. Use letras minúsculas, números e _.
`);
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("\nDATABASE_URL não definida. Ela precisa ser a string do papel DONO.\n");
  process.exit(1);
}

// Alfabeto sem aspas nem barra: a senha entra em connection string e em SQL.
const ALFA = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789-_";
const senha = Array.from(crypto.randomBytes(40)).map((b) => ALFA[b % ALFA.length]).join("");

const c = new Client(process.env.DATABASE_URL);

try {
  await c.connect();
  const [{ current_user: dono, current_database: banco }] =
    (await c.query("select current_user, current_database()")).rows;
  console.log(`\nConectado como ${dono} em ${banco}.`);

  const existe = (await c.query("select 1 from pg_roles where rolname = $1", [PAPEL])).rows.length > 0;
  // `format(%L)` escapa a senha como literal — nunca concatene senha em SQL.
  await c.query(
    existe
      ? `do $$ begin execute format('alter role ${PAPEL} login password %L', $tok$${senha}$tok$); end $$;`
      : `do $$ begin execute format('create role ${PAPEL} login password %L', $tok$${senha}$tok$); end $$;`
  );
  console.log(`  papel ${PAPEL} ${existe ? "atualizado" : "criado"}.`);

  // ── Só o necessário ────────────────────────────────────────────────────────
  // Sem CREATE no schema: o papel não cria nem apaga tabela.
  await c.query(`grant connect on database "${banco}" to ${PAPEL}`);
  await c.query(`grant usage on schema public to ${PAPEL}`);
  await c.query(`grant select, insert, update, delete on all tables in schema public to ${PAPEL}`);
  await c.query(`grant usage, select on all sequences in schema public to ${PAPEL}`);

  // EXECUTE é obrigatório: server/limites.js chama cc_limite_equipe_por_unidade(),
  // e a trigger do teto de equipe também — e ela roda com o privilégio de quem
  // invoca, ou seja, deste papel.
  await c.query(`grant execute on all functions in schema public to ${PAPEL}`);

  // Tabela criada por uma migração FUTURA nasceria sem grant, e a aplicação
  // quebraria no primeiro acesso. Isto resolve de antemão.
  await c.query(`alter default privileges for role ${dono} in schema public grant select, insert, update, delete on tables to ${PAPEL}`);
  await c.query(`alter default privileges for role ${dono} in schema public grant usage, select on sequences to ${PAPEL}`);
  await c.query(`alter default privileges for role ${dono} in schema public grant execute on functions to ${PAPEL}`);
  console.log("  privilégios concedidos (leitura/escrita, sem DDL).");

  // ── Confere o que o papel virou ────────────────────────────────────────────
  const [p] = (await c.query(
    "select rolcreatedb, rolcreaterole, rolbypassrls, rolsuper from pg_roles where rolname = $1", [PAPEL])).rows;
  console.log("\nPrivilégios do papel:");
  console.log(`  createdb=${p.rolcreatedb}  createrole=${p.rolcreaterole}  bypassrls=${p.rolbypassrls}  superuser=${p.rolsuper}`);
  const [s] = (await c.query(
    "select has_schema_privilege($1,'public','CREATE') as cria_no_schema", [PAPEL])).rows;
  console.log(`  CREATE no schema public: ${s.cria_no_schema}`);
  if (p.rolcreatedb || p.rolcreaterole || p.rolbypassrls || p.rolsuper || s.cria_no_schema) {
    throw new Error("o papel ficou com privilégio demais — revise antes de usar");
  }

  // ── Grava a connection string, sem imprimir ────────────────────────────────
  const u = new URL(process.env.DATABASE_URL);
  u.username = PAPEL;
  u.password = senha;
  const arquivo = path.join(raiz, `.${PAPEL}.local`);
  fs.writeFileSync(arquivo,
    "# Connection string do papel de menor privilégio da aplicação.\n" +
    "# Use esta na variável DATABASE_URL da Render (runtime).\n" +
    "# A string do DONO fica só na variável da fase de release.\n" +
    "# Este arquivo está no .gitignore. Apague depois de copiar.\n\n" +
    u.toString() + "\n", { mode: 0o600 });

  console.log(`\nConnection string gravada em .${PAPEL}.local (não foi impressa aqui).`);
  console.log("Copie de lá para a Render e apague o arquivo.\n");
} catch (e) {
  console.error("\nFalhou:", e.message, "\n");
  process.exitCode = 1;
} finally {
  await c.end().catch(() => {});
}
