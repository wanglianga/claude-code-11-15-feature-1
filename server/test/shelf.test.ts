import { describe, expect, it } from 'vitest';
import {
  allocateFifo,
  batchState,
  expiryOf,
  groupRule,
  isExpired,
  isNearExpiry,
  judgeCarryover,
  parseRules,
  remainingShelfDays,
  splitMarkdownDemand,
  DEFAULT_GROUP_RULE,
  type GroupRule,
} from '../src/lib/shelf';

const leafy: GroupRule = {
  shelfLifeDays: 1, carryoverAllowed: false, nearExpiryDays: 0,
  costAttribution: 'origin_arrival', markdownDiscount: 0.6,
  markdownUpliftRealShare: 0.3, clearOnExpiry: true,
};
const meat: GroupRule = {
  shelfLifeDays: 3, carryoverAllowed: true, nearExpiryDays: 1,
  costAttribution: 'carryover_date', markdownDiscount: 0.7,
  markdownUpliftRealShare: 0.2, clearOnExpiry: true,
};
const root: GroupRule = {
  shelfLifeDays: 7, carryoverAllowed: true, nearExpiryDays: 2,
  costAttribution: 'origin_arrival', markdownDiscount: 0.75,
  markdownUpliftRealShare: 0.2, clearOnExpiry: true,
};

describe('保质期分组：到期日与临期判定', () => {
  it('到期日 = 到货日 + 保质期 - 1（保质期含到货当日）', () => {
    expect(expiryOf('2026-11-11', 1)).toBe('2026-11-11');
    expect(expiryOf('2026-11-11', 3)).toBe('2026-11-13');
    expect(expiryOf('2026-11-11', 7)).toBe('2026-11-17');
  });

  it('鲜肉三日：同一批货三个到货日各算一次命运不同（不重复计数靠批次滚存）', () => {
    // 前天到货 → 今天到期（临期且当日清）；昨天到货 → 还剩 2 天；明天到货 → 未到货
    expect(remainingShelfDays(expiryOf('2026-11-11', 3), '2026-11-13')).toBe(1);
    expect(isNearExpiry(meat, expiryOf('2026-11-11', 3), '2026-11-13')).toBe(true);
    expect(isNearExpiry(meat, expiryOf('2026-11-12', 3), '2026-11-13')).toBe(false);
    expect(remainingShelfDays(expiryOf('2026-11-12', 3), '2026-11-13')).toBe(2);
    // 明天到货的批次尚未可售，按“含当日”口径距到期 4 天（到货后实售 3 天）
    expect(remainingShelfDays(expiryOf('2026-11-14', 3), '2026-11-13')).toBe(4);
  });

  it('根茎耐储：临期阈值 2 天', () => {
    expect(isNearExpiry(root, expiryOf('2026-11-11', 7), '2026-11-16')).toBe(true);
    expect(isNearExpiry(root, expiryOf('2026-11-11', 7), '2026-11-15')).toBe(false);
  });

  it('过期判定：到期日早于营业日', () => {
    expect(isExpired('2026-11-12', '2026-11-13')).toBe(true);
    expect(isExpired('2026-11-13', '2026-11-13')).toBe(false);
  });

  it('规则解析：缺省分组回落到默认不结转', () => {
    const rules = parseRules({ groups: { MEAT: meat }, defaults: { costAttribution: 'carryover_date' } });
    expect(groupRule(rules, 'MEAT')).toEqual(meat);
    expect(groupRule(rules, 'UNKNOWN')).toEqual({ ...DEFAULT_GROUP_RULE, costAttribution: 'carryover_date' });
  });
});

