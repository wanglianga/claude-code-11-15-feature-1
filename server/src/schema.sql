-- 生鲜订货决策系统数据库结构
-- 四个模块（需求还原/分位预测/门店改量/收市复盘）靠不可变版本串联。

CREATE TABLE IF NOT EXISTS stores (
  id   SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id         SERIAL PRIMARY KEY,
  code       TEXT UNIQUE NOT NULL,   -- LEAFY 叶菜 / ROOT 根茎
  name       TEXT NOT NULL,
  default_cu NUMERIC NOT NULL,       -- 缺货单位损失（毛利 + 客流损失）
  default_co NUMERIC NOT NULL        -- 报损单位成本
);

CREATE TABLE IF NOT EXISTS skus (
  id             SERIAL PRIMARY KEY,
  category_id    INT NOT NULL REFERENCES categories(id),
  code           TEXT UNIQUE NOT NULL,
  name           TEXT NOT NULL,
  unit           TEXT NOT NULL DEFAULT '份',
  min_order_unit NUMERIC NOT NULL DEFAULT 1,  -- 最小订货单位，建议量向上取整到它的整数倍
  price          NUMERIC NOT NULL,   -- 售价
  cost           NUMERIC NOT NULL,   -- 成本（报损单位成本基准）
  is_new         BOOLEAN NOT NULL DEFAULT FALSE  -- 新品无历史，走品类先验
);

-- 门店×品类成本参数覆盖：同品类不同门店允许不同
CREATE TABLE IF NOT EXISTS cost_params (
  id          SERIAL PRIMARY KEY,
  store_id    INT NOT NULL REFERENCES stores(id),
  category_id INT NOT NULL REFERENCES categories(id),
  cu NUMERIC NOT NULL,
  co NUMERIC NOT NULL,
  UNIQUE(store_id, category_id)
);

-- 需求还原产物：截断观测样本（按门店/SKU/营业日）
CREATE TABLE IF NOT EXISTS demand_samples (
  id            SERIAL PRIMARY KEY,
  store_id      INT NOT NULL REFERENCES stores(id),
  sku_id        INT NOT NULL REFERENCES skus(id),
  business_date DATE NOT NULL,
  open_hours    NUMERIC NOT NULL,         -- 当日营业时长（小时）
  sales_qty     NUMERIC NOT NULL,         -- 实销
  stockout_flag BOOLEAN,                  -- 断货标记；NULL = 标记缺失 → 只能降级保守估计
  sellout_time  TEXT,                     -- 售罄时点 'HH:MM'；NULL = 未售罄
  in_stock_hours NUMERIC NOT NULL,        -- 有货时段时长
  in_stock_rate NUMERIC NOT NULL,         -- 有货时段销售速率
  restored_demand NUMERIC NOT NULL,       -- 还原后需求（截断观测点估计）
  is_censored   BOOLEAN NOT NULL,         -- 是否截断观测（售罄/断货）
  degraded      BOOLEAN NOT NULL DEFAULT FALSE,  -- 断货标记缺失 → 降级
  excluded_from_training BOOLEAN NOT NULL DEFAULT FALSE,  -- 盘点差异批次等剔除
  exclude_reason TEXT,
  source        TEXT NOT NULL DEFAULT 'seed',     -- seed / review_reflow（复盘回流）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(store_id, sku_id, business_date)
);

-- 建议表：每个（门店, 到货日）只有一张；重复提交按幂等键并表
CREATE TABLE IF NOT EXISTS suggestion_tables (
  id           SERIAL PRIMARY KEY,
  store_id     INT NOT NULL REFERENCES stores(id),
  arrival_date DATE NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',  -- open / confirmed
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(store_id, arrival_date)
);

