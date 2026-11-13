export interface User {
  id: number;
  username: string;
  role: 'hq' | 'manager';
  storeId: number | null;
}

export interface Store { id: number; code: string; name: string }
export interface Category { id: number; code: string; name: string; default_cu: string; default_co: string }
export interface Sku {
  id: number; category_id: number; code: string; name: string; unit: string;
  min_order_unit: string; price: string; cost: string; is_new: boolean;
}
export interface Meta {
  stores: Store[];
  categories: Category[];
  skus: Sku[];
  costParams: { store_id: number; category_id: number; cu: string; co: string }[];
  params: Record<string, string>;
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
  sku_code: string; sku_name: string; unit: string; category_name: string; category_code: string;
}
export interface Review {
  id: number; order_id: number; version_id: number; store_id: number; arrival_date: string;
  baseline: string; status: string; version_no: number; items: ReviewItem[];
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
