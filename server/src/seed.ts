import { pool } from './db';
import { hashPassword } from './auth';
import { restoreDemand } from './lib/restore';
import { addDays, todayStr } from './lib/dates';
import { generateSuggestion, confirmOrder } from './services/suggestionService';
import { addStocktake, addWasteRecord, createReview, submitReviewEntry } from './services/reviewService';
import { createRuleVersion, registerBatch, reconcile, runCarryover, submitBatchStocktake } from './services/shelfService';
import { createMarkdownPlan, recordMarkdownEntry } from './services/markdownService';
import { replayHistory, confirmReview } from './services/replayService';

const OPEN_HOURS = 13;

/** 确定性伪随机（种子固定，演示数据可复现） */
function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fmtSellout(inStockHours: number): string {
  const totalMin = 8 * 60 + Math.round(inStockHours * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export async function seedIfEmpty(): Promise<void> {
  const r = await pool().query('SELECT COUNT(*)::int AS n FROM users');
  if (r.rows[0].n > 0) return;
  console.log('[seed] 空库，写入演示数据…');
  const rand = mulberry32(20261113);
  const client = await pool().connect();
  try {
    await client.query('BEGIN');

    const stores = await client.query(
      `INSERT INTO stores (code, name) VALUES ('BJ01','朝阳门店'),('BJ02','海淀店'),('BJ03','通州店')
       RETURNING id, code`,
    );
    const storeId = (code: string) => stores.rows.find((s) => s.code === code)!.id as number;

    const cats = await client.query(
      `INSERT INTO categories (code, name, default_cu, default_co, shelf_group, shelf_life_days) VALUES
         ('LEAFY','叶菜', 8, 2, 'LEAFY', 1),   -- 缺货损失含客流损失 → 临界分位 0.8（高分位）；当天清
         ('ROOT','根茎', 2, 2, 'ROOT', 7),     -- 临界分位 0.5（中位）；耐储
         ('MEAT','鲜肉', 10, 4, 'MEAT', 3)     -- 三日期：多期结转主力
       RETURNING id, code`,
    );
    const catId = (code: string) => cats.rows.find((c) => c.code === code)!.id as number;

    // 同品类不同门店允许不同：通州店叶菜 τ=0.75，海淀店根茎 τ=0.6
    await client.query(
      `INSERT INTO cost_params (store_id, category_id, cu, co) VALUES
         ($1,$2,6,2), ($3,$4,3,2)`,
      [storeId('BJ03'), catId('LEAFY'), storeId('BJ02'), catId('ROOT')],
    );

    // 保质期分组规则版本：v1 从 2026-10-01 生效（鲜肉结转成本归原到货日），
    // v2 从 2026-11-10 生效（成本改归结转日 + 折价需求拆分收紧），用于演示历史口径分叉
    const rulePayload = (costAttribution: 'origin_arrival' | 'carryover_date', upliftRealShare: number) => ({
      defaults: { costAttribution },
      groups: {
        LEAFY: {
          shelfLifeDays: 1, carryoverAllowed: false, nearExpiryDays: 0,
          costAttribution, markdownDiscount: 0.6, markdownUpliftRealShare: upliftRealShare, clearOnExpiry: true,
        },
        ROOT: {
          shelfLifeDays: 7, carryoverAllowed: true, nearExpiryDays: 2,
          costAttribution, markdownDiscount: 0.75, markdownUpliftRealShare: upliftRealShare, clearOnExpiry: true,
        },
        MEAT: {
          shelfLifeDays: 3, carryoverAllowed: true, nearExpiryDays: 1,
          costAttribution, markdownDiscount: 0.7, markdownUpliftRealShare: upliftRealShare, clearOnExpiry: true,
        },
      },
    });
    await client.query(
      `INSERT INTO shelf_rule_versions (version_no, name, effective_from, effective_to, status, rules, created_by)
       VALUES (1,'保质期分组 v1（成本归原到货日）','2026-10-01','2026-11-09','archived',$1,'seed'),
              (2,'保质期分组 v2（成本归结转日）','2026-11-10',NULL,'active',$2,'seed')`,
      [JSON.stringify(rulePayload('origin_arrival', 0.3)), JSON.stringify(rulePayload('carryover_date', 0.2))],
    );

    const skuRows = await client.query(
      `INSERT INTO skus (category_id, code, name, unit, min_order_unit, price, cost, is_new) VALUES
         ($1,'BOC01','菠菜','份',1, 6.5, 2.5, FALSE),
         ($1,'SHC02','生菜','份',1, 5.5, 2.0, FALSE),
         ($1,'YMC03','油麦菜','份',1, 4.5, 1.8, FALSE),
         ($1,'XBC04','小白菜','份',1, 5.0, 2.0, TRUE),
         ($2,'TD05','土豆','袋',5, 3.5, 2.0, FALSE),
         ($2,'HL06','胡萝卜','袋',5, 4.0, 2.2, FALSE),
         ($2,'BL07','白萝卜','袋',5, 3.0, 1.6, FALSE),
         ($2,'YC08','洋葱','袋',5, 4.5, 2.5, FALSE),
         ($3,'ZR09','猪里脊','盒',1, 22.0, 15.0, FALSE),
         ($3,'JX10','鸡胸肉','盒',1, 12.0, 8.5, FALSE),
         ($3,'NF11','牛腱','盒',1, 38.0, 27.0, FALSE)
       RETURNING id, code, category_id`,
    [catId('LEAFY'), catId('ROOT'), catId('MEAT')]);
    const skuId = (code: string) => skuRows.rows.find((s) => s.code === code)!.id as number;
    const LEAFY = catId('LEAFY');
    const MEAT = catId('MEAT');

    // 基础需求（朝阳门店为基准）与门店客流系数
    const baseDemand: Record<string, number> = {
      BOC01: 38, SHC02: 32, YMC03: 28, TD05: 60, HL06: 45, BL07: 40, YC08: 35,
      ZR09: 22, JX10: 26, NF11: 15,
    };
    const traffic: Record<number, number> = { [storeId('BJ01')]: 1.0, [storeId('BJ02')]: 0.85, [storeId('BJ03')]: 0.7 };

    // 历史截断观测样本：近 60 天（朝阳门店留到前天，昨天样本由复盘回流产生，演示闭环）
    const today = todayStr();
    const yesterday = addDays(today, -1);
    for (const s of stores.rows) {
      for (const sku of skuRows.rows) {
        if (sku.code === 'XBC04') continue; // 新品无历史
        const isLeafy = sku.category_id === LEAFY;
        const lastDay = s.id === storeId('BJ01') ? -2 : -1;
        for (let d = -60; d <= lastDay; d++) {
          const date = addDays(today, d);
          const dow = new Date(`${date}T00:00:00`).getDay();
          const weekly = dow === 0 || dow === 6 ? 1.25 : dow === 1 ? 0.9 : 1.0;
          const noise = 0.85 + rand() * 0.3;
          const trueDemand = baseDemand[sku.code] * traffic[s.id] * weekly * noise;

          const pStockout = isLeafy ? 0.18 : 0.08;
          const roll = rand();
          let salesQty: number, flag: boolean | null, sellout: string | null;
          if (roll < pStockout) {
            // 缺货日：实销被货架截断，有售罄时点
            const supplyRatio = 0.55 + rand() * 0.25;
            salesQty = Math.max(1, Math.round(trueDemand * supplyRatio));
            flag = true;
            sellout = fmtSellout(supplyRatio * OPEN_HOURS);
          } else if (roll < pStockout + 0.06) {
            // 断货标记缺失 → 降级保守估计
            salesQty = Math.max(1, Math.round(trueDemand));
            flag = null;
            sellout = null;
          } else {
            salesQty = Math.max(1, Math.round(trueDemand));
            flag = false;
            sellout = null;
          }

          const restored = restoreDemand({
            salesQty, openHours: OPEN_HOURS, stockoutFlag: flag, selloutTime: sellout,
          });

          // 盘点差异批次（菠菜@朝阳，3 天）：剔除出训练样本
          const isDiffBatch =
            s.id === storeId('BJ01') && sku.code === 'BOC01' && (d === -10 || d === -20 || d === -30);

          // 折价需求样本（猪里脊@朝阳，2 天）：折价回升销量单列，同样不进训练
          const isMarkdownSample =
            s.id === storeId('BJ01') && sku.code === 'ZR09' && (d === -3 || d === -4);

          await client.query(
            `INSERT INTO demand_samples
               (store_id, sku_id, business_date, open_hours, sales_qty, stockout_flag, sellout_time,
                in_stock_hours, in_stock_rate, restored_demand, is_censored, degraded,
                excluded_from_training, exclude_reason, source, demand_class, markdown_uplift_qty)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'seed',$15,$16)
             ON CONFLICT (store_id, sku_id, business_date) DO NOTHING`,
            [
              s.id, sku.id, date, OPEN_HOURS, salesQty, flag, sellout,
              restored.inStockHours, restored.inStockRate, restored.restoredDemand,
              restored.isCensored, restored.degraded,
              isDiffBatch || isMarkdownSample,
              isDiffBatch ? '盘点差异批次剔除' : isMarkdownSample ? '折价需求单列，不进入训练样本' : null,
              isMarkdownSample ? 'markdown_demand' : 'regular',
              isMarkdownSample ? Number((restored.restoredDemand * 0.3).toFixed(1)) : 0,
            ],
          );
        }
      }
    }

    // 系统库存快照（昨天/今天），供盘点对照
    for (const s of stores.rows) {
      for (const sku of skuRows.rows) {
        for (const d of [-1, 0]) {
          const date = addDays(today, d);
          const sysQty =
            s.id === storeId('BJ01') && sku.code === 'BOC01' && d === -1
              ? 12 // 演示：系统 12，盘点 7 → 差异 -5
              : Math.round(rand() * 15);
          await client.query(
            `INSERT INTO inventory_snapshots (store_id, sku_id, business_date, system_qty)
             VALUES ($1,$2,$3,$4) ON CONFLICT (store_id, sku_id, business_date) DO NOTHING`,
            [s.id, sku.id, date, sysQty],
          );
        }
      }
    }

    // 用户：总部 + 三门店店长
    const users: [string, string, string, number | null][] = [
      ['hq', 'hq123456', 'hq', null],
      ['store1', 'store123456', 'manager', storeId('BJ01')],
      ['store2', 'store123456', 'manager', storeId('BJ02')],
      ['store3', 'store123456', 'manager', storeId('BJ03')],
    ];
    for (const [username, pw, role, sid] of users) {
      await client.query(
        'INSERT INTO users (username, password_hash, role, store_id) VALUES ($1,$2,$3,$4)',
        [username, hashPassword(pw), role, sid],
      );
    }
    await client.query('COMMIT');
    console.log('[seed] 基础数据完成');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  // ===== 演示业务流（走服务层，保证口径一致）=====
  const storeRows = (await pool().query('SELECT id, code FROM stores ORDER BY id')).rows;
  const skuRowsAll = (await pool().query('SELECT id, code FROM skus ORDER BY id')).rows;
  const sidOf = (code: string) => storeRows.find((s) => s.code === code)!.id as number;
  const skuIdOf = (code: string) => skuRowsAll.find((s) => s.code === code)!.id as number;
  const s1 = sidOf('BJ01');
  const today = todayStr();
  const yesterday = addDays(today, -1);
  const tomorrow = addDays(today, 1);

  // 1) 昨天的建议 → 门店确认 → 复盘（朝阳门店，演示完整闭环）
  const gen = await generateSuggestion({
    storeId: s1, arrivalDate: yesterday, idempotencyKey: 'seed-gen-yesterday-s1',
    triggerEvent: 'manual', features: {}, createdBy: 'seed',
  });
  const sugItems = await pool().query(
    'SELECT sku_id, suggested_qty FROM suggestion_items WHERE version_id=$1 ORDER BY sku_id',
    [gen.versionId],
  );
  const confirmItems = sugItems.rows.map((r: { sku_id: number; suggested_qty: string }, i: number) => ({
    skuId: r.sku_id,
    qty: i === 0 ? Number(r.suggested_qty) + 6 : Number(r.suggested_qty), // 菠菜经验加量
    reasonCode: i === 0 ? '经验加量' : undefined,
  }));
  const ord = await confirmOrder({
    versionId: gen.versionId, idempotencyKey: 'seed-order-yesterday-s1',
    confirmedBy: 'store1', items: confirmItems,
  });
  const rev = await createReview(ord.orderId);

  // 2) 复盘录入：覆盖截断/降级/正常三种样本形态
  const qtyOf = (code: string) =>
    Number(sugItems.rows.find((r: { sku_id: number }) => r.sku_id === skuIdOf(code))!.suggested_qty);
  const entries: [string, boolean | null, string | null, number, number][] = [
    // [sku, 断货标记, 售罄时点, 实销, 报损]
    ['BOC01', true, '15:30', qtyOf('BOC01'), 0],           // 售罄 → 截断观测
    ['SHC02', false, null, qtyOf('SHC02') - 4, 2],
    ['YMC03', false, null, qtyOf('YMC03') - 1, 1],
    ['XBC04', null, null, Math.max(0, qtyOf('XBC04') - 2), 2], // 断货标记缺失 → 降级
    ['TD05', false, null, qtyOf('TD05') - 5, 5],
    ['HL06', false, null, qtyOf('HL06'), 0],
    ['BL07', true, '18:00', qtyOf('BL07'), 0],
    ['YC08', false, null, qtyOf('YC08') - 3, 3],
    ['ZR09', false, null, qtyOf('ZR09') - 2, 2],  // 鲜肉三日期：临期折价单独记在折价单
    ['JX10', false, null, qtyOf('JX10') - 1, 1],
    ['NF11', false, null, qtyOf('NF11'), 0],
  ];
  for (const [code, flag, sellout, sales, waste] of entries) {
    await submitReviewEntry({
      reviewId: rev.reviewId, skuId: skuIdOf(code), actualSales: sales,
      stockoutFlag: flag, selloutTime: sellout, wasteQty: waste,
    });
  }

  // 3) 报损单：一张窗口内（结转重算），一张过窗（单独存档）
  await addWasteRecord({
    storeId: s1, skuId: skuIdOf('SHC02'), businessDate: yesterday, qty: 3,
    recordedAt: new Date(`${yesterday}T22:10:00`),
  });
  await addWasteRecord({
    storeId: s1, skuId: skuIdOf('BOC01'), businessDate: addDays(today, -2), qty: 5,
    recordedAt: new Date(`${yesterday}T13:00:00`),
  });

  // 4) 盘点差异：菠菜昨天系统 12 实盘 7 → 以盘点为准，差异批次样本剔除
  await addStocktake({ storeId: s1, skuId: skuIdOf('BOC01'), businessDate: yesterday, actualQty: 7 });

  // ===== 多期库存：批次台账 / 结转 / 折价 / 历史重算 =====
  // 5) 批次台账：按保质期分组登记在库、在途、临期
  //    叶菜（保质期 1 天）：到货当天清，不结转（昨天到货，昨日闭店已清）
  //    鲜肉（保质期 3 天）：三个到货日各一批，演示多期滚存不重复计数
  //      前天到货 → 今天到期（临期）；昨天到货 → 可结转；明天到货 → 在途
  //    根茎（保质期 7 天）：耐储，临期 2 天
  const meatBatches: Record<string, number[]> = { ZR09: [], JX10: [], NF11: [] };
  const batchSpecs: Array<{ code: string; batchNo: string; offset: number; qty: number }> = [
    { code: 'BOC01', batchNo: `BOC-${addDays(today, -1)}`, offset: -1, qty: 40 },
    { code: 'SHC02', batchNo: `SHC-${addDays(today, -1)}`, offset: -1, qty: 32 },
    { code: 'ZR09', batchNo: `ZR-${addDays(yesterday, -1)}`, offset: -2, qty: 20 }, // 第三日，今天到期→临期
    { code: 'ZR09', batchNo: `ZR-${yesterday}`, offset: -1, qty: 24 },               // 第二日，可结转
    { code: 'ZR09', batchNo: `ZR-${tomorrow}`, offset: 1, qty: 18 },                 // 在途
    { code: 'JX10', batchNo: `JX-${yesterday}`, offset: -1, qty: 26 },
    { code: 'JX10', batchNo: `JX-${tomorrow}`, offset: 1, qty: 20 },
    { code: 'NF11', batchNo: `NF-${addDays(yesterday, -1)}`, offset: -2, qty: 12 },
    { code: 'TD05', batchNo: `TD-${addDays(today, -3)}`, offset: -3, qty: 60 },
    { code: 'HL06', batchNo: `HL-${addDays(yesterday, -1)}`, offset: -2, qty: 45 },
  ];
  for (const spec of batchSpecs) {
    const r = await registerBatch({
      storeId: s1, skuId: skuIdOf(spec.code), batchNo: spec.batchNo,
      arrivalDate: addDays(today, spec.offset), qty: spec.qty, businessDate: yesterday,
    });
    if (meatBatches[spec.code]) meatBatches[spec.code].push(r.batchId);
  }

  // 6) 批次盘点：鲜肉 ZR 第二日批次账面 24 实盘 21 → 以盘为准，差额独立账、批次剔除样本
  const zrSecond = meatBatches.ZR09[1];
  await submitBatchStocktake({
    storeId: s1, skuId: skuIdOf('ZR09'), batchId: zrSecond, businessDate: yesterday,
    actualQty: 21, stocktakeAt: new Date(`${yesterday}T21:00:00`),
  });

  // 7) 临期折价：ZR 到期批次临期折价，折价回升销量单列为折价需求（交易日 = 昨天）
  const zrFirst = meatBatches.ZR09[0];
  const md = await createMarkdownPlan({
    storeId: s1, skuId: skuIdOf('ZR09'), batchId: zrFirst, businessDate: yesterday,
    planQty: 8, idempotencyKey: `seed-md-${yesterday}`, createdBy: 'seed',
  });
  await recordMarkdownEntry({
    planId: md.planId, soldQty: 11, recordedAt: new Date(`${yesterday}T19:30:00`),
    entryKey: `seed-md-entry-${yesterday}`,
  });

  // 8) 结转作业：昨天闭店 → 滚存今天（幂等键 + 盘点时点合并）
  //    叶菜当天清（不结转）、鲜肉滚存次日在库、临期批次按规则清货
  await runCarryover({
    storeId: s1, businessDate: yesterday, stocktakeAt: new Date(`${yesterday}T22:00:00`),
    idempotencyKey: `seed-co-${yesterday}`, createdBy: 'seed',
  });
  // 结转后今天台账：昨天滚存 + 明天在途仍待收货

  // 9) 跨日补录盘点：同一批次（ZR 第二日）闭店后补报一次更正盘点（19 件）
  //    结转已按 21 落库；未确认区间重算时会以这笔补录盘点为基数 → 成本归属差额可见
  await submitBatchStocktake({
    storeId: s1, skuId: skuIdOf('ZR09'), batchId: zrSecond, businessDate: yesterday,
    actualQty: 19, stocktakeAt: new Date(`${yesterday}T23:10:00`),
  });

  // 10) 规则版本分叉演示：v1 时代（2026-11-09）的历史批次与结转
  //    v1 成本归原到货日；同一区间在 v2 时代按结转日归属 → 复盘口径分叉
  const v1Day = '2026-11-09';
  for (const spec of [
    { code: 'ZR09', batchNo: `ZR-${v1Day}`, qty: 15 },
    { code: 'JX10', batchNo: `JX-${v1Day}`, qty: 18 },
    { code: 'BOC01', batchNo: `BOC-${v1Day}`, qty: 20 },
  ]) {
    await registerBatch({
      storeId: s1, skuId: skuIdOf(spec.code), batchNo: spec.batchNo,
      arrivalDate: v1Day, qty: spec.qty, businessDate: v1Day,
    });
  }
  const v1Gen = await generateSuggestion({
    storeId: s1, arrivalDate: v1Day, idempotencyKey: `seed-gen-v1-${v1Day}`,
    triggerEvent: 'manual', features: {}, createdBy: 'seed',
  });
  const v1Items = await pool().query(
    'SELECT sku_id, suggested_qty FROM suggestion_items WHERE version_id=$1', [v1Gen.versionId],
  );
  const v1Order = await confirmOrder({
    versionId: v1Gen.versionId, idempotencyKey: `seed-order-v1-${v1Day}`,
    confirmedBy: 'store1',
    items: v1Items.rows.map((r: { sku_id: number; suggested_qty: string }) => ({
      skuId: r.sku_id, qty: Number(r.suggested_qty),
    })),
  });
  const v1Review = await createReview(v1Order.orderId);
  await submitReviewEntry({
    reviewId: v1Review.reviewId, skuId: skuIdOf('BOC01'),
    actualSales: 18, stockoutFlag: true, selloutTime: '17:00', wasteQty: 2,
  });
  await runCarryover({
    storeId: s1, businessDate: v1Day, stocktakeAt: new Date(`${v1Day}T22:00:00`),
    idempotencyKey: `seed-co-${v1Day}`, createdBy: 'seed',
  });
  // 已确认复盘：重算时不追溯改写（演示 skipped_confirmed）
  await confirmReview({ storeId: s1, reviewId: v1Review.reviewId, confirmedBy: 'store1' });

  // 10) 历史重算：近 6 天未确认区间，跨 v1→v2 规则版本，口径分叉可见
  await replayHistory({
    storeId: s1, dateFrom: addDays(today, -6), dateTo: yesterday, createdBy: 'seed',
  });

  // 11) 按到货日对账：台账/结转/复盘口径逐项核对，对不上的单列
  await reconcile({
    storeId: s1, dateFrom: addDays(today, -7), dateTo: tomorrow,
  });

  // 12) 三家门店明天的建议表（首版）
  for (const s of storeRows) {
    await generateSuggestion({
      storeId: s.id, arrivalDate: tomorrow, idempotencyKey: `seed-gen-tomorrow-s${s.id}`,
      triggerEvent: 'manual', features: {}, createdBy: 'seed',
    });
  }
  console.log('[seed] 演示业务流完成');
}
