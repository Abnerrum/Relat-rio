// =====================================================================
//  Samsung Service — API Backend (Node.js + Express + MySQL)
//  Execute: npm install  →  node server.js
// =====================================================================

const express  = require('express');
const mysql    = require('mysql2/promise');
const cors     = require('cors');
const cron     = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ── CONFIGURAÇÃO DO BANCO ─────────────────────────────────────────────
// ⚠️  Altere as credenciais abaixo para as do seu MySQL Workbench
const DB_CONFIG = {
  host:     'localhost',
  port:     3306,
  user:     'root',            // seu usuário MySQL
  password: 'Abn@rum12', // sua senha MySQL
  database: 'samsung_financeiro',
  waitForConnections: true,
  connectionLimit:    10,
  timezone: '-03:00'           // horário de Brasília
};

let pool;

async function conectar() {
  pool = mysql.createPool(DB_CONFIG);
  const conn = await pool.getConnection();
  console.log('✅ Conectado ao MySQL com sucesso!');
  conn.release();
}

// ── HELPER: MÊS REFERÊNCIA ───────────────────────────────────────────
function mesAtual() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function mesAnterior() {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ── HELPER: é estorno? ────────────────────────────────────────────────
function isEstorno(tipo) {
  if (!tipo) return false;
  const t = String(tipo).toLowerCase();
  return t.includes('estorno') || t.includes('cancel');
}

// ── HELPER: converte valor BR ("1.234,56") → Number ──────────────────
function parseBRValue(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim()
    .replace(/\./g, '')   // remove separador de milhar
    .replace(',', '.');   // vírgula decimal → ponto
  return parseFloat(s) || 0;
}

// ── HELPER: parseia data BR "dd/mm/yyyy HH:MM:SS" ────────────────────
function parseBRDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const [,d,mo,y,h='0',mi='0',sec='0'] = m;
    return new Date(+y, +mo-1, +d, +h, +mi, +sec);
  }
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? null : dt;
}

// =====================================================================
//  ROTAS
// =====================================================================

