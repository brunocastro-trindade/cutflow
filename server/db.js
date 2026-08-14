import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;

if (!url) {
  console.error(
    "\n[ControlCRM] DATABASE_URL não definida.\n" +
    "Crie um arquivo .env.local na raiz do projeto com a connection string do Neon.\n" +
    "Use o .env.example como modelo.\n"
  );
  process.exit(1);
}

// Tagged template do Neon: tudo que é interpolado vira parâmetro da query
// (sql`... ${valor}` → $1), então não há como montar SQL por concatenação.
export const sql = neon(url);

// linha de teste do perimetro — este arquivo esta FORA do territorio
