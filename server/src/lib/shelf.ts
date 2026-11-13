/**
 * 多期库存 + 保质期分组规则（纯逻辑，无数据库依赖，可单测）。
 *
 * 写死的取舍：
 * - 叶菜当天清（shelfLifeDays=1，不进结转），鲜肉可存三天（shelfLifeDays=3，允许结转）：
 *   同一个单期模型套不上，鲜肉按跨日结转滚存；叶菜不结转，闭店即清。
 * - 结转成本归属写进分组规则版本（origin_arrival 归原到货日 / carryover_date 归结转日）。
 *   规则一改历史毛利口径就分叉，故结转按批次登记时的规则版本裁定，不回读“当前”口径。
 * - 账面与实物不符时以实物盘点为基准，差额单独立账，该批次不进入训练样本。
 * - 临期判定：剩余可售天数 ≤ nearExpiryDays（含到期当日）即为临期。
 */

export interface GroupRule {
  /** 保质期天数：1 = 当天清（不结转）；3 = 三日期（可结转） */
  shelfLifeDays: number;
  /** 是否允许跨日结转；false = 当天清，闭店未售即报废 */
  carryoverAllowed: boolean;
  /** 剩余可售天数 ≤ 该值视为临期 */
  nearExpiryDays: number;
  /** 结转成本归属：origin_arrival 归原到货日 / carryover_date 归结转日 */
  costAttribution: 'origin_arrival' | 'carryover_date';
  /** 临期折价基准折扣 */
  markdownDiscount: number;
  /** 折价回升销量中计为真实需求的比例（其余单列为折价需求） */
  markdownUpliftRealShare: number;
  /** 临期是否禁止结转（到期当日必须清） */
  clearOnExpiry: boolean;
}

export interface RuleVersionRules {
  groups: Record<string, GroupRule>;
  defaults: { costAttribution: 'origin_arrival' | 'carryover_date' };
}

export const DEFAULT_GROUP_RULE: GroupRule = {
  shelfLifeDays: 1,
  carryoverAllowed: false,
  nearExpiryDays: 0,
  costAttribution: 'origin_arrival',
  markdownDiscount: 0.7,
  markdownUpliftRealShare: 0,
  clearOnExpiry: true,
};

export function parseRules(raw: unknown): RuleVersionRules {
  const obj = (raw ?? {}) as Partial<RuleVersionRules>;
  const groups: Record<string, GroupRule> = {};
  for (const [code, g] of Object.entries(obj.groups ?? {})) {
    groups[code] = { ...DEFAULT_GROUP_RULE, ...(g as Partial<GroupRule>) };
  }
  return {
    groups,
    defaults: { costAttribution: obj.defaults?.costAttribution ?? 'origin_arrival' },
  };
}

export function groupRule(rules: RuleVersionRules, categoryCode: string): GroupRule {
  return rules.groups[categoryCode] ?? { ...DEFAULT_GROUP_RULE, costAttribution: rules.defaults.costAttribution };
}

export function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function diffDays(fromStr: string, toStr: string): number {
  const a = new Date(`${fromStr}T00:00:00`).getTime();
  const b = new Date(`${toStr}T00:00:00`).getTime();
  return Math.round((b - a) / 86400000);
}

/** 到货日 + 保质期天数 - 1 = 到期日（保质期含到货当日） */
export function expiryOf(arrivalDate: string, shelfLifeDays: number): string {
  return addDaysStr(arrivalDate, Math.max(shelfLifeDays, 1) - 1);
}

/** 某营业日收盘时，批次的剩余可售天数（含当日） */
export function remainingShelfDays(expiryDate: string, businessDate: string): number {
  return diffDays(businessDate, expiryDate) + 1;
}

export function isNearExpiry(rule: GroupRule, expiryDate: string, businessDate: string): boolean {
  return remainingShelfDays(expiryDate, businessDate) <= rule.nearExpiryDays;
}

export function isExpired(expiryDate: string, businessDate: string): boolean {
  return diffDays(businessDate, expiryDate) < 0;
}

export interface CarryoverInput {
  batchId: number;
  skuId: number;
  batchNo: string;
  arrivalDate: string;
  expiryDate: string;
  unitCost: number;
  bookQty: number;      // 账面在库
  actualQty: number | null;    // 实盘（无盘点为 null）
}

export interface CarryoverVerdict {
  batchId: number;
  skuId: number;
  batchNo: string;
  basisQty: number;      // 结转基数：有盘以盘为准
  expiredQty: number;    // 到期报废
  clearedQty: number;    // 当天清 / 不允许结转
  carriedQty: number;    // 滚存次日
  unitCost: number;
  costAmount: number;
  costAttribution: 'origin_arrival' | 'carryover_date';
  attributedDate: string;
  stocktakeVariance: number; // 实盘 - 账面（无盘为 0）
  note: string | null;
}

