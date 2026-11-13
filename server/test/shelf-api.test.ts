import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import type { Express } from 'express';

/**
 * 子系统集成测试（独立测试库 ccdev_shelf_test）：覆盖
 * 批次台账按保质期分组 / 结转幂等与成本归属 / 批次盘点幂等合并 / 折价需求单列 /
 * 按当时规则版本重算未确认区间（已确认不追溯）/ 按到货日对账。
 */

const ADMIN_URL = 'postgres://ccdev:ccdev@127.0.0.1:5432/ccdev';
process.env.DATABASE_URL = 'postgres://ccdev:ccdev@127.0.0.1:5432/ccdev_shelf_test';

let app: Express;
let db: typeof import('../src/db');
let hq = '';
let store1Token = '';
let store2Token = '';
let store1 = 0;
let skuLeafy = 0;
let skuMeat = 0;
let skuRoot = 0;
let day = '';

function auth(t: string) { return { Authorization: `Bearer ${t}` }; }

const ruleShape = (attribution: 'origin_arrival' | 'carryover_date', upliftShare: number) => ({
  defaults: { costAttribution: attribution },
  groups: {
    LEAFY: { shelfLifeDays: 1, carryoverAllowed: false, nearExpiryDays: 0, costAttribution: attribution, markdownDiscount: 0.6, markdownUpliftRealShare: upliftShare, clearOnExpiry: true },
    ROOT: { shelfLifeDays: 7, carryoverAllowed: true, nearExpiryDays: 2, costAttribution: attribution, markdownDiscount: 0.75, markdownUpliftRealShare: upliftShare, clearOnExpiry: true },
    MEAT: { shelfLifeDays: 3, carryoverAllowed: true, nearExpiryDays: 1, costAttribution: attribution, markdownDiscount: 0.7, markdownUpliftRealShare: upliftShare, clearOnExpiry: true },
  },
});

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  await admin.query('DROP DATABASE IF EXISTS ccdev_shelf_test WITH (FORCE)');
  await admin.query('CREATE DATABASE ccdev_shelf_test');
  await admin.end();

  db = await import('../src/db');
  await db.migrate();
  const pool = db.pool();

  const s = await pool.query(
    `INSERT INTO stores (code, name) VALUES ('S01','一号店'),('S02','二号店') RETURNING id`,
  );
  store1 = s.rows[0].id;
  await pool.query(
    `INSERT INTO categories (code, name, default_cu, default_co, shelf_group, shelf_life_days) VALUES
       ('LEAFY','叶菜',8,2,'LEAFY',1),('ROOT','根茎',2,2,'ROOT',7),('MEAT','鲜肉',10,4,'MEAT',3)`,
  );
  const cat = await pool.query('SELECT code, id FROM categories');
  const leafId = cat.rows.find((r) => r.code === 'LEAFY').id;
  const meatId = cat.rows.find((r) => r.code === 'MEAT').id;
  const rootId = cat.rows.find((r) => r.code === 'ROOT').id;
  const skus = await pool.query(
    `INSERT INTO skus (category_id, code, name, unit, min_order_unit, price, cost) VALUES
       ($1,'L1','菠菜','份',1,6.5,2.5),($2,'M1','猪里脊','盒',1,22,15),($3,'R1','土豆','袋',5,3.5,2) RETURNING id, code`,
    [leafId, meatId, rootId],
  );
  skuLeafy = skus.rows.find((r) => r.code === 'L1').id;
  skuMeat = skus.rows.find((r) => r.code === 'M1').id;
  skuRoot = skus.rows.find((r) => r.code === 'R1').id;

  // 历史分组规则：v1 归原到货日；v2（11-10 起）归结转日
  await pool.query(
    `INSERT INTO shelf_rule_versions (version_no, name, effective_from, effective_to, status, rules, created_by)
     VALUES (1,'分组 v1','2026-10-01','2026-11-09','archived',$1,'test'),
            (2,'分组 v2','2026-11-10',NULL,'active',$2,'test')`,
    [JSON.stringify(ruleShape('origin_arrival', 0.3)), JSON.stringify(ruleShape('carryover_date', 0.2))],
  );

  const { hashPassword } = await import('../src/auth');
  await pool.query(
    `INSERT INTO users (username, password_hash, role, store_id) VALUES
       ('hq',$1,'hq',NULL),('s1',$2,'manager',$3),('s2',$2,'manager',$4)`,
    [hashPassword('hq123456'), hashPassword('store123456'), store1, s.rows[1].id],
  );

  const appMod = await import('../src/app');
  app = appMod.createApp();
  hq = (await request(app).post('/api/auth/login').send({ username: 'hq', password: 'hq123456' })).body.token;
  store1Token = (await request(app).post('/api/auth/login').send({ username: 's1', password: 'store123456' })).body.token;
  store2Token = (await request(app).post('/api/auth/login').send({ username: 's2', password: 'store123456' })).body.token;
  expect(hq).toBeTruthy();

  const { addDays } = await import('../src/lib/dates');
  day = addDays('2026-11-13', 0);
}, 30000);

