import type pg from 'pg';
import { pool } from '../db';
import { addDaysStr, diffDays, expiryOf, groupRule, judgeCarryover, parseRules, batchState, isNearExpiry, isExpired, type CarryoverVerdict, type GroupRule, type RuleVersionRules } from '../lib/shelf';
import { todayStr } from '../lib/dates';
import { ConflictError, NotFoundError } from './suggestionService';

type Db = pg.Pool | pg.PoolClient;

export interface RuleVersionRow {
  id: number;
  version_no: number;
  name: string;
  effective_from: string;
  effective_to: string | null;
  status: string;
  rules: RuleVersionRules;
  created_by: string;
  created_at: string;
}

function normalizeVersion(row: Record<string, unknown>): RuleVersionRow {
  return { ...(row as unknown as RuleVersionRow), rules: parseRules(row.rules) };
}

/** 取某营业日生效的分组规则版本（effective_from ≤ date 的最新版本） */
export async function ruleVersionOn(db: Db, date: string): Promise<RuleVersionRow | null> {
  const r = await db.query(
    `SELECT * FROM shelf_rule_versions
      WHERE effective_from <= $1::date
        AND (effective_to IS NULL OR effective_to >= $1::date)
      ORDER BY effective_from DESC, version_no DESC LIMIT 1`,
    [date],
  );
  return r.rows[0] ? normalizeVersion(r.rows[0]) : null;
}

export async function listRuleVersions(db: Db, date: string) {
  const versions = await db.query('SELECT * FROM shelf_rule_versions ORDER BY version_no DESC');
  const current = await ruleVersionOn(db, date);
  return {
    versions: versions.rows.map(normalizeVersion),
    current,
    effectiveDate: date,
  };
}

/**
 * 新建分组规则版本（总部）：
 * - 版本不可变；原生效版本归档并把 effective_to 收口到新版本生效日前一天；
 * - 新版本生效日必须晚于当前生效版本，且不早于今日：避免用新口径悄悄回写已结账区间；
 *   历史区间的口径分叉交给「历史复盘重算未确认区间」按当时版本重算。
 */