describe('结转裁定：当天清 / 滚存 / 到期报废 / 成本归属', () => {
  it('叶菜当天清：不结转，闭店未售全部清出（成本归原到货日）', () => {
    const v = judgeCarryover({
      batchId: 1, skuId: 1, batchNo: 'B1', arrivalDate: '2026-11-13',
      expiryDate: '2026-11-13', unitCost: 2.5, bookQty: 30, actualQty: null,
    }, '2026-11-13', leafy);
    expect(v.carriedQty).toBe(0);
    expect(v.clearedQty).toBe(30);
    expect(v.costAttribution).toBe('origin_arrival');
    expect(v.attributedDate).toBe('2026-11-13');
  });

  it('鲜肉可结转：滚存次日；成本归结转日（v2 口径）', () => {
    const v = judgeCarryover({
      batchId: 2, skuId: 2, batchNo: 'B2', arrivalDate: '2026-11-12',
      expiryDate: '2026-11-14', unitCost: 15, bookQty: 21, actualQty: null,
    }, '2026-11-13', meat);
    expect(v.carriedQty).toBe(21);
    expect(v.costAmount).toBeCloseTo(315);
    expect(v.costAttribution).toBe('carryover_date');
    expect(v.attributedDate).toBe('2026-11-14');
  });

  it('有盘点时以实盘为基数，差额单列（账面 24 实盘 21 → 差 -3）', () => {
    const v = judgeCarryover({
      batchId: 3, skuId: 2, batchNo: 'B3', arrivalDate: '2026-11-12',
      expiryDate: '2026-11-14', unitCost: 15, bookQty: 24, actualQty: 21,
    }, '2026-11-13', meat);
    expect(v.basisQty).toBe(21);
    expect(v.carriedQty).toBe(21);
    expect(v.stocktakeVariance).toBe(-3);
  });

  it('到期报废：到期日早于营业日 → 全部报废，不结转', () => {
    const v = judgeCarryover({
      batchId: 4, skuId: 3, batchNo: 'B4', arrivalDate: '2026-11-10',
      expiryDate: '2026-11-12', unitCost: 8, bookQty: 12, actualQty: null,
    }, '2026-11-13', root);
    expect(v.expiredQty).toBe(12);
    expect(v.carriedQty).toBe(0);
  });

  it('当日到期（clearOnExpiry）→ 清货，不进次日台账', () => {
    const v = judgeCarryover({
      batchId: 5, skuId: 2, batchNo: 'B5', arrivalDate: '2026-11-11',
      expiryDate: '2026-11-13', unitCost: 15, bookQty: 9, actualQty: null,
    }, '2026-11-13', meat);
    expect(v.clearedQty).toBe(9);
    expect(v.carriedQty).toBe(0);
  });

  it('v1 口径：成本归原到货日（与 v2 分支口径对比）', () => {
    const v1: GroupRule = { ...meat, costAttribution: 'origin_arrival' };
    const v = judgeCarryover({
      batchId: 6, skuId: 2, batchNo: 'B6', arrivalDate: '2026-11-09',
      expiryDate: '2026-11-11', unitCost: 15, bookQty: 15, actualQty: 15,
    }, '2026-11-09', v1);
    expect(v.attributedDate).toBe('2026-11-09');
    expect(v.costAttribution).toBe('origin_arrival');
  });
});

describe('临期折价：折价需求单列', () => {
  it('折价回升 = 实销 - 基准量；按规则比例拆真实/折价需求', () => {
    const s = splitMarkdownDemand({ plannedQty: 8, soldQty: 11, discountRate: 0.7, upliftRealShare: 0.2 });
    expect(s.baseQty).toBe(8);
    expect(s.upliftQty).toBe(3);
    expect(s.markdownDemandQty).toBeCloseTo(2.4);
    expect(s.realDemandQty).toBeCloseTo(8.6);
  });

  it('实销低于计划量 → 无折价回升，不进折价需求', () => {
    const s = splitMarkdownDemand({ plannedQty: 10, soldQty: 6, discountRate: 0.7, upliftRealShare: 0.2 });
    expect(s.upliftQty).toBe(0);
    expect(s.markdownDemandQty).toBe(0);
    expect(s.realDemandQty).toBe(6);
  });
});

describe('FIFO 分配与批次状态', () => {
  it('按到期日先到先出，跨批次拆分', () => {
    const r = allocateFifo([
      { batchId: 1, expiryDate: '2026-11-14', available: 10 },
      { batchId: 2, expiryDate: '2026-11-13', available: 5 },
      { batchId: 3, expiryDate: '2026-11-16', available: 20 },
    ], 18);
    expect(r.allocations).toEqual([
      { batchId: 2, qty: 5 },
      { batchId: 1, qty: 10 },
      { batchId: 3, qty: 3 },
    ]);
    expect(r.unfilled).toBe(0);
  });

  it('库存不足 → 未满足量单列', () => {
    const r = allocateFifo([{ batchId: 1, expiryDate: '2026-11-14', available: 4 }], 10);
    expect(r.unfilled).toBe(6);
  });

  it('批次状态：在途 / 临期 / 过期未处理 / 在库 / 已清', () => {
    expect(batchState({ expiryDate: '2026-11-16', businessDate: '2026-11-13', inStockQty: 0, inTransitQty: 18 }, meat)).toBe('in_transit');
    expect(batchState({ expiryDate: '2026-11-13', businessDate: '2026-11-13', inStockQty: 9, inTransitQty: 0 }, meat)).toBe('near_expiry');
    expect(batchState({ expiryDate: '2026-11-12', businessDate: '2026-11-13', inStockQty: 4, inTransitQty: 0 }, meat)).toBe('expired');
    expect(batchState({ expiryDate: '2026-11-16', businessDate: '2026-11-13', inStockQty: 21, inTransitQty: 0 }, meat)).toBe('normal');
    expect(batchState({ expiryDate: '2026-11-16', businessDate: '2026-11-13', inStockQty: 0, inTransitQty: 0 }, meat)).toBe('closed');
  });
});
