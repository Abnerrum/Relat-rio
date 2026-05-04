-- =====================================================
--  Samsung Service — Relatório Financeiro
--  Schema MySQL — Execute no MySQL Workbench
-- =====================================================

CREATE DATABASE IF NOT EXISTS samsung_financeiro
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE samsung_financeiro;

-- ─── TABELA PRINCIPAL DE REGISTROS ──────────────────
CREATE TABLE IF NOT EXISTS registros (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  data_os       DATETIME         NULL,
  numero_os     VARCHAR(50)      NULL,
  atendimento   VARCHAR(100)     NULL,
  tipo_servico  VARCHAR(100)     NULL,
  tipo          VARCHAR(50)      NULL,          -- 'Pagamento' ou 'Estorno'
  forma         VARCHAR(50)      NULL,          -- Crédito, Débito, Dinheiro...
  valor         DECIMAL(12,2)    NOT NULL DEFAULT 0,
  mes_ref       CHAR(7)          NOT NULL,      -- 'YYYY-MM'  ex: '2025-04'
  importado_em  DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_mes_ref   (mes_ref),
  INDEX idx_data_os   (data_os),
  INDEX idx_numero_os (numero_os)
) ENGINE=InnoDB;

-- ─── FECHAMENTO MENSAL (SNAPSHOT) ───────────────────
-- Guarda resumo consolidado de cada mês fechado
CREATE TABLE IF NOT EXISTS fechamento_mensal (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  mes_ref            CHAR(7)       NOT NULL UNIQUE,   -- 'YYYY-MM'
  total_registros    INT           NOT NULL DEFAULT 0,
  total_pagamentos   INT           NOT NULL DEFAULT 0,
  total_estornos     INT           NOT NULL DEFAULT 0,
  volume_bruto       DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_estorno_val  DECIMAL(14,2) NOT NULL DEFAULT 0,
  faturamento_liq    DECIMAL(14,2) NOT NULL DEFAULT 0,
  ticket_medio       DECIMAL(12,2) NOT NULL DEFAULT 0,
  taxa_estorno_pct   DECIMAL(5,2)  NOT NULL DEFAULT 0,
  fechado_em         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_mes (mes_ref)
) ENGINE=InnoDB;

-- ─── RESUMO POR FORMA DE PAGAMENTO (por mês) ────────
CREATE TABLE IF NOT EXISTS resumo_pagamento (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  mes_ref       CHAR(7)       NOT NULL,
  forma         VARCHAR(50)   NOT NULL,
  volume_bruto  DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_estorno DECIMAL(12,2) NOT NULL DEFAULT 0,
  liq           DECIMAL(12,2) NOT NULL DEFAULT 0,
  INDEX idx_mes (mes_ref)
) ENGINE=InnoDB;

-- ─── RESUMO POR TIPO DE SERVIÇO (por mês) ───────────
CREATE TABLE IF NOT EXISTS resumo_servico (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  mes_ref       CHAR(7)       NOT NULL,
  tipo_servico  VARCHAR(100)  NOT NULL,
  volume_bruto  DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_estorno DECIMAL(12,2) NOT NULL DEFAULT 0,
  liq           DECIMAL(12,2) NOT NULL DEFAULT 0,
  INDEX idx_mes (mes_ref)
) ENGINE=InnoDB;

-- ─── RESUMO POR ATENDIMENTO (por mês) ───────────────
CREATE TABLE IF NOT EXISTS resumo_atendimento (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  mes_ref       CHAR(7)       NOT NULL,
  atendimento   VARCHAR(100)  NOT NULL,
  volume_bruto  DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_estorno DECIMAL(12,2) NOT NULL DEFAULT 0,
  liq           DECIMAL(12,2) NOT NULL DEFAULT 0,
  INDEX idx_mes (mes_ref)
) ENGINE=InnoDB;

-- ─── LOG DE IMPORTAÇÕES ─────────────────────────────
CREATE TABLE IF NOT EXISTS log_importacao (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  nome_arquivo    VARCHAR(255)  NULL,
  mes_ref         CHAR(7)       NOT NULL,
  total_linhas    INT           NOT NULL DEFAULT 0,
  importado_em    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status          VARCHAR(20)   NOT NULL DEFAULT 'ok'
) ENGINE=InnoDB;

-- ─── VIEW: KPIs DO MÊS ATUAL ────────────────────────
CREATE OR REPLACE VIEW v_kpi_atual AS
SELECT
  mes_ref,
  COUNT(*)                                          AS total_registros,
  SUM(CASE WHEN tipo NOT LIKE '%storno%' AND tipo NOT LIKE '%ancel%' THEN 1 ELSE 0 END) AS total_pagamentos,
  SUM(CASE WHEN tipo LIKE '%storno%' OR tipo LIKE '%ancel%' THEN 1 ELSE 0 END)          AS total_estornos,
  SUM(CASE WHEN tipo NOT LIKE '%storno%' AND tipo NOT LIKE '%ancel%' THEN valor ELSE 0 END) AS volume_bruto,
  SUM(CASE WHEN tipo LIKE '%storno%' OR tipo LIKE '%ancel%' THEN valor ELSE 0 END)          AS total_estorno_val,
  SUM(CASE WHEN tipo NOT LIKE '%storno%' AND tipo NOT LIKE '%ancel%' THEN valor ELSE -valor END) AS faturamento_liq
FROM registros
GROUP BY mes_ref
ORDER BY mes_ref DESC;
Select*From registros;