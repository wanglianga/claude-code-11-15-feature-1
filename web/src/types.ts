export interface User {
  id: number;
  username: string;
  role: 'hq' | 'manager';
  storeId: number | null;
}

export interface Store { id: number; code: string; name: string }
export interface Category {
  id: number; code: string; name: string; default_cu: string; default_co: string;
  shelf_group: string | null; shelf_life_days: number | null;
}
export interface Sku {
  id: number; category_id: number; code: string; name: string; unit: string;
  min_order_unit: string; price: string; cost: string; is_new: boolean;
}
export interface GroupRule {
  shelfLifeDays: number;
  carryoverAllowed: boolean;
  nearExpiryDays: number;
  costAttribution: 'origin_arrival' | 'carryover_date';
  markdownDiscount: number;
  markdownUpliftRealShare: number;
  clearOnExpiry: boolean;
}
export interface RuleVersion {
  id: number; version_no: number; name: string; effective_from: string; effective_to: string | null;
  status: string; rules: { groups: Record<string, GroupRule>; defaults: { costAttribution: string } };
  created_by: string; created_at: string;
}
export interface Meta {
  stores: Store[];
  categories: Category[];
  skus: Sku[];
  costParams: { store_id: number; category_id: number; cu: string; co: string }[];
  params: Record<string, string>;
  ruleVersions?: RuleVersion[];
}

export interface DemandSample {
  id: number; store_id: number; sku_id: number; business_date: string;
  open_hours: string; sales_qty: string; stockout_flag: boolean | null; sellout_time: string | null;
  in_stock_hours: string; in_stock_rate: string; restored_demand: string;
  is_censored: boolean; degraded: boolean; excluded_from_training: boolean;
  exclude_reason: string | null; source: string;
  sku_code: string; sku_name: string; category_id: number; category_code: string; category_name: string;
}

export interface SuggestionVersion {
  id: number; table_id: number; version_no: number; revision_of: number | null;
  trigger_event: string; status: string; created_by: string; created_at: string;
  feature_snapshot: FeatureSnapshot; cost_snapshot: CostSnapshot;
}
export interface FeatureSnapshot {
  arrivalDate: string; weekday: string; baseline: string;
  features: Record<string, unknown>; sampleWindowDays: number; minSamples: number;
}
export interface CostSnapshot {
  categories: Record<string, { cu: number; co: number; tau: number; source: string }>;
  rounding: string;
}
export interface SuggestionItem {
  id: number; version_id: number; sku_id: number; quantile: string;
  suggested_qty: string; raw_qty: string; model_note: string | null;
  feature_snapshot: Record<string, unknown>;
  sku_code: string; sku_name: string; unit: string; min_order_unit: string; is_new: boolean;
  category_id: number; category_code: string; category_name: string;
}
export interface OrderInfo {
  id: number; table_id: number; version_id: number; store_id: number; arrival_date: string;
  status: string; confirmed_by: string; confirmed_at: string;
}
export interface OrderItem {
  id: number; order_id: number; sku_id: number; qty: string; reason_code: string | null;
  suggested_qty: string; sku_name: string; sku_code: string;
}
export interface SuggestionResponse {
  table: { id: number; store_id: number; arrival_date: string; status: string } | null;
  versions: SuggestionVersion[];
  currentVersion: SuggestionVersion | null;
  items: SuggestionItem[];
  order: OrderInfo | null;
  orderItems: OrderItem[];
}

export interface ReviewItem {
  id: number; review_id: number; sku_id: number; order_qty: string;
  actual_sales: string | null; waste_qty: string | null; restored_demand: string | null;
  stockout_loss_qty: string | null; waste_cost: string | null; stockout_loss_amount: string | null;
  sample_id: number | null; sample_excluded: boolean;
  carryover_qty: string; carryover_cost: string; cost_attribution_date: string | null;
  replay_run_id: number | null;
  sku_code: string; sku_name: string; unit: string; category_name: string; category_code: string;
}
export interface Review {
  id: number; order_id: number; version_id: number; store_id: number; arrival_date: string;
  baseline: string; status: string; version_no: number; items: ReviewItem[];
  confirmed_at: string | null; confirmed_by: string | null;
}

export interface WasteRecord {
  id: number; store_id: number; sku_id: number; business_date: string; qty: string;
  recorded_at: string; within_window: boolean; disposition: 'recalc' | 'archived'; note: string;
  sku_name: string; sku_code: string;
}
export interface Stocktake {
  id: number; store_id: number; sku_id: number; business_date: string;
  system_qty: string; actual_qty: string; difference: string; created_at: string;
  sku_name: string; sku_code: string;
}

export const TRIGGER_EVENTS: Record<string, string> = {
  manual: '手动生成',
  promo_cancelled: '促销临时取消',
  temp_drop: '降温超出预报',
  delivery_delay: '配送车延误',
  waste_carryover: '报损结转重算',
};

export const REASON_CODES = ['天气原因', '促销调整', '竞品影响', '库存压力', '经验加量', '经验减量', '其他'];

// ---------- 多期库存结转与临期折价子系统 ----------
export interface BatchRow {
  id: number; store_id: number; sku_id: number; batch_no: string;
  rule_version_id: number; rule_version_no: number; arrival_date: string; expiry_date: string;
  shelf_life_days: number; shelf_life_days_rule: number;
  received_qty: number; in_stock_qty: number; in_transit_qty: number; near_expiry_qty: number;
  unit_cost: number; status: string; days_to_expiry: number;
  carryover_allowed: boolean; near_expiry_days_rule: number;
  state: 'in_transit' | 'expired' | 'near_expiry' | 'normal' | 'closed';
  business_date: string;
  sku_code: string; sku_name: string; unit: string;
  category_id: number; category_code: string; category_name: string;
}
export interface BatchResponse {
  businessDate: string;
  batches: BatchRow[];
  summary: {
    batchCount: number; inStockQty: number; inTransitQty: number; nearExpiryQty: number;
    inStockValue: number; nearExpiryBatches: number; expiredBatches: number;
  };
  groups: { categoryCode: string; categoryName: string; shelfLifeDays: number; carryoverAllowed: boolean; qty: number; ruleVersions: number[] }[];
}