afterAll(async () => {
  await db.closePool();
});

describe('批次台账：按保质期分组登记在库/在途/临期', () => {
  let leafyId = 0;
  let meatTodayId = 0;
  let meatTomorrowId = 0;
  let meatDatedId = 0;

  it('叶菜当天清：到期日 = 到货日，规则版本固化', async () => {
    const res = await request(app).post('/api/shelf/batches').set(auth(hq)).send({
      storeId: store1, skuId: skuLeafy, batchNo: 'L-11-13', arrivalDate: '2026-11-13', qty: 30, businessDate: day,
    });
    expect(res.status).toBe(200);
    expect(res.body.expiryDate).toBe('2026-11-13');
    expect(res.body.state).toBe('in_stock');
    leafyId = res.body.batchId;
  });

  it('鲜肉三日期：前天到货今天到期 → 临期；明天到货 → 在途', async () => {
    const dated = await request(app).post('/api/shelf/batches').set(auth(hq)).send({
      storeId: store1, skuId: skuMeat, batchNo: 'M-11-11', arrivalDate: '2026-11-11', qty: 20, businessDate: day,
    });
    expect(dated.body.expiryDate).toBe('2026-11-13');
    meatDatedId = dated.body.batchId;

    const today = await request(app).post('/api/shelf/batches').set(auth(hq)).send({
      storeId: store1, skuId: skuMeat, batchNo: 'M-11-13', arrivalDate: '2026-11-13', qty: 24, businessDate: day,
    });
    expect(today.body.expiryDate).toBe('2026-11-15');
    meatTodayId = today.body.batchId;

    const tomorrow = await request(app).post('/api/shelf/batches').set(auth(hq)).send({
      storeId: store1, skuId: skuMeat, batchNo: 'M-11-14', arrivalDate: '2026-11-14', qty: 18, businessDate: day,
    });
    expect(tomorrow.body.state).toBe('in_transit');
    meatTomorrowId = tomorrow.body.batchId;
  });

  it('重复登记同批次号一致 → 幂等返回，不新增', async () => {
    const res = await request(app).post('/api/shelf/batches').set(auth(hq)).send({
      storeId: store1, skuId: skuMeat, batchNo: 'M-11-13', arrivalDate: '2026-11-13', qty: 24, businessDate: day,
    });
    expect(res.body.idempotent).toBe(true);
    const n = await db.pool().query('SELECT COUNT(*)::int n FROM batches');
    expect(n.rows[0].n).toBe(4);
  });

  it('台账汇总：在库/在途/临期与分组保质期', async () => {
    const res = await request(app)
      .get(`/api/shelf/batches?storeId=${store1}&businessDate=2026-11-13`).set(auth(hq));
    expect(res.status).toBe(200);
    expect(res.body.summary.inStockQty).toBe(30 + 20 + 24);
    expect(res.body.summary.inTransitQty).toBe(18);
    expect(res.body.summary.nearExpiryQty).toBe(20);
    const groups = res.body.groups.map((g: { categoryCode: string; shelfLifeDays: number }) => `${g.categoryCode}:${g.shelfLifeDays}`);
    expect(groups).toContain('LEAFY:1');
    expect(groups).toContain('MEAT:3');
  });

  it('门店不能查看他店批次 → 403', async () => {
    const res = await request(app)
      .get(`/api/shelf/batches?storeId=${store1}&businessDate=2026-11-13`).set(auth(store2Token));
    expect(res.status).toBe(403);
  });
});