// ── GET /api/status ──────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  try {
    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM registros');
    const [[{ meses }]] = await pool.query('SELECT COUNT(DISTINCT mes_ref) AS meses FROM registros');
    res.json({ ok: true, total_registros: total, total_meses: meses, servidor: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ── GET /api/registros ───────────────────────────────────────────────
//    ?mes=YYYY-MM   → filtra pelo mês
//    ?data_ini=YYYY-MM-DD&data_fim=YYYY-MM-DD → filtra por período
app.get('/api/registros', async (req, res) => {
  try {
    let sql    = 'SELECT * FROM registros WHERE 1=1';
    const vals = [];

    if (req.query.mes) {
      sql += ' AND mes_ref = ?';
      vals.push(req.query.mes);
    }
    if (req.query.data_ini) {
      sql += ' AND data_os >= ?';
      vals.push(req.query.data_ini + ' 00:00:00');
    }
    if (req.query.data_fim) {
      sql += ' AND data_os <= ?';
      vals.push(req.query.data_fim + ' 23:59:59');
    }

    sql += ' ORDER BY data_os DESC';

    const [rows] = await pool.query(sql, vals);
    res.json({ ok: true, total: rows.length, registros: rows });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ── POST /api/registros ──────────────────────────────────────────────
//    Body: { rows: [...], mes_ref: 'YYYY-MM', nome_arquivo: '...' }
//    Apaga os registros do mês e re-insere (upsert por mês)
app.post('/api/registros', async (req, res) => {
  const { rows, mes_ref, nome_arquivo } = req.body;

  if (!rows || !Array.isArray(rows) || rows.length === 0)
    return res.status(400).json({ ok: false, erro: 'Nenhuma linha enviada.' });

  const mesRef = mes_ref || mesAtual();
  const conn   = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // 1. Remove registros antigos do mesmo mês (substituição total)
    await conn.query('DELETE FROM registros WHERE mes_ref = ?', [mesRef]);

    // 2. Insere os novos registros em lote
    const inserts = rows.map(r => {
      const dt    = r['Data'] ? parseBRDate(r['Data']) : null;
      const valid = dt && !isNaN(dt.getTime()) ? dt : null;
      const val   = parseBRValue(r['Valor']);

      return [
        valid,
        String(r['Numero OS'] || r['Nº OS'] || '').trim() || null,
        String(r['Atendimento'] || '').trim()  || null,
        String(r['Tipo serviço'] || '').trim() || null,
        String(r['Tipo'] || '').trim()         || null,
        String(r['Forma'] || '').trim()        || null,
        val,
        mesRef
      ];
    });

    await conn.query(
      `INSERT INTO registros
         (data_os, numero_os, atendimento, tipo_servico, tipo, forma, valor, mes_ref)
       VALUES ?`,
      [inserts]
    );

    // 3. Registra no log
    await conn.query(
      `INSERT INTO log_importacao (nome_arquivo, mes_ref, total_linhas) VALUES (?, ?, ?)`,
      [nome_arquivo || 'desconhecido', mesRef, rows.length]
    );

    await conn.commit();
    res.json({ ok: true, inseridos: rows.length, mes_ref: mesRef });

  } catch (e) {
    await conn.rollback();
    res.status(500).json({ ok: false, erro: e.message });
  } finally {
    conn.release();
  }
});

// ── GET /api/meses ───────────────────────────────────────────────────
//    Lista todos os meses com dados (mês atual + anteriores)
app.get('/api/meses', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        r.mes_ref,
        COUNT(*) AS total_registros,
        SUM(CASE WHEN tipo NOT LIKE '%storno%' AND tipo NOT LIKE '%ancel%' THEN valor ELSE 0 END) AS bruto,
        SUM(CASE WHEN tipo LIKE '%storno%' OR tipo LIKE '%ancel%' THEN valor ELSE 0 END)          AS estorno,
        MAX(r.importado_em) AS ultima_importacao,
        (SELECT fechado_em FROM fechamento_mensal fm WHERE fm.mes_ref = r.mes_ref) AS fechado_em
      FROM registros r
      GROUP BY r.mes_ref
      ORDER BY r.mes_ref DESC
    `);
    res.json({ ok: true, meses: rows });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ── POST /api/fechar-mes ─────────────────────────────────────────────
//    Gera snapshot consolidado do mês e salva em fechamento_mensal
//    Body: { mes_ref: 'YYYY-MM' }   (padrão: mês anterior)
app.post('/api/fechar-mes', async (req, res) => {
  const mesRef = req.body.mes_ref || mesAnterior();
  const conn   = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // ── KPIs gerais
    const [[kpi]] = await conn.query(`
      SELECT
        COUNT(*)                                                                                  AS total_registros,
        SUM(CASE WHEN tipo NOT LIKE '%storno%' AND tipo NOT LIKE '%ancel%' THEN 1 ELSE 0 END)  AS total_pagamentos,
        SUM(CASE WHEN tipo LIKE '%storno%' OR tipo LIKE '%ancel%' THEN 1 ELSE 0 END)            AS total_estornos,
        SUM(CASE WHEN tipo NOT LIKE '%storno%' AND tipo NOT LIKE '%ancel%' THEN valor ELSE 0 END) AS volume_bruto,
        SUM(CASE WHEN tipo LIKE '%storno%' OR tipo LIKE '%ancel%' THEN valor ELSE 0 END)          AS total_estorno_val
      FROM registros WHERE mes_ref = ?
    `, [mesRef]);

    if (!kpi || kpi.total_registros === 0)
      return res.status(404).json({ ok: false, erro: `Nenhum dado encontrado para ${mesRef}` });

    const bruto   = parseFloat(kpi.volume_bruto)    || 0;
    const estorno = parseFloat(kpi.total_estorno_val) || 0;
    const liq     = bruto - estorno;
    const ticket  = kpi.total_pagamentos > 0 ? bruto / kpi.total_pagamentos : 0;
    const taxa    = bruto > 0 ? (estorno / bruto) * 100 : 0;

    // ── Salva fechamento geral (INSERT OR REPLACE)
    await conn.query(`
      INSERT INTO fechamento_mensal
        (mes_ref, total_registros, total_pagamentos, total_estornos,
         volume_bruto, total_estorno_val, faturamento_liq, ticket_medio, taxa_estorno_pct)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
        total_registros=VALUES(total_registros), total_pagamentos=VALUES(total_pagamentos),
        total_estornos=VALUES(total_estornos), volume_bruto=VALUES(volume_bruto),
        total_estorno_val=VALUES(total_estorno_val), faturamento_liq=VALUES(faturamento_liq),
        ticket_medio=VALUES(ticket_medio), taxa_estorno_pct=VALUES(taxa_estorno_pct),
        fechado_em=NOW()
    `, [mesRef, kpi.total_registros, kpi.total_pagamentos, kpi.total_estornos,
        bruto, estorno, liq, ticket.toFixed(2), taxa.toFixed(2)]);

    // ── Resumo por forma de pagamento
    await conn.query('DELETE FROM resumo_pagamento WHERE mes_ref = ?', [mesRef]);
    await conn.query(`
      INSERT INTO resumo_pagamento (mes_ref, forma, volume_bruto, total_estorno, liq)
      SELECT
        mes_ref, COALESCE(NULLIF(TRIM(forma),''), 'Não informado'),
        SUM(CASE WHEN tipo NOT LIKE '%storno%' AND tipo NOT LIKE '%ancel%' THEN valor ELSE 0 END),
        SUM(CASE WHEN tipo LIKE '%storno%' OR tipo LIKE '%ancel%' THEN valor ELSE 0 END),
        SUM(CASE WHEN tipo NOT LIKE '%storno%' AND tipo NOT LIKE '%ancel%' THEN valor ELSE -valor END)
      FROM registros WHERE mes_ref = ?
      GROUP BY mes_ref, forma
    `, [mesRef]);

    // ── Resumo por tipo de serviço
    await conn.query('DELETE FROM resumo_servico WHERE mes_ref = ?', [mesRef]);
    await conn.query(`
      INSERT INTO resumo_servico (mes_ref, tipo_servico, volume_bruto, total_estorno, liq)
      SELECT
        mes_ref, COALESCE(NULLIF(TRIM(tipo_servico),''), 'Não informado'),
        SUM(CASE WHEN tipo NOT LIKE '%storno%' AND tipo NOT LIKE '%ancel%' THEN valor ELSE 0 END),
        SUM(CASE WHEN tipo LIKE '%storno%' OR tipo LIKE '%ancel%' THEN valor ELSE 0 END),
        SUM(CASE WHEN tipo NOT LIKE '%storno%' AND tipo NOT LIKE '%ancel%' THEN valor ELSE -valor END)
      FROM registros WHERE mes_ref = ?
      GROUP BY mes_ref, tipo_servico
    `, [mesRef]);

    // ── Resumo por atendimento
    await conn.query('DELETE FROM resumo_atendimento WHERE mes_ref = ?', [mesRef]);
    await conn.query(`
      INSERT INTO resumo_atendimento (mes_ref, atendimento, volume_bruto, total_estorno, liq)
      SELECT
        mes_ref, COALESCE(NULLIF(TRIM(atendimento),''), 'Não informado'),
        SUM(CASE WHEN tipo NOT LIKE '%storno%' AND tipo NOT LIKE '%ancel%' THEN valor ELSE 0 END),
        SUM(CASE WHEN tipo LIKE '%storno%' OR tipo LIKE '%ancel%' THEN valor ELSE 0 END),
        SUM(CASE WHEN tipo NOT LIKE '%storno%' AND tipo NOT LIKE '%ancel%' THEN valor ELSE -valor END)
      FROM registros WHERE mes_ref = ?
      GROUP BY mes_ref, atendimento
    `, [mesRef]);

    await conn.commit();

    res.json({
      ok: true,
      mes_ref: mesRef,
      kpi: { bruto, estorno, liq, ticket: parseFloat(ticket.toFixed(2)), taxa: parseFloat(taxa.toFixed(2)) },
      mensagem: `✅ Mês ${mesRef} fechado e salvo com sucesso!`
    });

  } catch (e) {
    await conn.rollback();
    res.status(500).json({ ok: false, erro: e.message });
  } finally {
    conn.release();
  }
});

// ── GET /api/historico ───────────────────────────────────────────────
//    Retorna todos os fechamentos mensais para comparação histórica
app.get('/api/historico', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM fechamento_mensal ORDER BY mes_ref DESC'
    );
    res.json({ ok: true, historico: rows });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ── GET /api/historico/:mes ──────────────────────────────────────────
app.get('/api/historico/:mes', async (req, res) => {
  const mesRef = req.params.mes;
  try {
    const [[fechamento]] = await pool.query(
      'SELECT * FROM fechamento_mensal WHERE mes_ref = ?', [mesRef]
    );
    const [pagamentos]   = await pool.query(
      'SELECT * FROM resumo_pagamento WHERE mes_ref = ? ORDER BY volume_bruto DESC', [mesRef]
    );
    const [servicos]     = await pool.query(
      'SELECT * FROM resumo_servico WHERE mes_ref = ? ORDER BY volume_bruto DESC', [mesRef]
    );
    const [atendimentos] = await pool.query(
      'SELECT * FROM resumo_atendimento WHERE mes_ref = ? ORDER BY volume_bruto DESC', [mesRef]
    );

    res.json({ ok: true, mes_ref: mesRef, fechamento, pagamentos, servicos, atendimentos });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ── GET /api/logs ────────────────────────────────────────────────────
app.get('/api/logs', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM log_importacao ORDER BY importado_em DESC LIMIT 50'
    );
    res.json({ ok: true, logs: rows });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// =====================================================================
//  AGENDAMENTO AUTOMÁTICO (node-cron)
// =====================================================================

// ── Todo dia às 23:59 — fecha mês anterior se for o 1º dia do mês ───
cron.schedule('59 23 1 * *', async () => {
  const mes = mesAnterior();
  console.log(`[CRON] Fechando mês anterior: ${mes}`);
  try {
    const conn = await pool.getConnection();
    // Chama a mesma lógica de fechamento
    const response = await fetch(`http://localhost:${PORT}/api/fechar-mes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mes_ref: mes })
    });
    const json = await response.json();
    console.log(`[CRON] Resultado: ${json.mensagem || json.erro}`);
    conn.release();
  } catch (e) {
    console.error('[CRON] Erro ao fechar mês:', e.message);
  }
}, { timezone: 'America/Sao_Paulo' });

