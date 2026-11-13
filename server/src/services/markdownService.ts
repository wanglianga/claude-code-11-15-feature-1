import { pool } from '../db';
import { wasteWindowDeadline } from '../lib/dates';
import { groupRule, parseRules, splitMarkdownDemand } from '../lib/shelf';
import { ruleVersionOn } from './shelfService';
import { ConflictError, NotFoundError } from './suggestionService';

const WINDOW_HOUR = 12;

async function ruleForBatch(batchId: number) {
  const r = await pool().query(
    `SELECT b.*, c.code AS category_code FROM batches b
       JOIN skus s ON s.id=b.sku_id JOIN categories c ON c.id=s.category_id
      WHERE b.id=$1`,
    [batchId],
  );
  const batch = r.rows[0];
  if (!batch) throw new NotFoundError('批次不存在');
  const rv = await pool().query('SELECT * FROM shelf_rule_versions WHERE id=$1', [batch.rule_version_id]);
  const rule = groupRule(parseRules(rv.rows[0]?.rules), batch.category_code);
  return { batch, rule, ruleVersionId: Number(batch.rule_version_id) };
}

/**
 * 建临期折价计划：只允许临期/当日到期批次；计划量与折扣由分组规则版本约束。
 * 幂等键重复提交返回原计划，不重复建。
 */