describe('批次盘点：以盘为准 + 按批次与盘点时点幂等合并', () => {
  let stocktakeId = 0;

  it('有差异 → 以盘为准修正账面，差额独立账、批次剔除样本', async () => {
    const meat = await db.pool().query(
      "SELECT id FROM batches WHERE batch_no='M-11-13'",
    );
    expect(meat.rows[0]).toBeTruthy();
    const res = await request(app).post('/api/shelf/batch-stocktakes').set(auth(hq)).send({
      storeId: store1, skuId: skuMeat, batchId: meat.rows[0].id, businessDate: '2026-11-13',
      actualQty: 21, stocktakeAt: '2026-11-13T21:00:00Z',
    });
    expect(res.status).toBe(200);
    expect(res.body.difference).toBe(-3);
    expect(res.body.excluded).toBe(true);
    stocktakeId = res.body.stocktakeId;

    const inv = await db.pool().query('SELECT in_stock_qty FROM batches WHERE id=$1', [meat.rows[0].id]);
    expect(Number(inv.rows[0].in_stock_qty)).toBe(21);
    const adj = await db.pool().query(
      "SELECT * FROM inventory_adjustments WHERE adjust_type='stocktake_variance'",
    );
    expect(adj.rows).toHaveLength(1);
    expect(Number(adj.rows[0].qty)).toBe(-3);
    expect(adj.rows[0].status).toBe('pending_review');
  });

  it('同一盘点时点重复上报 → 幂等返回，不生成第二份', async () => {
    const meat = await db.pool().query("SELECT id FROM batches WHERE batch_no='M-11-13'");
    const res = await request(app).post('/api/shelf/batch-stocktakes').set(auth(hq)).send({
      storeId: store1, skuId: skuMeat, batchId: meat.rows[0].id, businessDate: '2026-11-13',
      actualQty: 21, stocktakeAt: '2026-11-13T21:00:00Z',
    });
    expect(res.body.idempotent).toBe(true);
    expect(res.body.stocktakeId).toBe(stocktakeId);
    const n = await db.pool().query('SELECT COUNT(*)::int n FROM batch_stocktakes');
    expect(n.rows[0].n).toBe(1);
  });
});

describe('结转引擎：跨日滚存 + 成本归属 + 幂等', () => {
  let runId = 0;

  it('营业日 11-13 结转：叶菜当天清、鲜肉滚存、到期批次清货；成本归结转日', async () => {
    const res = await request(app).post('/api/shelf/carryover').set(auth(hq)).send({
      storeId: store1, businessDate: '2026-11-13', stocktakeAt: '2026-11-13T22:00:00Z',
      idempotencyKey: 'co-1',
    });
    expect(res.status).toBe(200);
    runId = res.body.run.id;
    expect(res.body.run.rule_version_no).toBe(2);
    const byBatch = Object.fromEntries(
      res.body.lines.map((l: { batch_no: string; cleared_qty: number; carried_qty: number; expired_qty: number; cost_attribution: string; attributed_date: string; basis_qty: number }) => [l.batch_no, l]),
    );
    expect(byBatch['L-11-13'].cleared_qty).toBe(30);
    expect(byBatch['L-11-13'].carried_qty).toBe(0);
    expect(byBatch['M-11-11'].cleared_qty).toBe(20);
    expect(byBatch['M-11-13'].basis_qty).toBe(21);
    expect(byBatch['M-11-13'].carried_qty).toBe(21);
    expect(byBatch['M-11-13'].cost_attribution).toBe('carryover_date');
    expect(byBatch['M-11-13'].attributed_date).toBe('2026-11-14');
    expect(byBatch['M-11-13'].expired_qty).toBe(0);
  });

  it('同一营业日 + 同一盘点时点重复结转 → 幂等返回，不重复滚存', async () => {
    const res = await request(app).post('/api/shelf/carryover').set(auth(hq)).send({
      storeId: store1, businessDate: '2026-11-13', stocktakeAt: '2026-11-13T22:00:00Z',
      idempotencyKey: 'co-1',
    });
    expect(res.body.idempotent).toBe(true);
    const runs = await db.pool().query('SELECT COUNT(*)::int n FROM carryover_runs');
    expect(runs.rows[0].n).toBe(1);
    const stock = await db.pool().query("SELECT in_stock_qty FROM batches WHERE batch_no='M-11-13'");
    expect(Number(stock.rows[0].in_stock_qty)).toBe(21);
  });

  it('同一营业日不同盘点时点再次结转 → 合并到已有结转，不重复滚存', async () => {
    const res = await request(app).post('/api/shelf/carryover').set(auth(hq)).send({
      storeId: store1, businessDate: '2026-11-13', stocktakeAt: '2026-11-13T23:30:00Z',
      idempotencyKey: 'co-1-late',
    });
    expect(res.body.idempotent).toBe(true);
    expect(res.body.mergedIntoStocktakeAt).toBeTruthy();
    const runs = await db.pool().query('SELECT COUNT(*)::int n FROM carryover_runs');
    expect(runs.rows[0].n).toBe(1);
    const stock = await db.pool().query("SELECT in_stock_qty FROM batches WHERE batch_no='M-11-13'");
    expect(Number(stock.rows[0].in_stock_qty)).toBe(21);
  });

  it('结转明细与独立账齐备（盘点差异 + 当天清 + 到期清货）', async () => {
    const adj = await db.pool().query('SELECT adjust_type, COUNT(*)::int n FROM inventory_adjustments GROUP BY adjust_type');
    const types = adj.rows.map((r) => r.adjust_type);
    expect(types).toContain('stocktake_variance');
    expect(types).toContain('clearance');
    // 在库批次 3 个（叶菜 1 + 鲜肉 2；在途批次不计入本日结转）
    const lines = await db.pool().query('SELECT COUNT(*)::int n FROM carryover_lines WHERE run_id=$1', [runId]);
    expect(lines.rows[0].n).toBe(3);
  });
});

