// Guardas de invariante: transforma em teste o que hoje é regra escrita em
// CONTEXT.md e conferida à mão numa auditoria.
//
//   npm run guardas          (depois de `npm run build`, para o item 3 valer)
//
// Por que isto existe, e por que cada guarda em particular:
//
// A auditoria de 07/08/2026 mediu quatro invariantes e os deu por bons. O
// problema de invariante conferido à mão é que ele só é verdade no dia da
// medição — nada impede o commit seguinte de desfazê-lo, e o próximo a
// perceber é a auditoria seguinte, meses depois. Cada item abaixo já foi
// violado neste projeto, ou passou perto disso.
//
// Este script NÃO substitui o `smoke` nem o `isolamento`: aqueles provam
// comportamento contra a API no ar, e precisam de banco. Estes quatro são
// verificáveis lendo arquivo, então rodam em qualquer lugar, sem credencial.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let falhas = 0;
const ok = (cond, texto, detalhe) => {
  console.log(`${cond ? "  ok  " : " FALHA"} ${texto}`);
  if (!cond) {
    falhas++;
    if (detalhe) console.log(String(detalhe).split("\n").map((l) => `        ${l}`).join("\n"));
  }
};

/** Lê todos os arquivos de uma pasta, recursivamente. */
function arquivos(dir, filtro = () => true) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath ?? e.path, e.name))
    .filter(filtro);
}

/** Procura um padrão em vários arquivos e devolve "caminho:linha  trecho". */
function procurar(lista, padrao) {
  const achados = [];
  for (const arq of lista) {
    const linhas = fs.readFileSync(arq, "utf8").split("\n");
    linhas.forEach((linha, i) => {
      if (padrao.test(linha)) {
        achados.push(`${path.relative(raiz, arq)}:${i + 1}  ${linha.trim().slice(0, 100)}`);
      }
      padrao.lastIndex = 0;
    });
  }
  return achados;
}

const fonte = arquivos(path.join(raiz, "src"), (f) => /\.(jsx?|css)$/.test(f));

console.log("\n── Guardas de invariante ──────────────────────────────────");

// ── 1. O front não lê variável de ambiente ───────────────────────────────────
//
// Qualquer variável com prefixo `VITE_` entra no bundle e vira pública. Hoje o
// front não lê ambiente nenhum: só fala com `/api`. Essa é a razão de o bundle
// não conter connection string.
//
// A armadilha já esteve armada: o projeto Neon antigo deixou uma
// `VITE_NEON_AUTH_URL` no `.env.local`, e bastaria alguém escrever
// `import.meta.env.VITE_NEON_AUTH_URL` para ela passar a ser servida ao
// navegador. A variável foi removida em 12/08/2026; esta guarda impede que a
// porta reabra por outro caminho.
{
  const achados = procurar(fonte, /import\.meta\.env|VITE_/);
  ok(achados.length === 0, "src/ não lê variável de ambiente (import.meta.env / VITE_)", achados.join("\n"));
}

// ── 2. Nenhuma credencial literal no front ───────────────────────────────────
//
// Este é o guarda do botão "Acessar Painel Demo", removido em 07/08/2026. Ele
// chamava `api.auth.entrar` e `api.auth.cadastrar` — as funções legítimas — com
// `demo@barbearia.com` / `demo123` fixos no código. As credenciais ficavam
// legíveis em texto claro no bundle enviado ao navegador, e apagar a conta no
// banco não resolvia: o próximo clique a recriava.
//
// A auditoria não pegou isso porque procurou pelo NOME do mecanismo de demo.
// Aqui a busca é pela forma: um literal de senha não-vazio. Campo de formulário
// (`senha: ""`) não casa, de propósito — é o estado inicial legítimo.
{
  const achados = procurar(fonte, /(senha|password|senha_hash|creds)\s*:\s*["'][^"']+["']/i);
  ok(achados.length === 0, "src/ não tem credencial escrita no código", achados.join("\n"));
}