export async function createMarkdownPlan(params: {
  storeId: number;
  skuId: number;
  batchId: number;
  businessDate: string;
  planQty: number;
  discountRate?: number;
  idempotencyKey: string;
  createdBy: string;
}): Promise<{ planId: number; idempotent: boolean; discountRate: number; ruleVersionNo: number }> {
  const dup = await pool().query('SELECT * FROM markdown_plans WHERE idempotency_key=$1', [params.idempotencyKey]);
  if (dup.rows[0]) {
    const rv = await pool().query('SELECT version_no FROM shelf_rule_versions WHERE id=$1', [dup.rows[0].rule_version_id]);
    return {
      planId: dup.rows[0].id, idempotent: true,
      discountRate: Number(dup.rows[0].discount_rate), ruleVersionNo: Number(rv.rows[0]?.version_no ?? 0),
    };
  }
  const { batch, rule, ruleVersionId } = await ruleForBatch(params.batchId);
  if (Number(batch.store_id) !== params.storeId || Number(batch.sku_id) !== params.skuId) {
    throw new ConflictError('BATCH_MISMATCH', '批次与门店/SKU 不匹配');
  }
  if (Number(batch.in_stock_qty) <= 0) throw new ConflictError('NO_STOCK', '批次无在库库存，无法建折价计划');
  const discountRate = params.discountRate ?? rule.markdownDiscount;
  if (!(discountRate > 0 && discountRate <= 1)) throw new ConflictError('BAD_REQUEST', '折扣必须在 (0,1]');
  if (!(params.planQty > 0)) throw new ConflictError('BAD_REQUEST', '折价计划量必须大于 0');
  if (params.planQty > Number(batch.in_stock_qty)) {
    throw new ConflictError('BAD_REQUEST', `折价计划量 ${params.planQty} 超过批次在库 ${Number(batch.in_stock_qty)}`);
  }
  const rv = await pool().query('SELECT version_no FROM shelf_rule_versions WHERE id=$1', [ruleVersionId]);
  const ins = await pool().query(
    `INSERT INTO markdown_plans
       (store_id, sku_id, batch_id, business_date, rule_version_id, plan_qty, discount_rate, idempotency_key, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      params.storeId, params.skuId, params.batchId, params.businessDate, ruleVersionId,
      params.planQty, discountRate, params.idempotencyKey, params.createdBy,
    ],
  );
  return {
    planId: ins.rows[0].id, idempotent: false, discountRate,
    ruleVersionNo: Number(rv.rows[0]?.version_no ?? 0),
  };
}

/**
 * 折价单（可跨日补录）：
 * - 窗口内（营业日次日 12:00 前）→ 重算折价需求；
 * - 过窗 → 注明来源另行归档，已锁定的建议量不动；
 * - 折价回升销量 = 实销 - 基准量，按规则版本的比例拆成“真实需求”和“折价需求”；
 *   折价需求写 markdown_demand，并在需求样本上打 demand_class='markdown_demand'，回喂模型时被过滤。
 */
export async function recordMarkdownEntry(params: {
  planId: number;
  soldQty: number;
  recordedAt?: Date;
  entryKey?: string;
}): Promise<{ entryId: number; withinWindow: boolean; disposition: string; upliftQty: number; markdownDemandQty: number }> {
  const recordedAt = params.recordedAt ?? new Date();
  const pr = await pool().query(
    `SELECT p.*, b.batch_no, b.expiry_date, c.code AS category_code
       FROM markdown_plans p
       JOIN batches b ON b.id=p.batch_id
       JOIN skus s ON s.id=p.sku_id
       JOIN categories c ON c.id=s.category_id
      WHERE p.id=$1`,
    [params.planId],
  );
  const plan = pr.rows[0];
  if (!plan) throw new NotFoundError('折价计划不存在');
  const rv = await pool().query('SELECT rules, version_no FROM shelf_rule_versions WHERE id=$1', [plan.rule_version_id]);
  const rule = groupRule(parseRules(rv.rows[0]?.rules), plan.category_code);

  const deadline = wasteWindowDeadline(plan.business_date, WINDOW_HOUR);
  const withinWindow = recordedAt < deadline;
  const disposition = withinWindow ? 'recalc' : 'archived';
  const entryKey = params.entryKey ?? `md:${params.planId}:${recordedAt.toISOString()}`;
  const split = splitMarkdownDemand({
    plannedQty: Number(plan.plan_qty),
    soldQty: params.soldQty,
    discountRate: Number(plan.discount_rate),
    upliftRealShare: rule.markdownUpliftRealShare,
  });
  const note = withinWindow
    ? `窗口内补录，触发折价需求重算；折价回升 ${split.upliftQty}，其中折价需求 ${split.markdownDemandQty}`
    : `过窗补录（窗口截止 ${plan.business_date} 次日 ${WINDOW_HOUR}:00），来源：补录 ${recordedAt.toISOString()}，另行归档；已锁定建议量不动`;

  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO markdown_entries
         (plan_id, store_id, sku_id, business_date, sold_qty, recorded_at, within_window, disposition, note, entry_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (entry_key) DO NOTHING RETURNING id`,
      [params.planId, plan.store_id, plan.sku_id, plan.business_date, params.soldQty, recordedAt, withinWindow, disposition, note, entryKey],
    );
    const created = !!ins.rows[0];
    const entryIdFinal: number =
      ins.rows[0]?.id ??
      (await client.query('SELECT id FROM markdown_entries WHERE entry_key=$1', [entryKey])).rows[0]?.id;

    let markdownDemandQty = 0;
    if (withinWindow) {
      // 同一计划的折价需求按累计实销重算（不重复叠加）
      const sold = await client.query(
        'SELECT COALESCE(SUM(sold_qty),0) AS q FROM markdown_entries WHERE plan_id=$1 AND within_window=TRUE',
        [params.planId],
      );
      const totalSold = Number(sold.rows[0].q);
      // 折价实销从批次在库扣减（仅新录入的这张折价单；重复上报不重复扣减）
      if (created) {
        const slab = await client.query('SELECT in_stock_qty FROM batches WHERE id=$1 FOR UPDATE', [plan.batch_id]);
        const before = Number(slab.rows[0]?.in_stock_qty ?? 0);
        const after = Math.max(0, before - params.soldQty);
        await client.query('UPDATE batches SET in_stock_qty=$2 WHERE id=$1', [plan.batch_id, after]);
        await client.query(
          `INSERT INTO batch_ledger_entries
             (batch_id, business_date, entry_type, in_qty, out_qty, in_stock_after, in_transit_after, near_expiry_after, ref_key, note)
           VALUES ($1,$2,'markdown_sale',0,$3,$4,0,$4,$5,$6)
           ON CONFLICT (ref_key) DO NOTHING`,
          [
            plan.batch_id, plan.business_date, params.soldQty, after,
            `md-ledger:${params.planId}:${entryIdFinal}`, '临期折价实销出库',
          ],
        );
      }
      const resplit = splitMarkdownDemand({
        plannedQty: Number(plan.plan_qty), soldQty: totalSold,
        discountRate: Number(plan.discount_rate), upliftRealShare: rule.markdownUpliftRealShare,
      });
      markdownDemandQty = resplit.markdownDemandQty;
      await client.query(
        `INSERT INTO markdown_demand
           (plan_id, store_id, sku_id, business_date, rule_version_id, planned_qty, discount_rate,
            sold_qty, uplift_qty, base_qty, markdown_demand_qty, real_demand_qty, within_window, disposition)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,TRUE,'recalc')
         ON CONFLICT (plan_id) DO UPDATE SET
           sold_qty=EXCLUDED.sold_qty, uplift_qty=EXCLUDED.uplift_qty, base_qty=EXCLUDED.base_qty,
           markdown_demand_qty=EXCLUDED.markdown_demand_qty, real_demand_qty=EXCLUDED.real_demand_qty,
           recorded_at=now()`,
        [
          params.planId, plan.store_id, plan.sku_id, plan.business_date, plan.rule_version_id,
          Number(plan.plan_qty), Number(plan.discount_rate), totalSold,
          resplit.upliftQty, resplit.baseQty, resplit.markdownDemandQty, resplit.realDemandQty,
        ],
      );

      // 当日需求样本：拆真实需求/折价需求，折价需求不回喂模型
      const base = await client.query(
        'SELECT * FROM demand_samples WHERE store_id=$1 AND sku_id=$2 AND business_date=$3',
        [plan.store_id, plan.sku_id, plan.business_date],
      );
      if (base.rows[0]) {
        const excludeUplift = resplit.markdownDemandQty > 0;
        await client.query(
          `UPDATE demand_samples SET
             demand_class=$2, markdown_uplift_qty=$3,
             excluded_from_training = CASE WHEN $4 THEN TRUE ELSE excluded_from_training END,
             exclude_reason = CASE WHEN $4 THEN '折价需求单列，不进入训练样本' ELSE exclude_reason END
           WHERE id=$1`,
          [
            base.rows[0].id,
            excludeUplift ? 'markdown_demand' : 'regular', resplit.markdownDemandQty, excludeUplift,
          ],
        );
      }
    }
    await client.query('COMMIT');
    return {
      entryId: entryIdFinal, withinWindow, disposition,
      upliftQty: split.upliftQty, markdownDemandQty,
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** 折价治理页：折价计划、折价需求与真实需求分列 */
export async function listMarkdown(params: {
  storeId: number;
  businessDate?: string | null;
  categoryId?: number | null;
}): Promise<Record<string, unknown>> {
  const plans = await pool().query(
    `SELECT p.*, s.code AS sku_code, s.name AS sku_name, s.unit, b.batch_no, b.expiry_date, b.arrival_date,
            c.id AS category_id, c.code AS category_code, c.name AS category_name,
            rv.version_no AS rule_version_no,
            md.uplift_qty, md.markdown_demand_qty, md.sold_qty, md.base_qty, rv2.version_no AS md_rule_version_no
       FROM markdown_plans p
       JOIN skus s ON s.id=p.sku_id
       JOIN categories c ON c.id=s.category_id
       JOIN batches b ON b.id=p.batch_id
       JOIN shelf_rule_versions rv ON rv.id=p.rule_version_id
       LEFT JOIN (
         SELECT md.plan_id, SUM(md.uplift_qty) AS uplift_qty,
                SUM(md.markdown_demand_qty) AS markdown_demand_qty,
                MAX(md.sold_qty) AS sold_qty, MAX(md.base_qty) AS base_qty, MAX(md.rule_version_id) AS rule_version_id
           FROM markdown_demand md
          GROUP BY md.plan_id
       ) md ON md.plan_id=p.id
       LEFT JOIN shelf_rule_versions rv2 ON rv2.id=md.rule_version_id
      WHERE p.store_id=$1 AND ($2::date IS NULL OR p.business_date=$2)
        AND ($3::int IS NULL OR c.id=$3)
      ORDER BY p.business_date DESC, p.id DESC`,
    [params.storeId, params.businessDate ?? null, params.categoryId ?? null],
  );
  const entries = await pool().query(
    `SELECT e.*, s.name AS sku_name, b.batch_no FROM markdown_entries e
       JOIN markdown_plans p ON p.id=e.plan_id
       JOIN skus s ON s.id=e.sku_id
       JOIN batches b ON b.id=p.batch_id
      WHERE e.store_id=$1 AND ($2::date IS NULL OR e.business_date=$2)
      ORDER BY e.recorded_at DESC`,
    [params.storeId, params.businessDate ?? null],
  );
  const rows = plans.rows.map((p) => ({
    ...p,
    plan_qty: Number(p.plan_qty), discount_rate: Number(p.discount_rate),
    uplift_qty: p.uplift_qty === null ? 0 : Number(p.uplift_qty),
    markdown_demand_qty: p.markdown_demand_qty === null ? 0 : Number(p.markdown_demand_qty),
    sold_qty: p.sold_qty === null ? 0 : Number(p.sold_qty),
    base_qty: p.base_qty === null ? 0 : Number(p.base_qty),
    markdown_share: p.sold_qty && Number(p.sold_qty) > 0 ? Number(p.markdown_demand_qty) / Number(p.sold_qty) : 0,
  }));
  const summary = {
    plans: rows.length,
    plannedQty: round(rows.reduce((a, r) => a + r.plan_qty, 0)),
    soldQty: round(rows.reduce((a, r) => a + r.sold_qty, 0)),
    upliftQty: round(rows.reduce((a, r) => a + r.uplift_qty, 0)),
    markdownDemandQty: round(rows.reduce((a, r) => a + r.markdown_demand_qty, 0)),
  };
  return {
    plans: rows,
    entries: entries.rows.map((e) => ({ ...e, sold_qty: Number(e.sold_qty) })),
    summary,
    policy: {
      label: '折价需求',
      note: '折价回升销量单列为折价需求，不当成真实需求回喂模型；当日样本剔除训练',
    },
  };
}

function round(n: number): number {
  return Number(n.toFixed(4));
}

/** 供历史复盘重算：某营业日各折价计划按当时规则版本拆分的折价需求 */
export async function markdownSnapshotForDate(params: {
  storeId: number;
  businessDate: string;
  categoryId?: number | null;
}): Promise<{
  ruleVersion: { id: number; version_no: number } | null;
  lines: Array<{
    planId: number; skuId: number; soldQty: number; upliftQty: number;
    markdownDemandQty: number; realDemandQty: number; disposition: string;
  }>;
}> {
  const version = await ruleVersionOn(pool(), params.businessDate);
  const plans = await pool().query(
    `SELECT p.*, c.id AS category_id, c.code AS category_code,
            COALESCE(md.sold_qty, 0) AS md_sold
       FROM markdown_plans p
       JOIN skus s ON s.id=p.sku_id JOIN categories c ON c.id=s.category_id
       LEFT JOIN markdown_demand md ON md.plan_id=p.id
      WHERE p.store_id=$1 AND p.business_date=$2
        AND ($3::int IS NULL OR c.id=$3)
      ORDER BY p.id`,
    [params.storeId, params.businessDate, params.categoryId ?? null],
  );
  const lines = [];
  for (const p of plans.rows) {
    const activeVersion = version
      ? groupRule(parseRules(version.rules), p.category_code)
      : groupRule(parseRules({}), p.category_code);
    const split = splitMarkdownDemand({
      plannedQty: Number(p.plan_qty),
      soldQty: Number(p.md_sold),
      discountRate: Number(p.discount_rate),
      upliftRealShare: activeVersion.markdownUpliftRealShare,
    });
    lines.push({
      planId: p.id, skuId: p.sku_id, soldQty: Number(p.md_sold),
      upliftQty: split.upliftQty, markdownDemandQty: split.markdownDemandQty,
      realDemandQty: split.realDemandQty,
      disposition: split.markdownDemandQty > 0 ? 'markdown_recomputed' : 'markdown_unchanged',
    });
  }
  return {
    ruleVersion: version ? { id: version.id, version_no: version.version_no } : null,
    lines,
  };
}