describe('临期折价：折价需求单列，不回喂模型', () => {
  let planId = 0;

  it('建计划幂等；折价实销拆出折价需求', async () => {
    // 用仍可售的鲜肉批次（11-13 到货，结转后在库 21）
    const meat = await db.pool().query("SELECT id FROM batches WHERE batch_no='M-11-13'");
    const r1 = await request(app).post('/api/markdown/plans').set(auth(hq)).send({
      storeId: store1, skuId: skuMeat, batchId: meat.rows[0].id, businessDate: '2026-11-13',
      planQty: 8, idempotencyKey: 'md-1',
    });
    expect(r1.status).toBe(200);
    expect(r1.body.discountRate).toBeCloseTo(0.7);
    planId = r1.body.planId;
    const r2 = await request(app).post('/api/markdown/plans').set(auth(hq)).send({
      storeId: store1, skuId: skuMeat, batchId: meat.rows[0].id, businessDate: '2026-11-13',
      planQty: 8, idempotencyKey: 'md-1',
    });
    expect(r2.body.idempotent).toBe(true);

    const entry = await request(app).post(`/api/markdown/plans/${planId}/entries`).set(auth(hq)).send({
      soldQty: 11, recordedAt: '2026-11-13T19:30:00Z', entryKey: 'md-e1',
    });
    expect(entry.body.withinWindow).toBe(true);
    expect(entry.body.upliftQty).toBe(3);
    // v2 的 upliftRealShare=0.2 → 折价需求 = 3 × 0.8 = 2.4
    expect(entry.body.markdownDemandQty).toBeCloseTo(2.4);

    const demand = await db.pool().query('SELECT * FROM markdown_demand WHERE plan_id=$1', [planId]);
    expect(Number(demand.rows[0].sold_qty)).toBe(11);
    expect(Number(demand.rows[0].markdown_demand_qty)).toBeCloseTo(2.4);
    expect(Number(demand.rows[0].real_demand_qty)).toBeCloseTo(8.6);
  });

  it('折价实销从批次在库扣减（台账留痕）', async () => {
    const meat = await db.pool().query("SELECT id, in_stock_qty FROM batches WHERE batch_no='M-11-13'");
    expect(Number(meat.rows[0].in_stock_qty)).toBe(10); // 21 - 11
    const led = await db.pool().query(
      "SELECT entry_type, out_qty FROM batch_ledger_entries WHERE batch_id=$1 AND entry_type='markdown_sale'",
      [meat.rows[0].id],
    );
    expect(led.rows[0].entry_type).toBe('markdown_sale');
    expect(Number(led.rows[0].out_qty)).toBe(11);
  });

  it('过窗折价单 → 单独归档并注明来源，已锁定建议量不动', async () => {
    const res = await request(app).post(`/api/markdown/plans/${planId}/entries`).set(auth(hq)).send({
      soldQty: 4, recordedAt: '2026-11-14T13:00:00Z', entryKey: 'md-late',
    });
    expect(res.body.withinWindow).toBe(false);
    expect(res.body.disposition).toBe('archived');
    const rows = await db.pool().query('SELECT disposition, note FROM markdown_entries WHERE entry_key=$1', ['md-late']);
    expect(rows.rows[0].disposition).toBe('archived');
    expect(rows.rows[0].note).toContain('过窗');
    // 折价需求未被过窗补录改写
    const demand = await db.pool().query('SELECT markdown_demand_qty FROM markdown_demand WHERE plan_id=$1', [planId]);
    expect(Number(demand.rows[0].markdown_demand_qty)).toBeCloseTo(2.4);
  });

  it('折价需求不进训练样本：样本被标记 demand_class 并剔除', async () => {
    await db.pool().query(
      `INSERT INTO demand_samples
         (store_id, sku_id, business_date, open_hours, sales_qty, stockout_flag, in_stock_hours,
          in_stock_rate, restored_demand, is_censored, source, demand_class, excluded_from_training, exclude_reason)
       VALUES ($1,$2,'2026-11-13',13,11,false,13,0.85,11,false,'review_reflow','markdown_demand',TRUE,'折价需求单列')`,
      [store1, skuMeat],
    );
    const s = await db.pool().query(
      'SELECT demand_class, excluded_from_training FROM demand_samples WHERE store_id=$1 AND sku_id=$2',
      [store1, skuMeat],
    );
    expect(s.rows[0].demand_class).toBe('markdown_demand');
    expect(s.rows[0].excluded_from_training).toBe(true);
    // 预测 SQL 只取 demand_class='regular'，故该样本不参与分位
    const { generateSuggestion } = await import('../src/services/suggestionService');
    await generateSuggestion({
      storeId: store1, arrivalDate: '2026-11-15', idempotencyKey: 'md-gen', createdBy: 'test',
    });
    const items = await db.pool().query(
      `SELECT si.feature_snapshot FROM suggestion_items si
        JOIN suggestion_versions v ON v.id=si.version_id
        WHERE v.idempotency_key='md-gen' AND si.sku_id=$1`,
      [skuMeat],
    );
    expect(items.rows[0].feature_snapshot.sampleKind).toBe('category_prior');
    expect(items.rows[0].feature_snapshot.sampleCount).toBe(0);
  });
});

