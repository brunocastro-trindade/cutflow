import { useState } from "react";
import { B } from "../ui/tokens.js";
import { Btn, Card, Col, Field, PH, Row } from "../ui/base.jsx";
import { api } from "../lib/api.js";

// ── Trocar a senha ────────────────────────────────────────────────────────────
//
// Até aqui a tela só informava que a senha era guardada como hash. Não havia
// como trocá-la: um dono que suspeitasse da própria senha dependia de alguém
// mexer no banco à mão.
//
// A senha atual é pedida de propósito — sessão aberta não basta, senão um
// notebook destravado vira a troca da senha e a conta fecha para o dono. E a
// troca derruba as OUTRAS sessões (server/routes/auth.js), que é o que torna
// isto uma reação útil a "alguém entrou na minha conta".
const TrocarSenha = () => {
  const [atual, setAtual] = useState("");
  const [nova, setNova] = useState("");
  const [repetida, setRepetida] = useState("");
  const [estado, setEstado] = useState({ erro: "", ok: false, enviando: false });

  const limpar = () => { setAtual(""); setNova(""); setRepetida(""); };

  const enviar = async () => {
    // A conferência das duas iguais é só daqui: o servidor não tem como saber
    // que a pessoa errou a digitação, e mandar a repetição para ele seria mais
    // um lugar por onde a senha passa sem precisar.
    if (nova !== repetida) {
      return setEstado({ erro: "A nova senha e a repetição não são iguais.", ok: false, enviando: false });
    }
    setEstado({ erro: "", ok: false, enviando: true });
    try {
      await api.auth.trocarSenha({ atual, nova });
      limpar();
      setEstado({ erro: "", ok: true, enviando: false });
    } catch (e) {
      setEstado({ erro: e.message, ok: false, enviando: false });
    }
  };

  const podeEnviar = atual && nova && repetida && !estado.enviando;

  return (
    <Card title="Trocar a senha" style={{ flex: 1 }}>
      <Col gap={12}>
        <Field
          label="Senha atual" type="password" placeholder="A senha que você usa hoje"
          value={atual} onChange={setAtual}
        />
        <Field
          label="Nova senha" type="password" placeholder="Pelo menos 8 caracteres"
          value={nova} onChange={setNova}
        />
        <Field
          label="Repita a nova senha" type="password" placeholder="A mesma de novo"
          value={repetida} onChange={setRepetida}
        />

        {estado.erro && (
          <div style={{ fontSize: 11, color: B.red, lineHeight: 1.5 }}>{estado.erro}</div>
        )}
        {estado.ok && (
          <div style={{ fontSize: 11, color: B.teal, lineHeight: 1.5 }}>
            Senha trocada. As sessões abertas em outros aparelhos foram encerradas.
          </div>
        )}

        <Row>
          <Btn onClick={podeEnviar ? enviar : undefined} disabled={!podeEnviar}>
            {estado.enviando ? "Trocando..." : "Trocar senha"}
          </Btn>
        </Row>

        <div style={{ fontSize: 10, color: B.dim, lineHeight: 1.6 }}>
          Trocar a senha desconecta esta conta em todos os outros aparelhos. Não
          existe recuperação por e-mail: guarde a senha nova em lugar seguro.
        </div>
      </Col>
    </Card>
  );
};

// ── Taxas & Configurações ─────────────────────────────────────────────────────
export const Taxas = ({ user }) => (
  <Col gap={14}>
    <PH title="Taxas & Configurações" sub="Dados da conta, taxas de pagamento e módulos" />
    <Row gap={10} style={{ alignItems: "flex-start" }}>
      <Card title="Dados da conta" style={{ flex: 1 }}>
        {[["Responsável", user.nome], ["Barbearia", user.barbearia], ["E-mail", user.email], ["WhatsApp", user.whatsapp]].map(([k, v]) => (
          <Row key={k} style={{ justifyContent: "space-between", borderBottom: `0.5px solid ${B.border}`, padding: "9px 0" }}>
            <span style={{ fontSize: 12, color: B.muted, whiteSpace: "nowrap" }}>{k}</span>
            <span style={{ fontSize: 12, color: B.text, fontWeight: 500, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis" }} title={v}>{v}</span>
          </Row>
        ))}
        <div style={{ fontSize: 10, color: B.dim, marginTop: 12, lineHeight: 1.6 }}>
          Estes dados estão salvos no banco, na tabela <strong>barbeiros</strong>. A senha é guardada apenas como hash bcrypt.
        </div>
      </Card>
      <TrocarSenha />
      <Card title="Módulos ativos" style={{ flex: 1 }}>
        <Col gap={14}>
          {[
            { l: "Fila de espera", on: true },
            { l: "Assinaturas mensais", on: true },
            { l: "Notificações WhatsApp", on: false },
            { l: "Notificações por e-mail", on: false },
          ].map((m, i) => (
            <Row key={i} style={{ justifyContent: "space-between" }}>
              <span style={{ fontSize: 12, color: B.text }}>{m.l}</span>
              <Field type={m.on ? "toggle" : "toggle-off"} placeholder="" />
            </Row>
          ))}
        </Col>
      </Card>
    </Row>
    <Row gap={10} style={{ alignItems: "flex-start" }}>
      <Card title="Taxas de maquininha" style={{ flex: 1 }}>
        {[["Débito", "1,5%"], ["Crédito à vista", "2,5%"], ["Crédito 2×", "3,2%"], ["Crédito 3× a 6×", "4,0%"], ["PIX", "0,99%"]].map((t, i) => (
          <Row key={i} style={{ justifyContent: "space-between", borderBottom: `0.5px solid ${B.border}`, padding: "9px 0" }}>
            <span style={{ fontSize: 12, color: B.text }}>{t[0]}</span>
            <div style={{ height: 30, width: 80, background: B.bg2, border: `0.5px solid ${B.border2}`, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: B.text }}>{t[1]}</div>
          </Row>
        ))}
      </Card>
    </Row>
  </Col>
);


export default Taxas;