-- 建议版本：不可变。重算只产生新修订版本，不改写旧版本与已确认订单
CREATE TABLE IF NOT EXISTS suggestion_versions (
  id               SERIAL PRIMARY KEY,
  table_id         INT NOT NULL REFERENCES suggestion_tables(id),
  version_no       INT NOT NULL,
  revision_of      INT REFERENCES suggestion_versions(id),
  idempotency_key  TEXT UNIQUE NOT NULL,      -- 幂等键：重复提交并成一张表
  trigger_event    TEXT NOT NULL DEFAULT 'manual',  -- manual/promo_cancelled/temp_drop/delivery_delay/waste_carryover
  feature_snapshot JSONB NOT NULL,   -- 特征快照（事件因子、口径、样本窗口）
  cost_snapshot    JSONB NOT NULL,   -- 标定的 Cu/Co/分位快照（标定错会导致归因整体偏移，故随版本固化）
  status           TEXT NOT NULL DEFAULT 'issued',  -- issued / superseded / locked(已确认)
  created_by       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(table_id, version_no)
);

CREATE TABLE IF NOT EXISTS suggestion_items (
  id               SERIAL PRIMARY KEY,
  version_id       INT NOT NULL REFERENCES suggestion_versions(id),
  sku_id           INT NOT NULL REFERENCES skus(id),
  quantile         NUMERIC NOT NULL,   -- 临界分位 τ = Cu/(Cu+Co)
  suggested_qty    NUMERIC NOT NULL,   -- 系统建议量（已向上取整到最小订货单位）
  raw_qty          NUMERIC NOT NULL,   -- 取整前
  model_note       TEXT,               -- 新品先验 / 断货标记缺失降级保守 等
  feature_snapshot JSONB NOT NULL,     -- 单品特征快照
  UNIQUE(version_id, sku_id)
);

-- 确认订单：锁定当时版本，原样保留供复盘归因
CREATE TABLE IF NOT EXISTS orders (
  id              SERIAL PRIMARY KEY,
  table_id        INT NOT NULL REFERENCES suggestion_tables(id),
  version_id      INT NOT NULL REFERENCES suggestion_versions(id),
  store_id        INT NOT NULL REFERENCES stores(id),
  arrival_date    DATE NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'confirmed',
  confirmed_by    TEXT NOT NULL,
  confirmed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  id            SERIAL PRIMARY KEY,
  order_id      INT NOT NULL REFERENCES orders(id),
  sku_id        INT NOT NULL REFERENCES skus(id),
  qty           NUMERIC NOT NULL,   -- 门店确认量（改量后）
  reason_code   TEXT,               -- 改量原因码
  suggested_qty NUMERIC NOT NULL,   -- 当时系统建议量（快照）
  UNIQUE(order_id, sku_id)
);