// ── Todo dia à meia-noite — log de saúde ────────────────────────────
cron.schedule('0 0 * * *', async () => {
  try {
    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM registros');
    console.log(`[CRON] ${new Date().toLocaleString('pt-BR')} — Banco OK, ${total} registros.`);
  } catch (e) {
    console.error('[CRON] Erro:', e.message);
  }
}, { timezone: 'America/Sao_Paulo' });

// =====================================================================
//  START
// =====================================================================
const PORT = process.env.PORT || 3001;

conectar()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n🚀 Samsung Financeiro API rodando em http://localhost:${PORT}`);
      console.log(`   Endpoints:`);
      console.log(`   GET  /api/status`);
      console.log(`   GET  /api/registros?mes=YYYY-MM`);
      console.log(`   POST /api/registros   (importar Excel)`);
      console.log(`   GET  /api/meses       (listar meses disponíveis)`);
      console.log(`   POST /api/fechar-mes  (salvar mês histórico)`);
      console.log(`   GET  /api/historico   (todos os fechamentos)`);
      console.log(`   GET  /api/historico/:mes`);
      console.log(`   GET  /api/logs\n`);
    });
  })
  .catch(e => {
    console.error('❌ Falha ao conectar ao MySQL:', e.message);
    console.error('   Verifique as credenciais em DB_CONFIG no server.js');
    process.exit(1);
  });