describe('历史复盘：按当时规则版本重算未确认区间', () => {
  let replayRun = 0;
  let confirmedReview = 0;

  it('v1 区间（11-09）结转成本归原到货日：造历史批次+复盘+结转并确认复盘', async () => {
    const reg = await request(app).post('/api/shelf/batches').set(auth(hq)).send({
      storeId: store1, skuId: skuMeat, batchNo: 'M-11-09', arrivalDate: '2026-11-09', qty: 15, businessDate: '2026-11-09',
    });
    expect(reg.body.expiryDate).toBe('2026-11-11');
    const gen = await request(app).post('/api/suggestions/generate').set(auth(hq)).send({
      storeId: store1, arrivalDate: '2026-11-09', idempotencyKey: 'gen-11-09',
    });
    const items = await request(app)
      .get(`/api/suggestions?storeId=${store1}&arrivalDate=2026-11-09`).set(auth(hq));
    const order = await request(app).post(`/api/versions/${items.body.currentVersion.id}/confirm`).set(auth(store1Token)).send({
      idempotencyKey: 'order-11-09',
      items: items.body.items.map((i: { sku_id: number; suggested_qty: string }) => ({ skuId: i.sku_id, qty: Number(i.suggested_qty) })),
    });
    expect(order.status).toBe(200);
    const review = await request(app).post(`/api/orders/${order.body.orderId}/review`).set(auth(hq));
    confirmedReview = review.body.reviewId;

    const co = await request(app).post('/api/shelf/carryover').set(auth(hq)).send({
      storeId: store1, businessDate: '2026-11-09', stocktakeAt: '2026-11-09T22:00:00Z', idempotencyKey: 'co-11-09',
    });
    expect(co.body.run.rule_version_no).toBe(1);
    const meatLine = co.body.lines.find((l: { batch_no: string }) => l.batch_no === 'M-11-09');
    expect(meatLine.cost_attribution).toBe('origin_arrival');
    expect(meatLine.attributed_date).toBe('2026-11-09');

    // 确认复盘：后续重算不得追溯改写
    const conf = await request(app).post(`/api/reviews/${confirmedReview}/confirm`).set(auth(store1Token)).send({});
    expect(conf.status).toBe(200);
  });

  it('重算跨 v1→v2 区间：已确认复盘标 skipped_confirmed，未确认区间按当时版本归属', async () => {
    const res = await request(app).post('/api/replays').set(auth(hq)).send({
      storeId: store1, dateFrom: '2026-11-09', dateTo: '2026-11-13',
    });
    expect(res.status).toBe(200);
    expect(res.body.run).toBeTruthy();
    replayRun = res.body.run.id;
    expect(res.body.summary.ruleVersions).toEqual(expect.arrayContaining([1, 2]));
    expect(res.body.summary.skippedConfirmed).toBeGreaterThan(0);
    const confirmedLine = res.body.lines.find((l: { review_id: number; action: string }) => l.review_id === confirmedReview);
    expect(confirmedLine.action).toBe('skipped_confirmed');

    // 已确认复盘的结转成本未被改写
    const ri = await db.pool().query(
      'SELECT carryover_cost FROM review_items WHERE review_id=$1', [confirmedReview],
    );
    const before = ri.rows.map((r) => Number(r.carryover_cost));
    const after = await db.pool().query(
      'SELECT carryover_cost FROM review_items WHERE review_id=$1', [confirmedReview],
    );
    expect(after.rows.map((r) => Number(r.carryover_cost))).toEqual(before);
  });

  it('重算区间过长 / 起始日晚于结束日 → 400', async () => {
    const bad = await request(app).post('/api/replays').set(auth(hq)).send({
      storeId: store1, dateFrom: '2026-11-13', dateTo: '2026-11-09',
    });
    expect(bad.status).toBe(400);
  });

  it('门店账号不能发起重算 → 403', async () => {
    const res = await request(app).post('/api/replays').set(auth(store1Token)).send({
      storeId: store1, dateFrom: '2026-11-09', dateTo: '2026-11-13',
    });
    expect(res.status).toBe(403);
  });
});