/**
 * 单批次跨日结转裁定：
 * 1. 有实盘 → 以实盘为结转基数（差额单独立账，由调用方写入 inventory_adjustments）；
 * 2. 到期日早于营业日 → 全部报废；
 * 3. 分组规则不许结转（叶菜当天清）→ 闭店未售全部清出；
 * 4. 其余滚存次日；成本按规则版本归属到原到货日或结转日。
 */
export function judgeCarryover(
  batch: CarryoverInput,
  businessDate: string,
  rule: GroupRule,
): CarryoverVerdict {
  const hasStocktake = batch.actualQty !== null && batch.actualQty !== undefined;
  const basisQty = Math.max(0, hasStocktake ? (batch.actualQty as number) : batch.bookQty);
  const stocktakeVariance = hasStocktake ? basisQty - Math.max(0, batch.bookQty) : 0;

  let expiredQty = 0;
  let clearedQty = 0;
  let carriedQty = 0;
  let note: string | null = null;

  if (isExpired(batch.expiryDate, businessDate)) {
    expiredQty = basisQty;
    note = `到期日 ${batch.expiryDate} 已过，整批报废`;
  } else if (!rule.carryoverAllowed) {
    clearedQty = basisQty;
    note = `分组规则不允许结转（保质期 ${rule.shelfLifeDays} 天，当天清），闭店未售清出`;
  } else if (rule.clearOnExpiry && diffDays(businessDate, batch.expiryDate) === 0) {
    clearedQty = basisQty;
    note = `当日到期（${batch.expiryDate}），按规则清货`;
  } else {
    carriedQty = basisQty;
    note = `结转至次日，剩余可售 ${remainingShelfDays(batch.expiryDate, businessDate)} 天`;
  }

  const costAttribution = rule.costAttribution;
  const attributedDate = costAttribution === 'origin_arrival' ? batch.arrivalDate : addDaysStr(businessDate, 1);

  return {
    batchId: batch.batchId,
    skuId: batch.skuId,
    batchNo: batch.batchNo,
    basisQty,
    expiredQty,
    clearedQty,
    carriedQty,
    unitCost: batch.unitCost,
    costAmount: Number((basisQty * batch.unitCost).toFixed(2)),
    costAttribution,
    attributedDate,
    stocktakeVariance,
    note,
  };
}

/** 临期折价：折价回升销量 = 实销 - 折价基准销量，单列为折价需求 */
export function splitMarkdownDemand(params: {
  plannedQty: number;
  soldQty: number;
  discountRate: number;
  upliftRealShare: number;
}): { baseQty: number; upliftQty: number; markdownDemandQty: number; realDemandQty: number } {
  const baseQty = Math.max(0, Math.min(params.plannedQty, params.soldQty));
  const upliftRaw = Math.max(0, params.soldQty - baseQty);
  const realShare = Math.min(Math.max(params.upliftRealShare, 0), 1);
  const realDemandQty = Number((baseQty + upliftRaw * realShare).toFixed(2));
  const markdownDemandQty = Number((upliftRaw * (1 - realShare)).toFixed(2));
  return { baseQty, upliftQty: Number(upliftRaw.toFixed(2)), markdownDemandQty, realDemandQty };
}

/** 按到期日先到先出（FIFO）分配；返回每批次分配量与未满足量 */
export function allocateFifo(
  lots: { batchId: number; expiryDate: string; available: number }[],
  qty: number,
): { allocations: { batchId: number; qty: number }[]; unfilled: number } {
  const sorted = [...lots]
    .filter((l) => l.available > 0)
    .sort((a, b) => (a.expiryDate === b.expiryDate ? a.batchId - b.batchId : a.expiryDate < b.expiryDate ? -1 : 1));
  let left = Math.max(0, qty);
  const allocations: { batchId: number; qty: number }[] = [];
  for (const lot of sorted) {
    if (left <= 0) break;
    const take = Math.min(lot.available, left);
    if (take > 0) {
      allocations.push({ batchId: lot.batchId, qty: Number(take.toFixed(4)) });
      left -= take;
    }
  }
  return { allocations, unfilled: Number(left.toFixed(4)) };
}

/** 批次台账展示状态：在途 / 过期未处理 / 临期 / 正常 / 已清 */
export function batchState(batch: {
  expiryDate: string;
  businessDate: string;
  inStockQty: number;
  inTransitQty: number;
}, rule: GroupRule): 'in_transit' | 'expired' | 'near_expiry' | 'normal' | 'closed' {
  if (batch.inTransitQty > 0 && batch.inStockQty <= 0) return 'in_transit';
  if (batch.inStockQty <= 0) return 'closed';
  if (isExpired(batch.expiryDate, batch.businessDate)) return 'expired';
  if (isNearExpiry(rule, batch.expiryDate, batch.businessDate)) return 'near_expiry';
  return 'normal';
}