export async function createRuleVersion(params: {
  name: string;
  effectiveFrom: string;
  rules: RuleVersionRules;
  createdBy: string;
}): Promise<{ versionId: number; versionNo: number; archivedVersionNo: number | null }> {
  const rules = parseRules(params.rules);
  const today = todayStr();
  if (params.effectiveFrom < today) {
    throw new ConflictError(
      'RULE_EFFECTIVE_CONFLICT',
      `新规则生效日 ${params.effectiveFrom} 早于今日 ${today}：不允许回写已结账区间，历史区间请走「历史复盘」按当时版本重算`,
    );
  }
  const codes = await pool().query('SELECT code FROM categories');
  const known = new Set(codes.rows.map((r: { code: string }) => r.code));
  for (const code of Object.keys(rules.groups)) {
    if (!known.has(code)) throw new ConflictError('BAD_REQUEST', `未知品类分组 ${code}`);
  }
  for (const [code, g] of Object.entries(rules.groups)) {
    if (!(g.shelfLifeDays >= 1)) throw new ConflictError('BAD_REQUEST', `${code} 保质期天数必须 ≥ 1`);
    if (!(g.markdownDiscount > 0 && g.markdownDiscount <= 1)) {
      throw new ConflictError('BAD_REQUEST', `${code} 折价率必须在 (0,1]`);
    }
  }

  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const active = await client.query(
      "SELECT * FROM shelf_rule_versions WHERE status='active' ORDER BY version_no DESC LIMIT 1 FOR UPDATE",
    );
    const cur = active.rows[0];
    if (cur && params.effectiveFrom <= cur.effective_from) {
      throw new ConflictError(
        'RULE_EFFECTIVE_CONFLICT',
        `新规则生效日必须晚于当前生效版本 v${cur.version_no}（${cur.effective_from}）`,
        { activeVersionNo: cur.version_no, activeEffectiveFrom: cur.effective_from },
      );
    }
    const noRes = await client.query('SELECT COALESCE(MAX(version_no),0)+1 AS no FROM shelf_rule_versions');
    const versionNo = Number(noRes.rows[0].no);
    if (cur) {
      await client.query(
        "UPDATE shelf_rule_versions SET status='archived', effective_to=$2 WHERE id=$1",
        [cur.id, addDaysStr(params.effectiveFrom, -1)],
      );
    }
    const ins = await client.query(
      `INSERT INTO shelf_rule_versions (version_no, name, effective_from, effective_to, status, rules, created_by)
       VALUES ($1,$2,$3,NULL,'active',$4,$5) RETURNING id`,
      [versionNo, params.name, params.effectiveFrom, JSON.stringify(rules), params.createdBy],
    );
    // 品类展示字段跟随当前生效版本（台账查询仍以各批次登记版本为准）
    for (const [code, g] of Object.entries(rules.groups)) {
      await client.query('UPDATE categories SET shelf_group=$1, shelf_life_days=$2 WHERE code=$3', [
        code, g.shelfLifeDays, code,
      ]);
    }
    await client.query('COMMIT');
    return { versionId: ins.rows[0].id, versionNo, archivedVersionNo: cur ? cur.version_no : null };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

interface BatchRow {
  id: number;
  store_id: number;
  sku_id: number;
  batch_no: string;
  rule_version_id: number;
  arrival_date: string;
  expiry_date: string;
  shelf_life_days: number;
  received_qty: string;
  in_stock_qty: string;
  in_transit_qty: string;
  near_expiry_qty: string;
  unit_cost: string;
  status: string;
}

async function batchWithSku(db: Db, storeId: number, skuId: number) {
  const r = await db.query(
    `SELECT s.*, c.code AS category_code, c.name AS category_name
       FROM skus s JOIN categories c ON c.id=s.category_id WHERE s.id=$1`,
    [skuId],
  );
  if (!r.rows[0]) throw new NotFoundError('SKU 不存在');
  return r.rows[0] as { id: number; category_id: number; category_code: string; category_name: string; name: string; unit: string };
}

/**
 * 登记批次（按保质期分组）：到期日 = 到货日 + 保质期天数 - 1，规则版本取到货日生效版本。
 * 到货日 > 今日 → 记为在途；否则计入在库。
 */
export async function registerBatch(params: {
  storeId: number;
  skuId: number;
  batchNo: string;
  arrivalDate: string;
  qty: number;
  unitCost?: number;
  businessDate?: string;
}): Promise<{ batchId: number; idempotent: boolean; expiryDate: string; ruleVersionNo: number; state: string }> {
  if (!(params.qty > 0)) throw new ConflictError('BAD_REQUEST', '批次数量必须大于 0');
  const today = params.businessDate ?? todayStr();
  const sku = await batchWithSku(pool(), params.storeId, params.skuId);
  const version = await ruleVersionOn(pool(), params.arrivalDate);
  if (!version) throw new ConflictError('NO_RULE_VERSION', `到货日 ${params.arrivalDate} 无生效的分组规则版本`);
  const rule = groupRule(version.rules, sku.category_code);
  const expiryDate = expiryOf(params.arrivalDate, rule.shelfLifeDays);
  const unitCost = params.unitCost ?? (await skuCost(params.skuId));

  const dup = await pool().query(
    'SELECT id, expiry_date, received_qty FROM batches WHERE store_id=$1 AND sku_id=$2 AND batch_no=$3',
    [params.storeId, params.skuId, params.batchNo],
  );
  if (dup.rows[0]) {
    if (Number(dup.rows[0].received_qty) !== params.qty || dup.rows[0].expiry_date !== expiryDate) {
      throw new ConflictError('BATCH_CONFLICT', `批次号 ${params.batchNo} 已存在且数量/到期日不一致`, {
        batchId: dup.rows[0].id,
      });
    }
    return {
      batchId: dup.rows[0].id, idempotent: true, expiryDate,
      ruleVersionNo: version.version_no, state: 'existing',
    };
  }

  const inStock = params.arrivalDate <= today ? params.qty : 0;
  const inTransit = params.arrivalDate > today ? params.qty : 0;
  const nearQty = computeNearQty({ inStock, expiryDate, businessDate: today, rule });
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO batches
         (store_id, sku_id, batch_no, rule_version_id, arrival_date, expiry_date, shelf_life_days,
          received_qty, in_stock_qty, in_transit_qty, near_expiry_qty, unit_cost, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'open') RETURNING id`,
      [
        params.storeId, params.skuId, params.batchNo, version.id, params.arrivalDate, expiryDate,
        rule.shelfLifeDays, params.qty, inStock, inTransit, nearQty, unitCost,
      ],
    );
    const batchId: number = ins.rows[0].id;
    await ledgerEntry(client, {
      batchId, businessDate: today, entryType: 'register', inQty: 0, outQty: 0,
      inStockAfter: inStock, inTransitAfter: inTransit, nearQtyAfter: nearQty,
      refKey: `batch:${batchId}:register`, note: `按规则版本 v${version.version_no} 登记，到期日 ${expiryDate}`,
    });
    if (inStock > 0) {
      await ledgerEntry(client, {
        batchId, businessDate: today, entryType: 'arrive', inQty: params.qty, outQty: 0,
        inStockAfter: inStock, inTransitAfter: 0, nearQtyAfter: nearQty,
        refKey: `batch:${batchId}:arrive`, note: '到货入库',
      });
    }
    await client.query('COMMIT');
    return {
      batchId, idempotent: false, expiryDate, ruleVersionNo: version.version_no,
      state: inStock > 0 ? 'in_stock' : 'in_transit',
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function skuCost(skuId: number): Promise<number> {
  const r = await pool().query('SELECT cost FROM skus WHERE id=$1', [skuId]);
  return Number(r.rows[0]?.cost ?? 0);
}

function computeNearQty(params: {
  inStock: number;
  expiryDate: string;
  businessDate: string;
  rule: GroupRule;
}): number {
  if (params.inStock <= 0) return 0;
  if (isExpired(params.expiryDate, params.businessDate) || isNearExpiry(params.rule, params.expiryDate, params.businessDate)) {
    return params.inStock;
  }
  return 0;
}

async function ledgerEntry(db: Db, e: {
  batchId: number; businessDate: string; entryType: string; inQty: number; outQty: number;
  inStockAfter: number; inTransitAfter: number; nearQtyAfter: number; refKey: string; note?: string;
}): Promise<void> {
  await db.query(
    `INSERT INTO batch_ledger_entries
       (batch_id, business_date, entry_type, in_qty, out_qty, in_stock_after, in_transit_after, near_expiry_after, ref_key, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (ref_key) DO NOTHING`,
    [e.batchId, e.businessDate, e.entryType, e.inQty, e.outQty, e.inStockAfter, e.inTransitAfter, e.nearQtyAfter, e.refKey, e.note ?? null],
  );
}

/** 在途批次到货：在途转在库，生成台账流水 */
export async function arriveBatch(params: {
  storeId: number;
  batchId: number;
  businessDate?: string;
}): Promise<{ batchId: number; idempotent: boolean; inStockQty: number; inTransitQty: number }> {
  const today = params.businessDate ?? todayStr();
  const b = await pool().query('SELECT * FROM batches WHERE id=$1 AND store_id=$2', [params.batchId, params.storeId]);
  const batch = b.rows[0] as BatchRow | undefined;
  if (!batch) throw new NotFoundError('批次不存在');
  if (Number(batch.in_transit_qty) <= 0) {
    return { batchId: batch.id, idempotent: true, inStockQty: Number(batch.in_stock_qty), inTransitQty: 0 };
  }
  const version = await pool().query('SELECT rules FROM shelf_rule_versions WHERE id=$1', [batch.rule_version_id]);
  const rules = parseRules(version.rows[0]?.rules);
  const sku = await batchWithSku(pool(), params.storeId, batch.sku_id);
  const rule = groupRule(rules, sku.category_code);
  const inStock = Number(batch.in_stock_qty) + Number(batch.in_transit_qty);
  const nearQty = computeNearQty({ inStock, expiryDate: batch.expiry_date, businessDate: today, rule });
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE batches SET in_stock_qty=$2, in_transit_qty=0, near_expiry_qty=$3 WHERE id=$1',
      [batch.id, inStock, nearQty],
    );
    await ledgerEntry(client, {
      batchId: batch.id, businessDate: today, entryType: 'arrive', inQty: Number(batch.in_transit_qty), outQty: 0,
      inStockAfter: inStock, inTransitAfter: 0, nearQtyAfter: nearQty,
      refKey: `batch:${batch.id}:arrive:${today}`, note: '在途到货入库',
    });
    await client.query('COMMIT');
    return { batchId: batch.id, idempotent: false, inStockQty: inStock, inTransitQty: 0 };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** 批次台账：按保质期分组展示在库/在途/临期与到期日 */
export async function listBatches(params: {
  storeId: number;
  businessDate?: string;
  categoryId?: number | null;
  skuId?: number | null;
}): Promise<Record<string, unknown>> {
  const businessDate = params.businessDate ?? todayStr();
  const rows = await pool().query(
    `SELECT b.*, s.code AS sku_code, s.name AS sku_name, s.unit, s.min_order_unit,
            c.id AS category_id, c.code AS category_code, c.name AS category_name,
            rv.version_no AS rule_version_no, rv.rules AS rule_rules
       FROM batches b
       JOIN skus s ON s.id=b.sku_id
       JOIN categories c ON c.id=s.category_id
       JOIN shelf_rule_versions rv ON rv.id=b.rule_version_id
      WHERE b.store_id=$1
        AND ($2::int IS NULL OR c.id=$2)
        AND ($3::int IS NULL OR b.sku_id=$3)
      ORDER BY b.arrival_date DESC, b.expiry_date ASC, b.batch_no`,
    [params.storeId, params.categoryId ?? null, params.skuId ?? null],
  );
  const batches = rows.rows.map((r) => {
    const rules = parseRules(r.rule_rules);
    const rule = groupRule(rules, r.category_code);
    const inStock = Number(r.in_stock_qty);
    const inTransit = Number(r.in_transit_qty);
    const state = batchState({ expiryDate: r.expiry_date, businessDate, inStockQty: inStock, inTransitQty: inTransit }, rule);
    const nearQty = computeNearQty({ inStock, expiryDate: r.expiry_date, businessDate, rule });
    return {
      ...r,
      rule_rules: undefined,
      in_stock_qty: inStock,
      in_transit_qty: inTransit,
      near_expiry_qty: nearQty,
      received_qty: Number(r.received_qty),
      unit_cost: Number(r.unit_cost),
      shelf_life_days: Number(r.shelf_life_days),
      rule_version_no: Number(r.rule_version_no),
      business_date: businessDate,
      days_to_expiry: diffDays(businessDate, r.expiry_date),
      state,
      shelf_life_days_rule: rule.shelfLifeDays,
      carryover_allowed: rule.carryoverAllowed,
      near_expiry_days_rule: rule.nearExpiryDays,
    };
  });
  const summary = {
    batchCount: batches.length,
    inStockQty: sum(batches.map((b) => b.in_stock_qty)),
    inTransitQty: sum(batches.map((b) => b.in_transit_qty)),
    nearExpiryQty: sum(batches.map((b) => b.near_expiry_qty)),
    inStockValue: Number(sum(batches.map((b) => b.in_stock_qty * b.unit_cost)).toFixed(2)),
    nearExpiryBatches: batches.filter((b) => b.state === 'near_expiry').length,
    expiredBatches: batches.filter((b) => b.days_to_expiry < 0 && b.in_stock_qty > 0).length,
  };
  const groups = Object.values(
    batches.reduce<Record<string, { categoryCode: string; categoryName: string; shelfLifeDays: number; carryoverAllowed: boolean; qty: number; ruleVersions: number[] }>>(
      (acc, b) => {
        const key = b.category_code;
        acc[key] ??= {
          categoryCode: b.category_code, categoryName: b.category_name,
          shelfLifeDays: b.shelf_life_days_rule, carryoverAllowed: b.carryover_allowed,
          qty: 0, ruleVersions: [],
        };
        acc[key].qty += b.in_stock_qty;
        if (!acc[key].ruleVersions.includes(b.rule_version_no)) acc[key].ruleVersions.push(b.rule_version_no);
        return acc;
      },
      {},
    ),
  );
  return { businessDate, batches, summary, groups };
}

function sum(vals: number[]): number {
  return Number(vals.reduce((a, b) => a + b, 0).toFixed(4));
}

/**
 * 批次盘点：以实物为基准修正账面，差额单独立账；
 * 与结转作业按（批次, 盘点时点）幂等合并——同一盘点时点重复上报不产生第二份。
 */
export async function submitBatchStocktake(params: {
  storeId: number;
  skuId: number;
  batchId: number;
  businessDate: string;
  actualQty: number;
  stocktakeAt?: Date;
}): Promise<{ stocktakeId: number; idempotent: boolean; systemQty: number; difference: number; excluded: boolean; adjustmentId: number | null }> {
  const stocktakeAt = params.stocktakeAt ?? new Date(`${params.businessDate}T21:00:00`);
  const b = await pool().query(
    'SELECT * FROM batches WHERE id=$1 AND store_id=$2 AND sku_id=$3',
    [params.batchId, params.storeId, params.skuId],
  );
  const batch = b.rows[0] as BatchRow | undefined;
  if (!batch) throw new NotFoundError('批次不存在');

  const dup = await pool().query(
    'SELECT * FROM batch_stocktakes WHERE batch_id=$1 AND stocktake_at=$2',
    [params.batchId, stocktakeAt],
  );
  if (dup.rows[0]) {
    return {
      stocktakeId: dup.rows[0].id, idempotent: true,
      systemQty: Number(dup.rows[0].system_qty), difference: Number(dup.rows[0].difference),
      excluded: dup.rows[0].excluded_from_training, adjustmentId: null,
    };
  }

  const systemQty = Number(batch.in_stock_qty);
  const difference = Number((params.actualQty - systemQty).toFixed(4));
  const excluded = difference !== 0;
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO batch_stocktakes
         (store_id, sku_id, batch_id, business_date, system_qty, actual_qty, difference, stocktake_at, rule_version_id, excluded_from_training)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        params.storeId, params.skuId, params.batchId, params.businessDate, systemQty, params.actualQty,
        difference, stocktakeAt, batch.rule_version_id, excluded,
      ],
    );
    const stocktakeId: number = ins.rows[0].id;

    // 以盘点为准：账面修正为实盘（差额不在库存里“藏”着，单独立账）
    const rules = parseRules((await client.query('SELECT rules FROM shelf_rule_versions WHERE id=$1', [batch.rule_version_id])).rows[0]?.rules);
    const sku = await batchWithSku(client, params.storeId, params.skuId);
    const rule = groupRule(rules, sku.category_code);
    const nearQty = computeNearQty({ inStock: params.actualQty, expiryDate: batch.expiry_date, businessDate: params.businessDate, rule });
    await client.query(
      'UPDATE batches SET in_stock_qty=$2, near_expiry_qty=$3, last_stocktake_at=$4 WHERE id=$1',
      [batch.id, params.actualQty, nearQty, stocktakeAt],
    );
    await ledgerEntry(client, {
      batchId: batch.id, businessDate: params.businessDate, entryType: 'stocktake',
      inQty: difference > 0 ? difference : 0, outQty: difference < 0 ? -difference : 0,
      inStockAfter: params.actualQty, inTransitAfter: Number(batch.in_transit_qty), nearQtyAfter: nearQty,
      refKey: `stk-ledger:${stocktakeId}`,
      note: difference === 0 ? '盘点账实相符' : `盘点差异 ${difference}，以实盘为准`,
    });

    let adjustmentId: number | null = null;
    if (excluded) {
      const adj = await client.query(
        `INSERT INTO inventory_adjustments
           (store_id, sku_id, batch_id, business_date, adjust_type, qty, unit_cost, amount, status, ref_key)
         VALUES ($1,$2,$3,$4,'stocktake_variance',$5,$6,$7,'pending_review',$8)
         ON CONFLICT (ref_key) DO NOTHING RETURNING id`,
        [
          params.storeId, params.skuId, batch.id, params.businessDate, difference, Number(batch.unit_cost),
          Number((Math.abs(difference) * Number(batch.unit_cost)).toFixed(2)), `stk:${stocktakeId}`,
        ],
      );
      adjustmentId = adj.rows[0]?.id ?? null;

      // 差异批次不进入训练样本（同日 SKU 样本剔除）
      await client.query(
        `UPDATE demand_samples SET excluded_from_training=TRUE, exclude_reason='盘点差异批次剔除'
          WHERE store_id=$1 AND sku_id=$2 AND business_date=$3`,
        [params.storeId, params.skuId, params.businessDate],
      );
      await client.query(
        `UPDATE review_items ri SET sample_excluded=TRUE
           FROM reviews r
          WHERE ri.review_id=r.id AND r.store_id=$1 AND r.arrival_date=$2 AND ri.sku_id=$3`,
        [params.storeId, params.businessDate, params.skuId],
      );
    }
    await client.query('COMMIT');
    return { stocktakeId, idempotent: false, systemQty, difference, excluded, adjustmentId };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 计算某营业日各批次结转裁定（纯计算，不落库）；供结转作业与历史重算共用。
 * 成本归属按**该营业日生效的分组规则版本**裁定（“当时版本”）：
 * 规则改版后，跨版本边界的批次在新口径下成本归属日会改变 → 历史毛利口径分叉；
 * 批次登记版本（batch_rule_version_id）只决定保质期/到期日等登记口径，随批次固化。
 */
async function planCarryover(db: Db, params: {
  storeId: number;
  businessDate: string;
  categoryId?: number | null;
}): Promise<{
  ruleVersion: RuleVersionRow | null;
  verdicts: Array<CarryoverVerdict & { categoryCode: string; expiryDate: string; batchRuleVersionId: number; batchRuleVersionNo: number; stocktakeAt: string | null; bookQty: number }>;
  stocktakeStamp: string | null;
}> {
  const ruleVersion = await ruleVersionOn(db, params.businessDate);
  if (!ruleVersion) return { ruleVersion: null, verdicts: [], stocktakeStamp: null };

  const rows = await db.query(
    `SELECT b.*, s.name AS sku_name, c.code AS category_code,
            rv.version_no AS batch_rule_version_no, rv.rules AS batch_rules
       FROM batches b
       JOIN skus s ON s.id=b.sku_id
       JOIN categories c ON c.id=s.category_id
       JOIN shelf_rule_versions rv ON rv.id=b.rule_version_id
      WHERE b.store_id=$1
        AND b.arrival_date <= $2::date
        AND b.in_stock_qty > 0
        AND ($3::int IS NULL OR c.id=$3)
        AND b.status='open'
      ORDER BY b.expiry_date, b.id`,
    [params.storeId, params.businessDate, params.categoryId ?? null],
  );

  const verdicts: Array<CarryoverVerdict & { categoryCode: string; expiryDate: string; batchRuleVersionId: number; batchRuleVersionNo: number; stocktakeAt: string | null; bookQty: number }> = [];
  for (const batch of rows.rows as (BatchRow & { sku_name: string; category_code: string; batch_rule_version_no: number; batch_rules: unknown })[]) {
    // 结转口径 = 营业日生效版本（当时版本）；批次登记版本仅作审计
    const rule = groupRule(ruleVersion.rules, batch.category_code);
    const st = await db.query(
      `SELECT actual_qty, stocktake_at FROM batch_stocktakes
        WHERE batch_id=$1 AND business_date <= $2::date
        ORDER BY stocktake_at DESC LIMIT 1`,
      [batch.id, params.businessDate],
    );
    const stRow = st.rows[0];
    const verdict = judgeCarryover(
      {
        batchId: batch.id, skuId: batch.sku_id, batchNo: batch.batch_no,
        arrivalDate: batch.arrival_date, expiryDate: batch.expiry_date,
        unitCost: Number(batch.unit_cost), bookQty: Number(batch.in_stock_qty),
        actualQty: stRow ? Number(stRow.actual_qty) : null,
      },
      params.businessDate,
      rule,
    );
    verdicts.push({
      ...verdict, categoryCode: batch.category_code,
      expiryDate: batch.expiry_date,
      batchRuleVersionId: Number(batch.rule_version_id),
      batchRuleVersionNo: Number(batch.batch_rule_version_no),
      stocktakeAt: stRow ? new Date(stRow.stocktake_at).toISOString() : null,
      bookQty: Number(batch.in_stock_qty),
    });
  }
  return { ruleVersion, verdicts, stocktakeStamp: null };
}

/**
 * 结转作业：按（门店, 营业日, 盘点时点）幂等。
 * 有盘点的批次以实盘为基数（按批次+盘点时点合并），滚动到次日；
 * 成本按营业日生效的分组规则版本归属到原到货日或结转日。
 */
export async function runCarryover(params: {
  storeId: number;
  businessDate: string;
  categoryId?: number | null;
  stocktakeAt?: Date;
  idempotencyKey?: string;
  createdBy: string;
}): Promise<Record<string, unknown>> {
  const stamp = params.stocktakeAt ?? new Date(`${params.businessDate}T22:00:00`);
  const existing = await pool().query(
    'SELECT id, stocktake_at FROM carryover_runs WHERE store_id=$1 AND business_date=$2 AND stocktake_at=$3',
    [params.storeId, params.businessDate, stamp],
  );
  if (existing.rows[0]) {
    const detail = await carryoverDetail(pool(), existing.rows[0].id);
    return { ...detail, idempotent: true };
  }

  // 同日闭环只结转一次：不同盘点时点再次提交 → 合并到已有结转，绝不重复滚存
  // （闭店后的更正盘点请走「历史复盘」按当时版本重算未确认区间）
  const sameDay = await pool().query(
    "SELECT id, stocktake_at FROM carryover_runs WHERE store_id=$1 AND business_date=$2 AND status='applied' ORDER BY id LIMIT 1",
    [params.storeId, params.businessDate],
  );
  if (sameDay.rows[0]) {
    const detail = await carryoverDetail(pool(), sameDay.rows[0].id) as Record<string, unknown> & { run?: Record<string, unknown> };
    if (detail.run) {
      detail.run = {
        ...detail.run,
        merge_note: `营业日 ${params.businessDate} 已在盘点时点 ${new Date(sameDay.rows[0].stocktake_at).toISOString()} 完成结转；` +
          `本次盘点时点 ${stamp.toISOString()} 合并到该次结转，不重复滚存（闭店后更正请走历史复盘重算未确认区间）`,
      };
    }
    return { ...detail, idempotent: true, mergedIntoStocktakeAt: sameDay.rows[0].stocktake_at };
  }

  const plan = await planCarryover(pool(), {
    storeId: params.storeId, businessDate: params.businessDate, categoryId: null,
  });
  if (!plan.ruleVersion) {
    throw new ConflictError('NO_RULE_VERSION', `营业日 ${params.businessDate} 无生效的分组规则版本`);
  }
  const targetDate = addDaysStr(params.businessDate, 1);

  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO carryover_runs
         (store_id, business_date, target_date, rule_version_id, stocktake_at, idempotency_key, status)
       VALUES ($1,$2,$3,$4,$5,$6,'applied') RETURNING id`,
      [params.storeId, params.businessDate, targetDate, plan.ruleVersion.id, stamp, params.idempotencyKey ?? null],
    );
    const runId: number = ins.rows[0].id;

    const skuAgg = new Map<number, { qty: number; cost: number; dates: Set<string> }>();
    let expiredQty = 0, clearedQty = 0, carriedQty = 0, costTotal = 0, varianceTotal = 0;
    for (const v of plan.verdicts) {
      await client.query(
        `INSERT INTO carryover_lines
           (run_id, store_id, sku_id, batch_id, business_date, target_date, rule_version_id, batch_rule_version_id,
            basis_qty, expired_qty, cleared_qty, carried_qty, unit_cost, cost_amount,
            cost_attribution, attributed_date, stocktake_at, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          runId, params.storeId, v.skuId, v.batchId, params.businessDate, targetDate, plan.ruleVersion.id,
          v.batchRuleVersionId,
          v.basisQty, v.expiredQty, v.clearedQty, v.carriedQty, v.unitCost, v.costAmount,
          v.costAttribution, v.attributedDate, stamp, v.note,
        ],
      );
      const newStatus = v.carriedQty > 0 ? 'open' : 'closed';
      const nearQty = v.carriedQty > 0
        ? computeNearQty({
            inStock: v.carriedQty, expiryDate: v.expiryDate, businessDate: params.businessDate,
            rule: groupRule(plan.ruleVersion.rules, v.categoryCode),
          })
        : 0;
      await client.query(
        'UPDATE batches SET in_stock_qty=$2, near_expiry_qty=$3, status=$4 WHERE id=$1',
        [v.batchId, v.carriedQty, nearQty, newStatus],
      );
      const entryType = v.expiredQty > 0 ? 'expiry' : v.clearedQty > 0 ? 'clearance' : 'carryover';
      await ledgerEntry(client, {
        batchId: v.batchId, businessDate: params.businessDate, entryType,
        inQty: 0, outQty: v.expiredQty + v.clearedQty,
        inStockAfter: v.carriedQty, inTransitAfter: 0, nearQtyAfter: nearQty,
        refKey: `co:${runId}:${v.batchId}`, note: v.note ?? undefined,
      });
      if (v.expiredQty > 0 || v.clearedQty > 0) {
        const qty = v.expiredQty + v.clearedQty;
        await client.query(
          `INSERT INTO inventory_adjustments
             (store_id, sku_id, batch_id, business_date, adjust_type, qty, unit_cost, amount, status, ref_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending_review',$9)
           ON CONFLICT (ref_key) DO NOTHING`,
          [
            params.storeId, v.skuId, v.batchId, params.businessDate,
            v.expiredQty > 0 ? 'expiry_writeoff' : 'clearance', -qty, v.unitCost,
            Number((qty * v.unitCost).toFixed(2)), `wo:${runId}:${v.batchId}`,
          ],
        );
      }
      expiredQty += v.expiredQty;
      clearedQty += v.clearedQty;
      carriedQty += v.carriedQty;
      costTotal += v.costAmount;
      varianceTotal += v.stocktakeVariance;
      const agg = skuAgg.get(v.skuId) ?? { qty: 0, cost: 0, dates: new Set<string>() };
      agg.qty += v.basisQty;
      agg.cost += v.costAmount;
      agg.dates.add(v.attributedDate);
      skuAgg.set(v.skuId, agg);
    }

    // 复盘口径：结转成本按 SKU 归入当日复盘（已确认复盘不追溯改写）
    for (const [skuId, agg] of skuAgg) {
      const dates = [...agg.dates];
      await client.query(
        `UPDATE review_items ri SET
           carryover_qty=$4, carryover_cost=$5, cost_attribution_date=$6
         FROM reviews r
         WHERE ri.review_id=r.id AND r.store_id=$1 AND r.arrival_date=$2 AND ri.sku_id=$3
           AND r.confirmed_at IS NULL`,
        [
          params.storeId, params.businessDate, skuId, Number(agg.qty.toFixed(4)), Number(agg.cost.toFixed(2)),
          dates.length === 1 ? dates[0] : null,
        ],
      );
    }

    const totals = {
      batches: plan.verdicts.length,
      expiredQty: Number(expiredQty.toFixed(4)),
      clearedQty: Number(clearedQty.toFixed(4)),
      carriedQty: Number(carriedQty.toFixed(4)),
      costAmount: Number(costTotal.toFixed(2)),
      stocktakeVariance: Number(varianceTotal.toFixed(4)),
      skus: skuAgg.size,
    };
    await client.query('UPDATE carryover_runs SET totals=$2 WHERE id=$1', [runId, JSON.stringify(totals)]);
    await client.query('COMMIT');
    const detail = await carryoverDetail(pool(), runId);
    return { ...detail, idempotent: false };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function carryoverDetail(db: Db, runId: number) {
  const run = await db.query(
    `SELECT r.*, v.version_no AS rule_version_no FROM carryover_runs r
       JOIN shelf_rule_versions v ON v.id=r.rule_version_id WHERE r.id=$1`,
    [runId],
  );
  const lines = await db.query(
    `SELECT cl.*, s.code AS sku_code, s.name AS sku_name, b.batch_no, b.arrival_date, b.expiry_date,
            brv.version_no AS batch_rule_version_no
       FROM carryover_lines cl
       JOIN skus s ON s.id=cl.sku_id
       JOIN batches b ON b.id=cl.batch_id
       JOIN shelf_rule_versions brv ON brv.id=cl.batch_rule_version_id
      WHERE cl.run_id=$1 ORDER BY b.expiry_date, b.id`,
    [runId],
  );
  const adjustments = await db.query(
    `SELECT a.*, s.name AS sku_name, b.batch_no
       FROM inventory_adjustments a
       JOIN skus s ON s.id=a.sku_id
       JOIN batches b ON b.id=a.batch_id
      WHERE a.store_id=(SELECT store_id FROM carryover_runs WHERE id=$1)
        AND a.business_date=(SELECT business_date FROM carryover_runs WHERE id=$1)
      ORDER BY a.id`,
    [runId],
  );
  return {
    run: run.rows[0] ?? null,
    lines: lines.rows.map((l) => ({
      ...l,
      basis_qty: Number(l.basis_qty), expired_qty: Number(l.expired_qty), cleared_qty: Number(l.cleared_qty),
      carried_qty: Number(l.carried_qty), unit_cost: Number(l.unit_cost), cost_amount: Number(l.cost_amount),
    })),
    adjustments: adjustments.rows.map((a) => ({ ...a, qty: Number(a.qty), amount: Number(a.amount), unit_cost: Number(a.unit_cost) })),
  };
}

export async function listCarryovers(params: {
  storeId: number;
  businessDate?: string | null;
}): Promise<Record<string, unknown>> {
  const runs = await pool().query(
    `SELECT r.*, v.version_no AS rule_version_no
       FROM carryover_runs r JOIN shelf_rule_versions v ON v.id=r.rule_version_id
      WHERE r.store_id=$1 AND ($2::date IS NULL OR r.business_date=$2)
      ORDER BY r.business_date DESC, r.stocktake_at DESC`,
    [params.storeId, params.businessDate ?? null],
  );
  const out = [];
  for (const run of runs.rows) {
    const lines = await pool().query(
      `SELECT cl.*, s.code AS sku_code, s.name AS sku_name, b.batch_no, b.arrival_date, b.expiry_date,
              brv.version_no AS batch_rule_version_no
         FROM carryover_lines cl
         JOIN skus s ON s.id=cl.sku_id
         JOIN batches b ON b.id=cl.batch_id
         JOIN shelf_rule_versions brv ON brv.id=cl.batch_rule_version_id
        WHERE cl.run_id=$1 ORDER BY b.expiry_date, b.id`,
      [run.id],
    );
    out.push({
      ...run,
      lines: lines.rows.map((l) => ({
        ...l,
        basis_qty: Number(l.basis_qty), expired_qty: Number(l.expired_qty), cleared_qty: Number(l.cleared_qty),
        carried_qty: Number(l.carried_qty), unit_cost: Number(l.unit_cost), cost_amount: Number(l.cost_amount),
      })),
    });
  }
  const adjustments = await pool().query(
    `SELECT a.*, s.name AS sku_name, b.batch_no FROM inventory_adjustments a
       JOIN skus s ON s.id=a.sku_id JOIN batches b ON b.id=a.batch_id
      WHERE a.store_id=$1 AND ($2::date IS NULL OR a.business_date=$2)
      ORDER BY a.business_date DESC, a.id`,
    [params.storeId, params.businessDate ?? null],
  );
  return {
    runs: out,
    adjustments: adjustments.rows.map((a) => ({ ...a, qty: Number(a.qty), amount: Number(a.amount), unit_cost: Number(a.unit_cost) })),
  };
}

/**
 * 按到货日对账：台账（登记/到货流水）↔ 结转结果 ↔ 复盘口径，逐批比对；
 * 对不上的批次单列 pending_review，交品类经理复核。
 */
export async function reconcile(params: {
  storeId: number;
  dateFrom: string;
  dateTo: string;
  categoryId?: number | null;
}): Promise<Record<string, unknown>> {
  const batches = await pool().query(
    `SELECT b.*, s.code AS sku_code, s.name AS sku_name, c.code AS category_code, c.name AS category_name
       FROM batches b JOIN skus s ON s.id=b.sku_id JOIN categories c ON c.id=s.category_id
      WHERE b.store_id=$1 AND b.arrival_date BETWEEN $2 AND $3
        AND ($4::int IS NULL OR c.id=$4)
      ORDER BY b.arrival_date, b.id`,
    [params.storeId, params.dateFrom, params.dateTo, params.categoryId ?? null],
  );
  const run = await pool().query(
    `INSERT INTO reconciliation_runs (store_id, date_from, date_to) VALUES ($1,$2,$3) RETURNING id`,
    [params.storeId, params.dateFrom, params.dateTo],
  );
  const runId: number = run.rows[0].id;
  const existing = await pool().query(
    'SELECT batch_id, flag_type FROM reconciliation_flags WHERE batch_id = ANY($1::int[])',
    [batches.rows.map((b) => b.id)],
  );
  const seen = new Set(existing.rows.map((r) => `${r.batch_id}:${r.flag_type}`));

  let flags = 0;
  for (const b of batches.rows) {
    const ledger = await pool().query(
      `SELECT COALESCE(SUM(in_qty),0) AS inq, COALESCE(SUM(out_qty),0) AS outq
         FROM batch_ledger_entries WHERE batch_id=$1`,
      [b.id],
    );
    const carry = await pool().query(
      `SELECT COALESCE(SUM(cost_amount),0) AS cost, COALESCE(SUM(basis_qty),0) AS qty, COUNT(*)::int AS n
         FROM carryover_lines WHERE batch_id=$1`,
      [b.id],
    );
    const order = await pool().query(
      `SELECT COALESCE(SUM(oi.qty),0) AS qty FROM order_items oi
         JOIN orders o ON o.id=oi.order_id
        WHERE o.store_id=$1 AND o.arrival_date=$2 AND oi.sku_id=$3`,
      [params.storeId, b.arrival_date, b.sku_id],
    );
    const pendingAdj = await pool().query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(qty),0) AS qty, COALESCE(SUM(amount),0) AS amount
         FROM inventory_adjustments WHERE batch_id=$1 AND status='pending_review'
           AND adjust_type='stocktake_variance'`,
      [b.id],
    );
    const orderQty = Number(order.rows[0].qty);
    const received = Number(b.received_qty);
    const carryCost = Number(carry.rows[0].cost);
    const carryQty = Number(carry.rows[0].qty);
    const carryCount = Number(carry.rows[0].n);

    const candidates: Array<{ type: string; variance: number; note: string }> = [];
    if (orderQty > 0 && Math.abs(received - orderQty) > 0.001) {
      candidates.push({
        type: 'ledger_order_mismatch', variance: Number((received - orderQty).toFixed(4)),
        note: `批次到货 ${received} 与订单确认量 ${orderQty} 不一致`,
      });
    }
    if (carryCost - received * Number(b.unit_cost) > 0.01) {
      candidates.push({
        type: 'cost_exceeds_ledger', variance: Number((carryCost - received * Number(b.unit_cost)).toFixed(2)),
        note: `结转成本 ${carryCost.toFixed(2)} 超出到货成本 ${(received * Number(b.unit_cost)).toFixed(2)}`,
      });
    }
    if (isExpired(b.expiry_date, todayStr()) && Number(b.in_stock_qty) > 0 && carryCount === 0) {
      candidates.push({
        type: 'stale_expired_stock', variance: Number(b.in_stock_qty),
        note: `批次 ${b.expiry_date} 已到期但仍有在库 ${Number(b.in_stock_qty)}，未结转/未报废`,
      });
    }
    if (pendingAdj.rows[0].n > 0) {
      candidates.push({
        type: 'stocktake_variance_pending', variance: Number(pendingAdj.rows[0].qty),
        note: `盘点差异 ${pendingAdj.rows[0].n} 笔、金额 ${Number(pendingAdj.rows[0].amount).toFixed(2)} 待复核，账面与实物不符以盘点为准`,
      });
    }
    for (const c of candidates) {
      const key = `${b.id}:${c.type}`;
      if (seen.has(key)) continue;
      await pool().query(
        `INSERT INTO reconciliation_flags
           (run_id, store_id, sku_id, arrival_date, batch_id, flag_type, ledger_qty, carryover_total, review_qty, variance, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (batch_id, flag_type) DO NOTHING`,
        [
          runId, params.storeId, b.sku_id, b.arrival_date, b.id, c.type,
          received, carryCost, carryQty, c.variance, c.note,
        ],
      );
      flags += 1;
    }
  }

  const summary = {
    batches: batches.rows.length,
    newFlags: flags,
    categories: [...new Set(batches.rows.map((b) => b.category_code))],
    grain: 'arrival_date',
  };
  await pool().query('UPDATE reconciliation_runs SET summary=$2 WHERE id=$1', [runId, JSON.stringify(summary)]);
  const flagRows = await pool().query(
    `SELECT f.*, s.name AS sku_name, s.code AS sku_code, b.batch_no
       FROM reconciliation_flags f JOIN skus s ON s.id=f.sku_id JOIN batches b ON b.id=f.batch_id
      WHERE f.batch_id = ANY($1::int[]) ORDER BY f.arrival_date, f.id`,
    [batches.rows.map((b) => b.id)],
  );
  return { runId, summary, flags: flagRows.rows };
}

export async function listReconciliation(params: {
  storeId: number;
  dateFrom?: string | null;
  dateTo?: string | null;
}): Promise<Record<string, unknown>> {
  const flags = await pool().query(
    `SELECT f.*, s.name AS sku_name, s.code AS sku_code, b.batch_no, b.expiry_date
       FROM reconciliation_flags f
       JOIN skus s ON s.id=f.sku_id JOIN batches b ON b.id=f.batch_id
      WHERE f.store_id=$1 AND ($2::date IS NULL OR f.arrival_date >= $2)
        AND ($3::date IS NULL OR f.arrival_date <= $3)
      ORDER BY f.arrival_date DESC, f.id`,
    [params.storeId, params.dateFrom ?? null, params.dateTo ?? null],
  );
  return {
    flags: flags.rows.map((f) => ({
      ...f,
      ledger_qty: Number(f.ledger_qty), carryover_total: Number(f.carryover_total),
      review_qty: Number(f.review_qty), variance: Number(f.variance),
    })),
  };
}

export async function resolveReconciliationFlag(params: {
  storeId: number;
  flagId: number;
  note: string;
  resolvedBy: string;
}): Promise<{ id: number; status: string }> {
  const r = await pool().query(
    `UPDATE reconciliation_flags SET status='resolved', note=$3, resolved_by=$4, resolved_at=now()
      WHERE id=$1 AND store_id=$2 RETURNING id, status`,
    [params.flagId, params.storeId, params.note, params.resolvedBy],
  );
  if (!r.rows[0]) throw new NotFoundError('对账差异单不存在');
  return r.rows[0];
}

/**
 * 供历史重算使用：某营业日的结转明细**按批次登记时的规则版本**重算成本归属。
 * 规则改版后历史毛利口径会分叉：同期区间可能同时出现 v1（原到货日）与 v2（结转日）归属。
 */
export async function carryoverSnapshotForDate(params: {
  storeId: number;
  businessDate: string;
  categoryId?: number | null;
}): Promise<{
  ruleVersion: (RuleVersionRow & { usedBatchVersions?: number[] }) | null;
  lines: Array<{
    batchId: number; skuId: number; batchNo: string; arrivalDate: string; expiryDate: string;
    unitCost: number; basisQty: number; costAmount: number; attributedDate: string;
    costAttribution: string; stocktakeVariance: number; note: string | null;
    batchRuleVersionNo: number;
  }>;
}> {
  const runs = await pool().query(
    `SELECT cl.*, b.batch_no, b.arrival_date, b.expiry_date, b.unit_cost, c.code AS category_code,
            brv.version_no AS batch_rule_version_no,
            drv.version_no AS day_rule_version_no, drv.rules AS day_rules,
            c.name AS category_name
       FROM carryover_lines cl
       JOIN batches b ON b.id=cl.batch_id
       JOIN skus s ON s.id=cl.sku_id
       JOIN categories c ON c.id=s.category_id
       JOIN shelf_rule_versions brv ON brv.id=cl.batch_rule_version_id
       JOIN shelf_rule_versions drv ON drv.id=cl.rule_version_id
       JOIN carryover_runs cr ON cr.id=cl.run_id
      WHERE cr.store_id=$1 AND cr.business_date=$2
        AND ($3::int IS NULL OR c.id=$3)
      ORDER BY cl.id`,
    [params.storeId, params.businessDate, params.categoryId ?? null],
  );
  const lines = [];
  const usedVersions = new Set<number>();
  for (const l of runs.rows) {
    // 重算口径：该营业日生效版本（当时版本），而非批次登记版本
    const dayRule = groupRule(parseRules(l.day_rules), l.category_code);
    usedVersions.add(Number(l.day_rule_version_no));
    const st = await pool().query(
      `SELECT actual_qty FROM batch_stocktakes WHERE batch_id=$1 AND business_date=$2
        ORDER BY stocktake_at DESC LIMIT 1`,
      [l.batch_id, params.businessDate],
    );
    const verdict = judgeCarryover(
      {
        batchId: l.batch_id, skuId: l.sku_id, batchNo: l.batch_no,
        arrivalDate: l.arrival_date, expiryDate: l.expiry_date,
        unitCost: Number(l.unit_cost), bookQty: Number(l.basis_qty),
        actualQty: st.rows[0] ? Number(st.rows[0].actual_qty) : null,
      },
      params.businessDate,
      dayRule,
    );
    lines.push({
      batchId: l.batch_id, skuId: l.sku_id, batchNo: l.batch_no,
      arrivalDate: l.arrival_date, expiryDate: l.expiry_date,
      unitCost: Number(l.unit_cost), basisQty: verdict.basisQty, costAmount: verdict.costAmount,
      attributedDate: verdict.attributedDate, costAttribution: verdict.costAttribution,
      stocktakeVariance: verdict.stocktakeVariance, note: verdict.note,
      batchRuleVersionNo: Number(l.day_rule_version_no),
    });
  }
  const dayVersion = await ruleVersionOn(pool(), params.businessDate);
  // 审计口径：当日生效版本 + 明细实际用到的规则版本
  const effective = dayVersion
    ? { ...dayVersion, usedBatchVersions: [...usedVersions].sort((a, b) => a - b) }
    : null;
  return { ruleVersion: effective, lines };
}
