import { pool } from '../db';
import { addDaysStr, diffDays } from '../lib/shelf';
import { markdownSnapshotForDate } from './markdownService';
import { carryoverSnapshotForDate } from './shelfService';
import { ConflictError } from './suggestionService';

const MAX_REPLAY_DAYS = 120;

/**
 * 历史复盘重算（按“当时生效的分组规则版本”）：
 * - 规则版本按区间内每个营业日独立解析（effective_from/effective_to），规则一改历史毛利口径就分叉；
 * - 只重算未确认区间：已确认复盘 confirmed_at 非空 → 不追溯改写，只在明细里标 skipped_confirmed；
 * - 结转量是既成事实，重算的是**成本归属与折价需求拆分**（规则版本决定）；
 * - 不新建 review_items，不触碰建议版本与已锁定建议量。
 */
export async function replayHistory(params: {
  storeId: number;
  dateFrom: string;
  dateTo: string;
  categoryId?: number | null;
  createdBy: string;
}): Promise<Record<string, unknown>> {
  const span = diffDays(params.dateFrom, params.dateTo);
  if (span < 0) throw new ConflictError('BAD_REQUEST', '起始日不能晚于结束日');
  if (span > MAX_REPLAY_DAYS) throw new ConflictError('BAD_REQUEST', `重算区间最多 ${MAX_REPLAY_DAYS} 天`);

  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const run = await client.query(
      `INSERT INTO replay_runs (store_id, category_id, date_from, date_to, mode, created_by)
       VALUES ($1,$2,$3,$4,'unconfirmed_only',$5) RETURNING id`,
      [params.storeId, params.categoryId ?? null, params.dateFrom, params.dateTo, params.createdBy],
    );
    const runId: number = run.rows[0].id;

    const agg = {
      days: 0, recomputed: 0, unchanged: 0, skippedConfirmed: 0,
      markdownRecomputed: 0, markdownUnchanged: 0,
      costDelta: 0, ruleVersions: new Set<number>(),
    };

    for (let d = params.dateFrom; diffDays(d, params.dateTo) >= 0; d = addDaysStr(d, 1)) {
      agg.days += 1;
      const snap = await carryoverSnapshotForDate({
        storeId: params.storeId, businessDate: d, categoryId: params.categoryId,
      });
      for (const v of snap.ruleVersion?.usedBatchVersions ?? []) agg.ruleVersions.add(v);

      // 按 SKU 汇总重算后的结转成本与归属日
      const bySku = new Map<number, { cost: number; dates: Set<string> }>();
      for (const l of snap.lines) {
        const acc = bySku.get(l.skuId) ?? { cost: 0, dates: new Set<string>() };
        acc.cost += l.costAmount;
        acc.dates.add(l.attributedDate);
        bySku.set(l.skuId, acc);
      }

      const reviews = await client.query(
        `SELECT * FROM reviews WHERE store_id=$1 AND arrival_date=$2
           AND ($3::int IS NULL OR EXISTS (
             SELECT 1 FROM review_items ri JOIN skus s ON s.id=ri.sku_id
              WHERE ri.review_id=reviews.id AND s.category_id=$3))`,
        [params.storeId, d, params.categoryId ?? null],
      );

      for (const review of reviews.rows) {
        const confirmed = !!review.confirmed_at;
        const itemRows = await client.query(
          `SELECT ri.*, s.category_id FROM review_items ri JOIN skus s ON s.id=ri.sku_id
            WHERE ri.review_id=$1 AND ($2::int IS NULL OR s.category_id=$2)`,
          [review.id, params.categoryId ?? null],
        );
        for (const item of itemRows.rows) {
          const next = bySku.get(item.sku_id);          if (confirmed) {
            agg.skippedConfirmed += 1;
            await insertLine(client, {
              runId, storeId: params.storeId, skuId: item.sku_id, businessDate: d, reviewId: review.id,
              reviewConfirmed: true, ruleVersion: snap.ruleVersion,
              action: 'skipped_confirmed', oldCost: Number(item.carryover_cost ?? 0), newCost: Number(item.carryover_cost ?? 0),
              note: '复盘已确认，不追溯改写',
            });
            continue;
          }
          const oldCost = Number(item.carryover_cost ?? 0);
          const newCost = next ? Number(next.cost.toFixed(2)) : 0;
          const delta = Number((newCost - oldCost).toFixed(2));
          const oldAttr = item.cost_attribution_date ?? null;
          const newAttr = next && next.dates.size === 1 ? [...next.dates][0] : null;
          const attrChanged = (oldAttr ?? null) !== (newAttr ?? null) && newAttr !== null;
          const action = delta === 0 && !attrChanged ? 'unchanged' : 'recomputed';
          if (action === 'unchanged') agg.unchanged += 1; else agg.recomputed += 1;
          agg.costDelta += delta;
          await client.query(
            `UPDATE review_items SET carryover_cost=$2, cost_attribution_date=$3, replay_run_id=$4
              WHERE id=$1`,
            [item.id, newCost, newAttr ?? oldAttr, runId],
          );
          await insertLine(client, {
            runId, storeId: params.storeId, skuId: item.sku_id, businessDate: d, reviewId: review.id,
            reviewConfirmed: false, ruleVersion: snap.ruleVersion, action,
            oldCost, newCost, note: attrChanged
              ? `按规则版本 v${snap.ruleVersion?.version_no ?? '-'} 重算：成本归属日 ${oldAttr ?? '-'} → ${newAttr ?? '-'}`
              : `按规则版本 v${snap.ruleVersion?.version_no ?? '-'} 重算成本归属`,
            oldAttributionDate: oldAttr, newAttributionDate: newAttr,
          });
        }
      }

      // 折价需求拆分同样按当时规则版本重算
      const md = await markdownSnapshotForDate({
        storeId: params.storeId, businessDate: d, categoryId: params.categoryId,
      });
      for (const l of md.lines) {
        const before = await client.query(
          'SELECT markdown_demand_qty FROM markdown_demand WHERE plan_id=$1',
          [l.planId],
        );
        if (!before.rows[0]) continue;
        const oldQty = Number(before.rows[0].markdown_demand_qty);
        const delta = Number((l.markdownDemandQty - oldQty).toFixed(4));
        const reviewConfirmed = await client.query(
          `SELECT r.confirmed_at FROM reviews r WHERE r.store_id=$1 AND r.arrival_date=$2
            AND EXISTS (SELECT 1 FROM review_items ri WHERE ri.review_id=r.id AND ri.sku_id=$3)`,
          [params.storeId, d, l.skuId],
        );
        const confirmed = !!reviewConfirmed.rows[0]?.confirmed_at;
        if (!confirmed && delta !== 0) {
          await client.query(
            'UPDATE markdown_demand SET markdown_demand_qty=$2, real_demand_qty=$3, replay_run_id=$4 WHERE plan_id=$1',
            [l.planId, l.markdownDemandQty, l.realDemandQty, runId],
          );
          agg.markdownRecomputed += 1;
        } else {
          agg.markdownUnchanged += 1;
        }
        await insertLine(client, {
          runId, storeId: params.storeId, skuId: l.skuId, businessDate: d, reviewId: null,
          reviewConfirmed: confirmed, ruleVersion: md.ruleVersion,
          action: confirmed
            ? 'skipped_confirmed'
            : delta !== 0 ? 'markdown_recomputed' : 'markdown_unchanged',
          oldCost: oldQty, newCost: l.markdownDemandQty,
          note: '折价需求按当时规则版本的 uplift 系数拆分；折价需求不进入训练样本',
        });
      }
    }

    const summary = {
      days: agg.days,
      recomputed: agg.recomputed,
      unchanged: agg.unchanged,
      skippedConfirmed: agg.skippedConfirmed,
      markdownRecomputed: agg.markdownRecomputed,
      markdownUnchanged: agg.markdownUnchanged,
      costDelta: Number(agg.costDelta.toFixed(2)),
      ruleVersions: [...agg.ruleVersions].sort((a, b) => a - b),
      grain: 'arrival_date',
      note: '只重算未确认区间；已确认订单不追溯改写',
    };
    await client.query('UPDATE replay_runs SET summary=$2 WHERE id=$1', [runId, JSON.stringify(summary)]);
    await client.query('COMMIT');
    const detail = await replayDetail(pool(), runId);
    return { ...detail, summary };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function insertLine(client: { query: Function }, p: {
  runId: number; storeId: number; skuId: number; businessDate: string; reviewId: number | null;
  reviewConfirmed: boolean;
  ruleVersion: { id: number; version_no: number } | null;
  action: string; oldCost: number | null; newCost: number | null; note: string;
  oldAttributionDate?: string | null; newAttributionDate?: string | null;
}): Promise<void> {
  await client.query(
    `INSERT INTO replay_lines
       (run_id, store_id, sku_id, business_date, review_id, review_confirmed, rule_version_id, rule_version_no,
        action, old_cost, new_cost, old_attribution_date, new_attribution_date, delta, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      p.runId, p.storeId, p.skuId, p.businessDate, p.reviewId, p.reviewConfirmed,
      p.ruleVersion?.id ?? null, p.ruleVersion?.version_no ?? null,
      p.action, p.oldCost, p.newCost,
      p.oldAttributionDate ?? null, p.newAttributionDate ?? null,
      p.oldCost === null || p.newCost === null ? null : Number((p.newCost - p.oldCost).toFixed(4)),
      p.note,
    ],
  );
}

async function replayDetail(db: { query: Function }, runId: number) {
  const run = await db.query(
    `SELECT r.*, c.code AS category_code, c.name AS category_name
       FROM replay_runs r LEFT JOIN categories c ON c.id=r.category_id WHERE r.id=$1`,
    [runId],
  );
  const lines = await db.query(
    `SELECT rl.*, s.code AS sku_code, s.name AS sku_name
       FROM replay_lines rl JOIN skus s ON s.id=rl.sku_id
      WHERE rl.run_id=$1 ORDER BY rl.business_date, rl.sku_id`,
    [runId],
  );
  return {
    run: run.rows[0] ?? null,
    lines: lines.rows.map((l: Record<string, unknown>) => ({
      ...l,
      old_cost: l.old_cost === null ? null : Number(l.old_cost),
      new_cost: l.new_cost === null ? null : Number(l.new_cost),
      delta: l.delta === null ? null : Number(l.delta),
    })),
  };
}

export async function listReplays(params: { storeId: number }): Promise<Record<string, unknown>> {
  const runs = await pool().query(
    `SELECT r.*, c.code AS category_code, c.name AS category_name
       FROM replay_runs r LEFT JOIN categories c ON c.id=r.category_id
      WHERE r.store_id=$1 ORDER BY r.created_at DESC LIMIT 20`,
    [params.storeId],
  );
  return { runs: runs.rows };
}

export async function getReplay(storeId: number, runId: number): Promise<Record<string, unknown>> {
  const r = await pool().query('SELECT store_id FROM replay_runs WHERE id=$1', [runId]);
  if (!r.rows[0] || Number(r.rows[0].store_id) !== storeId) {
    throw new ConflictError('FORBIDDEN', '无权查看该重算记录');
  }
  return replayDetail(pool(), runId);
}

/** 确认复盘：确认后不参与重算、不追溯改写 */
export async function confirmReview(params: {
  storeId: number;
  reviewId: number;
  confirmedBy: string;
}): Promise<{ reviewId: number; confirmedAt: string; idempotent: boolean }> {
  const r = await pool().query('SELECT * FROM reviews WHERE id=$1', [params.reviewId]);
  const review = r.rows[0];
  if (!review) throw new ConflictError('NOT_FOUND', '复盘不存在');
  if (Number(review.store_id) !== params.storeId) throw new ConflictError('FORBIDDEN', '无权操作该复盘');
  if (review.confirmed_at) {
    return { reviewId: review.id, confirmedAt: new Date(review.confirmed_at).toISOString(), idempotent: true };
  }
  const u = await pool().query(
    `UPDATE reviews SET confirmed_at=now(), confirmed_by=$2, status='closed' WHERE id=$1
     RETURNING confirmed_at`,
    [params.reviewId, params.confirmedBy],
  );
  return { reviewId: review.id, confirmedAt: new Date(u.rows[0].confirmed_at).toISOString(), idempotent: false };
}