-- 收市复盘：按订单版本归因；baseline 口径固定为观测需求（restored_demand），中途不换
CREATE TABLE IF NOT EXISTS reviews (
  id           SERIAL PRIMARY KEY,
  order_id     INT UNIQUE NOT NULL REFERENCES orders(id),
  version_id   INT NOT NULL REFERENCES suggestion_versions(id),
  store_id     INT NOT NULL REFERENCES stores(id),
  arrival_date DATE NOT NULL,
  baseline     TEXT NOT NULL DEFAULT 'restored_demand',
  status       TEXT NOT NULL DEFAULT 'open',  -- open / closed
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS review_items (
  id                   SERIAL PRIMARY KEY,
  review_id            INT NOT NULL REFERENCES reviews(id),
  sku_id               INT NOT NULL REFERENCES skus(id),
  order_qty            NUMERIC NOT NULL,
  actual_sales         NUMERIC,          -- 实销
  waste_qty            NUMERIC,          -- 报损
  restored_demand      NUMERIC,          -- 当日还原需求（观测需求口径）
  stockout_loss_qty    NUMERIC,          -- 缺货损失量 = max(0, 观测需求 - 实销)
  waste_cost           NUMERIC,          -- 报损金额 = 报损量 × Co
  stockout_loss_amount NUMERIC,          -- 缺货损失金额 = 缺货量 × Cu
  sample_id            INT REFERENCES demand_samples(id),  -- 回流到需求还原的样本
  sample_excluded      BOOLEAN NOT NULL DEFAULT FALSE,     -- 被剔除（盘点差异批次）
  UNIQUE(review_id, sku_id)
);

-- 盘点：库存与盘点对不上以盘点为准，留差异记录，差异批次从训练样本剔除
CREATE TABLE IF NOT EXISTS stocktakes (
  id            SERIAL PRIMARY KEY,
  store_id      INT NOT NULL REFERENCES stores(id),
  sku_id        INT NOT NULL REFERENCES skus(id),
  business_date DATE NOT NULL,
  system_qty    NUMERIC NOT NULL,
  actual_qty    NUMERIC NOT NULL,
  difference    NUMERIC NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(store_id, sku_id, business_date)
);

-- 系统库存快照（对照用）
CREATE TABLE IF NOT EXISTS inventory_snapshots (
  id            SERIAL PRIMARY KEY,
  store_id      INT NOT NULL REFERENCES stores(id),
  sku_id        INT NOT NULL REFERENCES skus(id),
  business_date DATE NOT NULL,
  system_qty    NUMERIC NOT NULL,
  UNIQUE(store_id, sku_id, business_date)
);

-- 报损单：可次日补录；窗口内触发结转重算，过窗单独存档并说明出处
CREATE TABLE IF NOT EXISTS waste_records (
  id            SERIAL PRIMARY KEY,
  store_id      INT NOT NULL REFERENCES stores(id),
  sku_id        INT NOT NULL REFERENCES skus(id),
  business_date DATE NOT NULL,
  qty           NUMERIC NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  within_window BOOLEAN NOT NULL,
  disposition   TEXT NOT NULL,   -- recalc 结转重算 / archived 过窗存档
  note          TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL,   -- hq / manager
  store_id      INT REFERENCES stores(id)
);

-- 写死的取舍：口径与窗口等系统级参数
CREATE TABLE IF NOT EXISTS system_params (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO system_params(key, value) VALUES
  ('demand_baseline', 'restored_demand'),  -- 复盘归因基准：观测需求（还原后），中途不能换
  ('open_hours', '13'),                    -- 营业时长 08:00-21:00
  ('waste_window_hour', '12'),             -- 报损补录窗口：次日 12:00 前
  ('rounding', 'ceil_to_min_order_unit'),  -- 建议量向上取整到最小订货单位
  ('shelf_grouping', 'category_shelf_life'),          -- 批次台账按“品类保质期分组规则版本”登记
  ('carryover_cost_source', 'rule_version'),          -- 结转成本归属由批次登记时的规则版本裁定
  ('markdown_demand_label', 'markdown_demand'),       -- 折价回升销量单列为折价需求，不回喂模型
  ('markdown_window_hour', '12'),                     -- 折价/报损跨日补录窗口：次日 12:00 前
  ('reconciliation_grain', 'arrival_date')            -- 台账/结转/复盘按到货日逐项对账
ON CONFLICT (key) DO NOTHING;

-- =====================================================================
-- 多期库存结转与临期折价子系统
--   ① 批次台账（按保质期分组登记在库/在途/临期 + 到期日）
--   ② 结转引擎（跨日滚存 + 成本归属，按批次+盘点时点幂等）
--   ③ 折价治理（折价计划与折价需求单列，不回喂模型）
--   ④ 历史复盘（按当时规则版本重算未确认区间，已确认订单不追溯）
-- =====================================================================

-- 品类保质期分组展示字段（生效口径以 shelf_rule_versions.rules 为准）
ALTER TABLE categories ADD COLUMN IF NOT EXISTS shelf_group TEXT;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS shelf_life_days INT;

-- 需求样本：折价需求单列标记（折价回升销量不进入训练）
ALTER TABLE demand_samples ADD COLUMN IF NOT EXISTS demand_class TEXT NOT NULL DEFAULT 'regular';
ALTER TABLE demand_samples ADD COLUMN IF NOT EXISTS markdown_uplift_qty NUMERIC NOT NULL DEFAULT 0;

-- 复盘明细：多期结转成本归属（按批次登记时的规则版本裁定）
ALTER TABLE review_items ADD COLUMN IF NOT EXISTS carryover_qty NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE review_items ADD COLUMN IF NOT EXISTS carryover_cost NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE review_items ADD COLUMN IF NOT EXISTS cost_attribution_date DATE;
ALTER TABLE review_items ADD COLUMN IF NOT EXISTS replay_run_id INT;

-- 复盘确认：确认后不参与重算/不追溯改写
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS confirmed_by TEXT;

-- 保质期分组规则版本：不可变。规则一改就产生新版本，历史区间按“当时版本”重算
CREATE TABLE IF NOT EXISTS shelf_rule_versions (
  id             SERIAL PRIMARY KEY,
  version_no     INT UNIQUE NOT NULL,
  name           TEXT NOT NULL,
  effective_from DATE NOT NULL,
  effective_to   DATE,                       -- NULL = 仍在生效
  status         TEXT NOT NULL DEFAULT 'active',  -- active / archived
  rules          JSONB NOT NULL,             -- {groups:{LEAFY:{shelfLifeDays,carryoverAllowed,...}}, ...}
  created_by     TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 批次台账：一个（门店,SKU,批次号）一条；到期日由登记时规则版本裁定
CREATE TABLE IF NOT EXISTS batches (
  id               SERIAL PRIMARY KEY,
  store_id         INT NOT NULL REFERENCES stores(id),
  sku_id           INT NOT NULL REFERENCES skus(id),
  batch_no         TEXT NOT NULL,
  rule_version_id  INT NOT NULL REFERENCES shelf_rule_versions(id),
  arrival_date     DATE NOT NULL,
  expiry_date      DATE NOT NULL,
  shelf_life_days  INT NOT NULL,
  received_qty     NUMERIC NOT NULL,
  in_stock_qty     NUMERIC NOT NULL,
  in_transit_qty   NUMERIC NOT NULL DEFAULT 0,
  near_expiry_qty  NUMERIC NOT NULL DEFAULT 0,
  unit_cost        NUMERIC NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open',  -- open / closed
  last_stocktake_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(store_id, sku_id, batch_no)
);

-- 批次台账流水：登记/到货/盘点/结转/到期/当天清，按 ref_key 幂等
CREATE TABLE IF NOT EXISTS batch_ledger_entries (
  id             SERIAL PRIMARY KEY,
  batch_id       INT NOT NULL REFERENCES batches(id),
  business_date  DATE NOT NULL,
  entry_type     TEXT NOT NULL,   -- register / arrive / stocktake / carryover / expiry / clearance
  in_qty         NUMERIC NOT NULL DEFAULT 0,
  out_qty        NUMERIC NOT NULL DEFAULT 0,
  in_stock_after NUMERIC NOT NULL,
  in_transit_after NUMERIC NOT NULL,
  near_expiry_after NUMERIC NOT NULL,
  ref_key        TEXT UNIQUE NOT NULL,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 批次盘点：与结转作业按（批次, 盘点时点）幂等合并；重复上报不生成两份结转
CREATE TABLE IF NOT EXISTS batch_stocktakes (
  id             SERIAL PRIMARY KEY,
  store_id       INT NOT NULL REFERENCES stores(id),
  sku_id         INT NOT NULL REFERENCES skus(id),
  batch_id       INT NOT NULL REFERENCES batches(id),
  business_date  DATE NOT NULL,
  system_qty     NUMERIC NOT NULL,
  actual_qty     NUMERIC NOT NULL,
  difference     NUMERIC NOT NULL,
  stocktake_at   TIMESTAMPTZ NOT NULL,
  rule_version_id INT NOT NULL REFERENCES shelf_rule_versions(id),
  excluded_from_training BOOLEAN NOT NULL DEFAULT FALSE,  -- 有差异的批次不进入训练样本
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(batch_id, stocktake_at)
);

-- 盘点差异/到期报废/当天清单独立账；账面与实物不符以盘点为准
CREATE TABLE IF NOT EXISTS inventory_adjustments (
  id            SERIAL PRIMARY KEY,
  store_id      INT NOT NULL REFERENCES stores(id),
  sku_id        INT NOT NULL REFERENCES skus(id),
  batch_id      INT NOT NULL REFERENCES batches(id),
  business_date DATE NOT NULL,
  adjust_type   TEXT NOT NULL,   -- stocktake_variance / expiry_writeoff / clearance
  qty           NUMERIC NOT NULL,       -- 盘点差异为带符号差额
  unit_cost     NUMERIC NOT NULL,
  amount        NUMERIC NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending_review',  -- pending_review / resolved
  review_note   TEXT,
  ref_key       TEXT UNIQUE NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 结转作业：一个（门店, 营业日, 盘点时点）一次；重复提交幂等返回
CREATE TABLE IF NOT EXISTS carryover_runs (
  id              SERIAL PRIMARY KEY,
  store_id        INT NOT NULL REFERENCES stores(id),
  business_date   DATE NOT NULL,
  target_date     DATE NOT NULL,
  rule_version_id INT NOT NULL REFERENCES shelf_rule_versions(id),
  stocktake_at    TIMESTAMPTZ NOT NULL,
  idempotency_key TEXT UNIQUE,
  status          TEXT NOT NULL DEFAULT 'applied',
  totals          JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(store_id, business_date, stocktake_at)
);

-- 同一（门店, 营业日）只允许一次结转作业：不同盘点时点再次提交也合并到该次，绝不重复滚存
CREATE UNIQUE INDEX IF NOT EXISTS carryover_runs_one_per_business_day
  ON carryover_runs(store_id, business_date);

-- 结转明细：每批次一行，归到原到货日或结转日由规则版本裁定
CREATE TABLE IF NOT EXISTS carryover_lines (
  id              SERIAL PRIMARY KEY,
  run_id          INT NOT NULL REFERENCES carryover_runs(id),
  store_id        INT NOT NULL REFERENCES stores(id),
  sku_id          INT NOT NULL REFERENCES skus(id),
  batch_id        INT NOT NULL REFERENCES batches(id),
  business_date   DATE NOT NULL,
  target_date     DATE NOT NULL,
  rule_version_id INT NOT NULL REFERENCES shelf_rule_versions(id),  -- 营业日生效版本（审计用）
  batch_rule_version_id INT NOT NULL REFERENCES shelf_rule_versions(id), -- 批次登记版本：成本归属按它裁定
  basis_qty       NUMERIC NOT NULL,   -- 结转基数（有盘点时以实盘为准）
  expired_qty     NUMERIC NOT NULL,   -- 到期报废
  cleared_qty     NUMERIC NOT NULL,   -- 当天清/不允许结转
  carried_qty     NUMERIC NOT NULL,   -- 滚存次日
  unit_cost       NUMERIC NOT NULL,
  cost_amount     NUMERIC NOT NULL,
  cost_attribution TEXT NOT NULL,     -- origin_arrival / carryover_date
  attributed_date DATE NOT NULL,
  stocktake_at    TIMESTAMPTZ NOT NULL,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(batch_id, stocktake_at)
);

-- 临期折价计划
CREATE TABLE IF NOT EXISTS markdown_plans (
  id              SERIAL PRIMARY KEY,
  store_id        INT NOT NULL REFERENCES stores(id),
  sku_id          INT NOT NULL REFERENCES skus(id),
  batch_id        INT NOT NULL REFERENCES batches(id),
  business_date   DATE NOT NULL,
  rule_version_id INT NOT NULL REFERENCES shelf_rule_versions(id),
  plan_qty        NUMERIC NOT NULL,
  discount_rate   NUMERIC NOT NULL,   -- 0.7 = 七折
  status          TEXT NOT NULL DEFAULT 'active',
  idempotency_key TEXT UNIQUE NOT NULL,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 折价单（可跨日补录）：窗口内重算，过窗存档并注明出处
CREATE TABLE IF NOT EXISTS markdown_entries (
  id            SERIAL PRIMARY KEY,
  plan_id       INT NOT NULL REFERENCES markdown_plans(id),
  store_id      INT NOT NULL REFERENCES stores(id),
  sku_id        INT NOT NULL REFERENCES skus(id),
  business_date DATE NOT NULL,
  sold_qty      NUMERIC NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  within_window BOOLEAN NOT NULL,
  disposition   TEXT NOT NULL,  -- recalc / archived
  note          TEXT,
  entry_key     TEXT UNIQUE NOT NULL
);

-- 折价需求：折价回升销量单列，不当真实需求回喂模型
CREATE TABLE IF NOT EXISTS markdown_demand (
  id               SERIAL PRIMARY KEY,
  plan_id          INT UNIQUE NOT NULL REFERENCES markdown_plans(id),
  store_id         INT NOT NULL REFERENCES stores(id),
  sku_id           INT NOT NULL REFERENCES skus(id),
  business_date    DATE NOT NULL,
  rule_version_id  INT NOT NULL REFERENCES shelf_rule_versions(id),
  planned_qty      NUMERIC NOT NULL,
  discount_rate    NUMERIC NOT NULL,
  sold_qty         NUMERIC NOT NULL,
  uplift_qty       NUMERIC NOT NULL,
  base_qty         NUMERIC NOT NULL,
  markdown_demand_qty NUMERIC NOT NULL DEFAULT 0,   -- 折价需求：折价回升中不计入真实需求的部分
  real_demand_qty  NUMERIC NOT NULL DEFAULT 0,       -- 真实需求：基准量 + 折价回升中按规则计入的部分
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  within_window    BOOLEAN NOT NULL,
  disposition      TEXT NOT NULL,
  replay_run_id    INT
);

-- 历史复盘重算：只重算未确认区间
CREATE TABLE IF NOT EXISTS replay_runs (
  id          SERIAL PRIMARY KEY,
  store_id    INT NOT NULL REFERENCES stores(id),
  category_id INT REFERENCES categories(id),
  date_from   DATE NOT NULL,
  date_to     DATE NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'unconfirmed_only',
  created_by  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'done',
  summary     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS replay_lines (
  id              SERIAL PRIMARY KEY,
  run_id          INT NOT NULL REFERENCES replay_runs(id),
  store_id        INT NOT NULL REFERENCES stores(id),
  sku_id          INT NOT NULL REFERENCES skus(id),
  business_date   DATE NOT NULL,
  review_id       INT REFERENCES reviews(id),
  review_confirmed BOOLEAN NOT NULL,
  rule_version_id INT REFERENCES shelf_rule_versions(id),
  rule_version_no INT,
  action          TEXT NOT NULL,  -- recomputed / unchanged / skipped_confirmed / markdown_recomputed / markdown_unchanged
  old_cost        NUMERIC,
  new_cost        NUMERIC,
  old_attribution_date DATE,
  new_attribution_date DATE,
  delta           NUMERIC,
  note            TEXT
);

-- 按到货日对账：台账 / 结转结果 / 复盘口径
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id         SERIAL PRIMARY KEY,
  store_id   INT NOT NULL REFERENCES stores(id),
  date_from  DATE NOT NULL,
  date_to    DATE NOT NULL,
  summary    JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reconciliation_flags (
  id            SERIAL PRIMARY KEY,
  run_id        INT NOT NULL REFERENCES reconciliation_runs(id),
  store_id      INT NOT NULL REFERENCES stores(id),
  sku_id        INT NOT NULL REFERENCES skus(id),
  arrival_date  DATE NOT NULL,
  batch_id      INT NOT NULL REFERENCES batches(id),
  flag_type     TEXT NOT NULL,  -- ledger_order_mismatch / stale_expired_stock / cost_exceeds_ledger / stocktake_variance_pending
  ledger_qty    NUMERIC NOT NULL,
  carryover_total NUMERIC NOT NULL,
  review_qty    NUMERIC NOT NULL,
  variance      NUMERIC NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending_review',  -- pending_review / resolved
  note          TEXT,
  resolved_by   TEXT,
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(batch_id, flag_type)
);