export interface CarryoverLine {
  id: number; run_id: number; sku_id: number; batch_id: number;
  business_date: string; target_date: string; rule_version_id: number;
  batch_rule_version_id: number; batch_rule_version_no: number;
  basis_qty: number; expired_qty: number; cleared_qty: number; carried_qty: number;
  unit_cost: number; cost_amount: number;
  cost_attribution: 'origin_arrival' | 'carryover_date'; attributed_date: string;
  stocktake_at: string; note: string | null;
  batch_no: string; arrival_date: string; expiry_date: string; sku_code: string; sku_name: string;
}
export interface CarryoverRun {
  id: number; store_id: number; business_date: string; target_date: string;
  rule_version_id: number; rule_version_no: number; stocktake_at: string;
  idempotency_key: string | null; status: string;
  totals: { skus?: number; batches?: number; expiredQty?: number; clearedQty?: number; carriedQty?: number; costAmount?: number; stocktakeVariance?: number };
  lines: CarryoverLine[];
  created_at: string;
}
export interface InventoryAdjustment {
  id: number; store_id: number; sku_id: number; batch_id: number; business_date: string;
  adjust_type: 'stocktake_variance' | 'expiry_writeoff' | 'clearance';
  qty: number; unit_cost: number; amount: number; status: string;
  review_note: string | null; batch_no: string; sku_name: string;
}
export interface CarryoverResponse {
  runs: CarryoverRun[];
  adjustments: InventoryAdjustment[];
}

export interface ReconciliationFlag {
  id: number; run_id: number; store_id: number; sku_id: number; arrival_date: string;
  batch_id: number; flag_type: string; ledger_qty: number; carryover_total: number;
  review_qty: number; variance: number; status: 'pending_review' | 'resolved';
  note: string; resolved_by: string | null; resolved_at: string | null;
  sku_name: string; sku_code: string; batch_no: string; expiry_date: string;
}

export interface MarkdownPlanRow {
  id: number; store_id: number; sku_id: number; batch_id: number; business_date: string;
  rule_version_id: number; rule_version_no: number; plan_qty: number; discount_rate: number;
  status: string; created_by: string; created_at: string;
  batch_no: string; expiry_date: string; arrival_date: string;
  sku_code: string; sku_name: string; unit: string;
  category_id: number; category_code: string; category_name: string;
  uplift_qty: number; markdown_demand_qty: number; sold_qty: number; base_qty: number;
  md_rule_version_no: number | null; markdown_share: number;
}
export interface MarkdownEntryRow {
  id: number; plan_id: number; store_id: number; sku_id: number; business_date: string;
  sold_qty: number; recorded_at: string; within_window: boolean;
  disposition: 'recalc' | 'archived'; note: string; sku_name: string; batch_no: string;
}
export interface MarkdownResponse {
  plans: MarkdownPlanRow[];
  entries: MarkdownEntryRow[];
  summary: { plans: number; plannedQty: number; soldQty: number; upliftQty: number; markdownDemandQty: number };
  policy: { label: string; note: string };
}

export interface ReplayLine {
  id: number; run_id: number; sku_id: number; business_date: string; review_id: number | null;
  review_confirmed: boolean; rule_version_id: number | null; rule_version_no: number | null;
  action: string; old_cost: number | null; new_cost: number | null;
  old_attribution_date: string | null; new_attribution_date: string | null;
  delta: number | null; note: string; sku_name: string; sku_code: string;
}
export interface ReplayRun {
  id: number; store_id: number; category_id: number | null; date_from: string; date_to: string;
  mode: string; created_by: string; status: string;
  summary: {
    days: number; recomputed: number; unchanged: number; skippedConfirmed: number;
    markdownRecomputed: number; markdownUnchanged: number; costDelta: number;
    ruleVersions: number[]; grain: string; note: string;
  };
  category_code: string | null; category_name: string | null; created_at: string;
}

export interface BatchStocktakeRow {
  id: number; store_id: number; sku_id: number; batch_id: number; business_date: string;
  system_qty: number; actual_qty: number; difference: number; stocktake_at: string;
  rule_version_id: number; excluded_from_training: boolean;
  sku_name: string; sku_code: string; batch_no: string; expiry_date: string;
}

export const COST_ATTRIBUTION_LABEL: Record<string, string> = {
  origin_arrival: '归原到货日',
  carryover_date: '归结转日',
};

export const ADJUST_TYPE_LABEL: Record<string, string> = {
  stocktake_variance: '盘点差异',
  expiry_writeoff: '到期报废',
  clearance: '当天清',
};

export const FLAG_TYPE_LABEL: Record<string, string> = {
  ledger_order_mismatch: '台账与订单量不符',
  cost_exceeds_ledger: '结转成本超台账',
  stale_expired_stock: '到期仍有在库',
  stocktake_variance_pending: '盘点差异待复核',
};

export const REPLAY_ACTION_LABEL: Record<string, string> = {
  recomputed: '已重算',
  unchanged: '口径未变',
  skipped_confirmed: '已确认 · 不追溯',
  markdown_recomputed: '折价需求已重算',
  markdown_unchanged: '折价需求未变',
};