describe('规则版本：不可变、生效日不得回写', () => {
  it('新版本生效日早于当前生效版本 → 409', async () => {
    const res = await request(app).post('/api/shelf/rule-versions').set(auth(hq)).send({
      name: '回写版本', effectiveFrom: '2026-11-12', rules: ruleShape('origin_arrival', 0.3),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RULE_EFFECTIVE_CONFLICT');
  });

  it('新版本晚于当前生效版本 → 成功，旧版本归档收口', async () => {
    const { addDays } = await import('../src/lib/dates');
    const { todayStr } = await import('../src/lib/dates');
    const effectiveFrom = addDays(todayStr(), 3);
    const res = await request(app).post('/api/shelf/rule-versions').set(auth(hq)).send({
      name: '分组 v3', effectiveFrom, rules: ruleShape('origin_arrival', 0.4),
    });
    expect(res.status).toBe(200);
    expect(res.body.versionNo).toBe(3);
    expect(res.body.archivedVersionNo).toBe(2);
    const old = await db.pool().query('SELECT status, effective_to FROM shelf_rule_versions WHERE version_no=2');
    expect(old.rows[0].status).toBe('archived');
    expect(old.rows[0].effective_to).toBe(addDays(effectiveFrom, -1));
    // 历史区间仍按当时版本解析
    const rv = await request(app).get('/api/shelf/rule-versions?date=2026-11-13').set(auth(hq));
    expect(rv.body.current.version_no).toBe(2);
  });
});

describe('按到货日对账', () => {
  it('对账产出待复核差异单，可标记复核', async () => {
    const res = await request(app).post('/api/shelf/reconcile').set(auth(hq)).send({
      storeId: store1, dateFrom: '2026-11-09', dateTo: '2026-11-14',
    });
    expect(res.status).toBe(200);
    const flags = await request(app).get(`/api/shelf/reconciliation?storeId=${store1}`).set(auth(hq));
    expect(flags.body.flags.length).toBeGreaterThan(0);
    const one = flags.body.flags[0];
    expect(one.status).toBe('pending_review');
    expect(Number(one.variance) !== 0 || one.flag_type === 'stocktake_variance_pending').toBe(true);
    const resolve = await request(app)
      .post(`/api/shelf/reconciliation/${one.id}/resolve`).set(auth(hq))
      .send({ storeId: store1, note: '品类经理已复核' });
    expect(resolve.status).toBe(200);
    expect(resolve.body.status).toBe('resolved');
  });
});