// ── 3. O bundle não carrega segredo ──────────────────────────────────────────
//
// O item 1 do checklist de blindagem, medido em 11/08/2026: zero ocorrências de
// `postgresql://`, `neon.tech`, `DATABASE_URL` e `JWT_SECRET` no bundle de
// produção. É a diferença entre o front falar com `/api` e o front falar com o
// banco.
//
// Só roda se `dist/` existir. Em CI o build vem antes; na máquina de quem
// desenvolve, rode `npm run build` primeiro ou este item fica pulado.
{
  const dist = path.join(raiz, "dist");
  if (!fs.existsSync(dist)) {
    console.log("  --   bundle sem segredo — PULADO (dist/ não existe; rode `npm run build`)");
  } else {
    const alvos = arquivos(dist, (f) => /\.(js|css|html|map)$/.test(f));
    const achados = procurar(alvos, /postgresql:\/\/|neon\.tech|DATABASE_URL|JWT_SECRET/);
    ok(achados.length === 0, `bundle (${alvos.length} arquivos) não contém segredo`, achados.join("\n"));
  }
}

// ── 4. A faixa do Node continua com teto ─────────────────────────────────────
//
// Com `>=22.0.0` sem teto, a Render escolheu Node 26.7.0 — enquanto o projeto é
// desenvolvido e testado no 24. O build passou, e rodar em produção uma versão
// nunca exercitada aqui é risco à toa.
//
// O teto foi fechado em 11/08/2026 (`>=22 <25`). Esta guarda existe porque a
// regressão é de uma linha e não quebra nada visível — some no dia em que
// alguém "limpar" o package.json.
{
  const pkg = JSON.parse(fs.readFileSync(path.join(raiz, "package.json"), "utf8"));
  const faixa = pkg.engines?.node ?? "";
  ok(/<\s*\d+/.test(faixa), `engines.node ("${faixa}") tem limite superior`, "Sem teto, a plataforma escolhe uma versão que nunca foi testada aqui.");
}

// ── 5. Nenhum segredo real em arquivo VERSIONADO ─────────────────────────────
//
// As guardas 1–3 olham o que vai para o navegador. Esta olha o que vai para o
// repositório, que é um caminho diferente e já foi percorrido duas vezes em
// 13/08/2026: o endpoint real do Neon foi escrito num documento versionado, e
// uma API key de produção quase foi colada no `.env.example` — que, ao
// contrário do `.env.local`, É versionado e é exatamente onde ninguém procura
// um segredo, porque o nome promete que é só exemplo.
//
// Varre apenas o que o git rastreia: o `.env.local` e os `.<papel>.local` estão
// ignorados e devem mesmo conter segredo.
//
// Os placeholders do `.env.example` não casam de propósito — `ep-xxxx-pooler`
// não tem a forma de um endpoint real, e `:senha@` está na lista de senhas
// obviamente falsas.
{
  const { execFileSync } = await import("node:child_process");
  let rastreados = [];
  try {
    rastreados = execFileSync("git", ["ls-files"], { cwd: raiz, encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((f) => path.join(raiz, f))
      .filter((f) => fs.existsSync(f) && fs.statSync(f).size < 2_000_000)
      // Binário não tem segredo em texto, e package-lock é enorme e ruidoso.
      .filter((f) => !/\.(png|jpg|jpeg|gif|ico|webp|woff2?|pdf)$/i.test(f))
      .filter((f) => path.basename(f) !== "package-lock.json");
  } catch {
    console.log("  --   segredo em arquivo versionado — PULADO (git indisponível)");
  }

  if (rastreados.length) {
    const padroes = [
      // Chave de API da Neon.
      /napi_[a-z0-9]{20,}/i,
      // Endpoint real do Neon: ep-<palavra>-<palavra>-<id>. O `ep-xxxx-pooler`
      // do .env.example tem uma seção a menos e não casa.
      /ep-[a-z]+-[a-z]+-[a-z0-9]{6,}/i,
      // Connection string com senha que não é placeholder óbvio.
      /postgresql:\/\/[^:\s/]+:(?!senha|password|usuario|\*{3}|<|\$)[^@\s]{8,}@/i,
    ];
    const achados = padroes.flatMap((p) => procurar(rastreados, p));
    ok(
      achados.length === 0,
      `nenhum segredo real em arquivo versionado (${rastreados.length} arquivos)`,
      achados.join("\n")
    );
  }
}

console.log(
  falhas === 0
    ? "\nTodas as guardas passaram.\n"
    : `\n${falhas} guarda(s) falharam. Cada uma corresponde a um invariante registrado em CONTEXT.md.\n`
);
process.exit(falhas === 0 ? 0 : 1);
