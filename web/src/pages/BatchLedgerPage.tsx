import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { todayStr, useApp } from '../store';
import {
  COST_ATTRIBUTION_LABEL,
} from '../types';
import type { BatchResponse, CarryoverResponse, InventoryAdjustment, MarkdownResponse, Meta, RuleVersion } from '../types';

/**
 * 批次台账：按保质期分组登记在库/在途/临期与批次到期日。
 * 叶菜当天清（保质期 1 天，不结转），鲜肉三日期（可结转），规则版本随批次固化。
 */
export default function BatchLedgerPage({ meta }: { meta: Meta | null }) {
  const { filters, user, showToast } = useApp();
  const [data, setData] = useState<BatchResponse | null>(null);
  const [carry, setCarry] = useState<CarryoverResponse | null>(null);
  const [rules, setRules] = useState<RuleVersion[]>([]);
  const [currentRule, setCurrentRule] = useState<RuleVersion | null>(null);
  const [form, setForm] = useState({ skuId: '', batchNo: '', arrivalDate: todayStr(), qty: '', unitCost: '' });
  const [stocktakeForm, setStocktakeForm] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);

  const storeId = filters.storeId;
  const businessDate = todayStr();
  const isHq = user?.role === 'hq';

  const load = useCallback(async () => {
    if (!storeId) return;
    try {
      const [b, co, rv] = await Promise.all([
        api<BatchResponse>(`/api/shelf/batches?storeId=${storeId}&businessDate=${businessDate}`),
        api<CarryoverResponse>(`/api/shelf/carryover?storeId=${storeId}`),
        api<{ versions: RuleVersion[]; current: RuleVersion | null }>(`/api/shelf/rule-versions?date=${businessDate}`),
      ]);
      setData(b);
      setCarry(co);
      setRules(rv.versions);
      setCurrentRule(rv.current);
    } catch (e) {
      showToast(e instanceof Error ? e.message : '加载失败');
    }
  }, [storeId, businessDate]);

  useEffect(() => { load(); }, [load]);

  const visible = useMemo(
    () => (data?.batches ?? []).filter((b) => !filters.categoryId || b.category_id === filters.categoryId),
    [data, filters.categoryId],
  );
  const groups = useMemo(
    () => (data?.groups ?? []).filter((g) => {
      const cat = meta?.categories.find((c) => c.code === g.categoryCode);
      return !filters.categoryId || cat?.id === filters.categoryId;
    }),
    [data, filters.categoryId, meta],
  );

  const register = async () => {
    if (!storeId || !form.skuId || !form.batchNo || !form.qty) {
      showToast('请填写 SKU、批次号、到货日与数量');
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ idempotent: boolean; expiryDate: string; ruleVersionNo: number; state: string }>(
        '/api/shelf/batches',
        {
          method: 'POST',
          body: {
            storeId, skuId: Number(form.skuId), batchNo: form.batchNo, arrivalDate: form.arrivalDate,
            qty: Number(form.qty), unitCost: form.unitCost ? Number(form.unitCost) : undefined,
            businessDate,
          },
        },
      );
      showToast(
        r.idempotent
          ? '批次已存在且一致，幂等返回'
          : `已登记批次，到期 ${r.expiryDate}（规则 v${r.ruleVersionNo}）· ${r.state === 'in_transit' ? '在途' : '在库'}`,
      );
      setForm({ skuId: '', batchNo: '', arrivalDate: todayStr(), qty: '', unitCost: '' });
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '登记失败');
    } finally {
      setBusy(false);
    }
  };

  const arrive = async (batchId: number) => {
    setBusy(true);
    try {
      const r = await api<{ idempotent: boolean; inStockQty: number }>(`/api/shelf/batches/${batchId}/arrive`, {
        method: 'POST', body: { businessDate },
      });
      showToast(r.idempotent ? '该批次已到货，无需重复收货' : `已到货入库，在库 ${r.inStockQty}`);
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '到货失败');
    } finally {
      setBusy(false);
    }
  };

  const submitStocktake = async (batchId: number) => {
    const raw = stocktakeForm[batchId];
    if (raw === undefined || raw === '') {
      showToast('请填写实盘数量');
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ difference: number; excluded: boolean; idempotent: boolean }>('/api/shelf/batch-stocktakes', {
        method: 'POST',
        body: {
          storeId, batchId,
          skuId: visible.find((b) => b.id === batchId)?.sku_id,
          businessDate, actualQty: Number(raw),
          stocktakeAt: `${businessDate}T21:00:00`,
        },
      });
      showToast(
        r.idempotent
          ? '同一盘点时点重复上报：已幂等合并，不产生第二份结转'
          : r.difference === 0
            ? '账实相符'
            : `差异 ${r.difference}：以盘点为准，差额独立账${r.excluded ? '，批次剔除训练样本' : ''}`,
      );
      setStocktakeForm((f) => ({ ...f, [batchId]: '' }));
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '盘点失败');
    } finally {
      setBusy(false);
    }
  };

  const adjustments = (carry?.adjustments ?? []) as InventoryAdjustment[];

  return (
    <>
      <div className="card">
        <h3>
          保质期分组规则
          <span className="sub">批次登记时固化规则版本；结转成本归属由规则版本裁定，规则一改历史毛利口径就分叉</span>
        </h3>
        <div className="kv mb8">
          {currentRule
            ? <span>当前生效 v{currentRule.version_no} · {currentRule.name}（{currentRule.effective_from} 起）</span>
            : <span className="badge red">当日无生效规则版本</span>}
          {Object.entries(currentRule?.rules.groups ?? {}).map(([code, g]) => {
            const cat = meta?.categories.find((c) => c.code === code);
            return (
              <span key={code}>
                {cat?.name ?? code}：保质期 {g.shelfLifeDays} 天 · {g.carryoverAllowed ? '可结转' : '当天清'} ·
                临期 ≤{g.nearExpiryDays} 天 · {COST_ATTRIBUTION_LABEL[g.costAttribution]} · 折价 {Math.round(g.markdownDiscount * 100)}%
              </span>
            );
          })}
          {meta?.categories.filter((c) => !currentRule?.rules.groups[c.code]).map((c) => (
            <span key={c.id} className="badge amber">{c.name} 未在规则内，按默认不结转</span>
          ))}
        </div>
        <div className="kv">
          {rules.map((v) => (
            <span key={v.id}>
              v{v.version_no} {v.status === 'active' ? '生效中' : '已归档'} · {v.effective_from} ~ {v.effective_to ?? '—'}
            </span>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>
          台账汇总 <span className="sub">{businessDate} · 按保质期分组登记在库 / 在途 / 临期</span>
        </h3>
        <div className="stat">
          <div><b>{data?.summary.batchCount ?? 0}</b><span>批次数</span></div>
          <div><b>{data?.summary.inStockQty ?? 0}</b><span>在库</span></div>
          <div><b>{data?.summary.inTransitQty ?? 0}</b><span>在途</span></div>
          <div><b>{data?.summary.nearExpiryQty ?? 0}</b><span>临期</span></div>
          <div><b>{data?.summary.inStockValue ?? 0}</b><span>在库金额</span></div>
          <div><b>{data?.summary.nearExpiryBatches ?? 0}</b><span>临期批次</span></div>
        </div>
        {groups.length > 0 && (
          <div className="kv mt8">
            {groups.map((g) => (
              <span key={g.categoryCode}>
                {g.categoryName} · 保质期 {g.shelfLifeDays} 天 · {g.carryoverAllowed ? '可结转' : '当天清'} · 在库 {g.qty}
                {g.ruleVersions.length > 1 ? ` · 跨规则版本 ${g.ruleVersions.map((v) => `v${v}`).join('/')}` : ''}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h3>批次明细 <span className="sub">到期日由登记时规则版本裁定；FIFO 按到期日先到先出</span></h3>
        {visible.length === 0 && <div className="muted">该门店暂无批次</div>}
        {visible.length > 0 && (
          <table className="grid">
            <thead>
              <tr>
                <th>批次号</th><th>SKU</th><th>品类</th>
                <th className="num">到货日</th><th className="num">到期日</th>
                <th className="num">在库</th><th className="num">在途</th><th className="num">临期</th>
                <th className="num">剩余天数</th><th>状态</th><th>规则</th><th>盘点</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((b) => (
                <tr key={b.id}>
                  <td className="small">{b.batch_no}</td>
                  <td>{b.sku_name}</td>
                  <td>
                    {b.category_name}{' '}
                    <span className="badge">{b.carryover_allowed ? `可结转 ${b.shelf_life_days_rule}天` : `当天清 ${b.shelf_life_days_rule}天`}</span>
                  </td>
                  <td className="num">{b.arrival_date}</td>
                  <td className="num">{b.expiry_date}</td>
                  <td className="num"><b>{b.in_stock_qty}</b></td>
                  <td className="num">{b.in_transit_qty > 0 ? b.in_transit_qty : '—'}</td>
                  <td className="num">
                    {b.near_expiry_qty > 0 ? <span className="badge amber">{b.near_expiry_qty}</span> : '—'}
                  </td>
                  <td className="num">{b.days_to_expiry}</td>
                  <td>
                    {b.state === 'in_transit'
                      ? <span className="badge blue">在途</span>
                      : b.state === 'expired'
                        ? <span className="badge red">过期未处理</span>
                        : b.state === 'near_expiry'
                          ? <span className="badge amber">临期</span>
                          : b.state === 'closed'
                            ? <span className="badge">已清</span>
                            : <span className="badge green">在库</span>}
                  </td>
                  <td className="small muted">v{b.rule_version_no}</td>
                  <td>
                    {b.in_transit_qty > 0 && (
                      <button disabled={busy} onClick={() => arrive(b.id)}>到货</button>
                    )}
                    {b.in_stock_qty > 0 && (
                      <span className="row" style={{ display: 'inline-flex', gap: 4 }}>
                        <input
                          type="number" min={0} placeholder="实盘" style={{ width: 64, textAlign: 'right' }}
                          value={stocktakeForm[b.id] ?? ''}
                          onChange={(e) => setStocktakeForm((f) => ({ ...f, [b.id]: e.target.value }))}
                        />
                        <button disabled={busy} onClick={() => submitStocktake(b.id)}>盘点</button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>
          登记批次 <span className="sub">按到货日生效的规则版本固化保质期与到期日；到货日晚于今日记在途</span>
        </h3>
        <div className="row">
          <select value={form.skuId} onChange={(e) => setForm({ ...form, skuId: e.target.value })}>
            <option value="">选择 SKU</option>
            {(meta?.skus ?? [])
              .filter((s) => !filters.categoryId || s.category_id === filters.categoryId)
              .map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input placeholder="批次号" value={form.batchNo} onChange={(e) => setForm({ ...form, batchNo: e.target.value })} />
          <input type="date" value={form.arrivalDate} onChange={(e) => setForm({ ...form, arrivalDate: e.target.value })} />
          <input type="number" min={0} placeholder="数量" style={{ width: 90 }}
            value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} />
          <input type="number" min={0} step="0.01" placeholder="单位成本（可选）" style={{ width: 130 }}
            value={form.unitCost} onChange={(e) => setForm({ ...form, unitCost: e.target.value })} />
          <button className="primary" disabled={busy || !storeId} onClick={register}>登记</button>
        </div>
        {isHq && <div className="muted small mt8">总部可代门店登记；门店账号仅能登记本店批次。</div>}
      </div>

      <div className="card">
        <h3>
          独立账（盘点差异 / 到期报废 / 当天清）
          <span className="sub">账面与实物不符以盘点为准，差额不在库存里“藏”着，单独待复核</span>
        </h3>
        {adjustments.length === 0 && <div className="muted">暂无差异/报废记录</div>}
        {adjustments.length > 0 && (
          <table className="grid">
            <thead>
              <tr><th>营业日</th><th>批次</th><th>SKU</th><th>类型</th><th className="num">数量</th><th className="num">金额</th><th>状态</th></tr>
            </thead>
            <tbody>
              {adjustments.map((a) => (
                <tr key={a.id}>
                  <td>{a.business_date}</td>
                  <td className="small">{a.batch_no}</td>
                  <td>{a.sku_name}</td>
                  <td>
                    {a.adjust_type === 'stocktake_variance'
                      ? <span className="badge red">盘点差异</span>
                      : a.adjust_type === 'expiry_writeoff'
                        ? <span className="badge amber">到期报废</span>
                        : <span className="badge">当天清</span>}
                  </td>
                  <td className="num">{a.qty}</td>
                  <td className="num">{a.amount}</td>
                  <td>{a.status === 'pending_review' ? <span className="badge amber">待复核</span> : <span className="badge green">已复核</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
