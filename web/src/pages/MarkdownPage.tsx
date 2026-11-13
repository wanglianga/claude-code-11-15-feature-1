import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { todayStr, useApp } from '../store';
import type { BatchRow, BatchResponse, MarkdownPlanRow, MarkdownResponse, Meta } from '../types';

function newKey(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 临期折价治理：
 * - 只有临期/当日到期批次可建折价计划，计划量与折扣受分组规则版本约束；
 * - 折价回升销量单列为「折价需求」，不当真实需求回喂模型（当日样本剔除训练）；
 * - 折价单可跨日补录：窗口内重算，过窗另行归档并注明来源，已锁定建议量不动。
 */
export default function MarkdownPage({ meta }: { meta: Meta | null }) {
  const { filters, user, showToast } = useApp();
  const [data, setData] = useState<MarkdownResponse | null>(null);
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [form, setForm] = useState({ batchId: '', planQty: '', discountRate: '' });
  const [entryForm, setEntryForm] = useState<Record<number, { qty: string; late: boolean }>>({});
  const [planKey, setPlanKey] = useState(() => newKey('md'));
  const [busy, setBusy] = useState(false);

  const storeId = filters.storeId;
  const date = filters.arrivalDate;
  const isManager = user?.role === 'manager';

  const load = useCallback(async () => {
    if (!storeId) return;
    try {
      const [md, bs] = await Promise.all([
        api<MarkdownResponse>(`/api/markdown?storeId=${storeId}&businessDate=${date}`),
        api<BatchResponse>(`/api/shelf/batches?storeId=${storeId}&businessDate=${date}`),
      ]);
      setData(md);
      setBatches(bs.batches);
    } catch (e) {
      showToast(e instanceof Error ? e.message : '加载失败');
    }
  }, [storeId, date]);

  useEffect(() => { load(); }, [load]);

  const nearBatches = useMemo(
    () => batches.filter((b) => (b.state === 'near_expiry') && b.in_stock_qty > 0
      && (!filters.categoryId || b.category_id === filters.categoryId)),
    [batches, filters.categoryId],
  );
  const plans = useMemo(
    () => (data?.plans ?? []).filter((p) => !filters.categoryId || p.category_id === filters.categoryId),
    [data, filters.categoryId],
  );
  const chosenBatch = nearBatches.find((b) => b.id === Number(form.batchId));
  const defaultDiscount = chosenBatch
    ? (meta?.ruleVersions?.find((v) => v.version_no === chosenBatch.rule_version_no)
        ?.rules.groups?.[chosenBatch.category_code]?.markdownDiscount ?? 0.7)
    : 0.7;
  const plannedQty = Number(form.planQty || 0);
  const discountRate = form.discountRate ? Number(form.discountRate) : defaultDiscount;

  const createPlan = async () => {
    if (!storeId || !form.batchId || !form.planQty) {
      showToast('请选择临期批次并填写折价计划量');
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ idempotent: boolean; discountRate: number; ruleVersionNo: number }>('/api/markdown/plans', {
        method: 'POST',
        body: {
          storeId, batchId: Number(form.batchId), skuId: chosenBatch?.sku_id, businessDate: date,
          planQty: Number(form.planQty), discountRate, idempotencyKey: planKey,
        },
      });
      showToast(r.idempotent
        ? '同一幂等键重复提交：返回原计划，不重复建'
        : `折价计划已建：${Math.round(r.discountRate * 100)}% · 规则 v${r.ruleVersionNo}`);
      setPlanKey(newKey('md'));
      setForm({ batchId: '', planQty: '', discountRate: '' });
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '建计划失败');
    } finally {
      setBusy(false);
    }
  };

  const submitEntry = async (plan: MarkdownPlanRow) => {
    const f = entryForm[plan.id];
    if (!f?.qty) {
      showToast('请填写折价实销');
      return;
    }
    setBusy(true);
    try {
      const recordedAt = f.late ? `${date}T13:00:00` : `${date}T19:30:00`;
      const r = await api<{ withinWindow: boolean; disposition: string; markdownDemandQty: number; upliftQty: number }>(
        `/api/markdown/plans/${plan.id}/entries`,
        {
          method: 'POST',
          body: {
            soldQty: Number(f.qty),
            recordedAt,
            entryKey: `${plan.id}:${date}:${f.late ? 'late' : 'normal'}:${f.qty}`,
          },
        },
      );
      showToast(r.withinWindow
        ? `窗口内：已重算折价需求，折价回升 ${r.upliftQty}，其中折价需求 ${r.markdownDemandQty}`
        : '过窗补录：另行归档并注明来源，已锁定建议量不动');
      setEntryForm((s) => ({ ...s, [plan.id]: { qty: '', late: false } }));
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '录入失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="card">
        <h3>
          折价治理口径 <span className="sub">{data?.policy.note ?? '折价回升销量单列为折价需求，不当真实需求回喂模型'}</span>
        </h3>
        <div className="stat">
          <div><b>{data?.summary.plans ?? 0}</b><span>折价计划</span></div>
          <div><b>{data?.summary.plannedQty ?? 0}</b><span>计划量</span></div>
          <div><b>{data?.summary.soldQty ?? 0}</b><span>折价实销</span></div>
          <div><b>{data?.summary.upliftQty ?? 0}</b><span>折价回升</span></div>
          <div><b>{data?.summary.markdownDemandQty ?? 0}</b><span>折价需求（不回喂）</span></div>
        </div>
      </div>

      <div className="card">
        <h3>新建折价计划 <span className="sub">仅临期/当日到期批次；折扣默认取分组规则版本</span></h3>
        {nearBatches.length === 0 && <div className="muted">当前无临期批次（可先到「批次台账」查看临期状态）</div>}
        {nearBatches.length > 0 && (
          <div className="row">
            <select value={form.batchId} onChange={(e) => setForm({ ...form, batchId: e.target.value })}>
              <option value="">选择临期批次</option>
              {nearBatches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.batch_no} · {b.sku_name} · 到期 {b.expiry_date} · 在库 {b.in_stock_qty}
                </option>
              ))}
            </select>
            <input type="number" min={0} placeholder="计划量" style={{ width: 90 }}
              value={form.planQty} onChange={(e) => setForm({ ...form, planQty: e.target.value })} />
            <input type="number" min={0.1} max={1} step={0.05} placeholder={`折扣 默认${defaultDiscount}`} style={{ width: 130 }}
              value={form.discountRate} onChange={(e) => setForm({ ...form, discountRate: e.target.value })} />
            <button className="primary" disabled={busy || !storeId} onClick={createPlan}>建计划</button>
          </div>
        )}
        {chosenBatch && plannedQty > chosenBatch.in_stock_qty && (
          <div className="badge red mt8">计划量超过批次在库，后端会拒绝</div>
        )}
      </div>

      <div className="card">
        <h3>折价计划与折价需求 <span className="sub">折价需求与真实需求分列；折价需求不进入训练样本</span></h3>
        {plans.length === 0 && <div className="muted">当天暂无折价计划</div>}
        {plans.length > 0 && (
          <table className="grid">
            <thead>
              <tr>
                <th>批次</th><th>SKU</th><th className="num">到期日</th>
                <th className="num">计划量</th><th className="num">折扣</th><th className="num">实销</th>
                <th className="num">基准量</th><th className="num">折价回升</th>
                <th className="num">折价需求</th><th className="num">折价占比</th><th>规则</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.id}>
                  <td className="small">{p.batch_no}</td>
                  <td>{p.sku_name}</td>
                  <td className="num">{p.expiry_date}</td>
                  <td className="num">{p.plan_qty}</td>
                  <td className="num">{Math.round(p.discount_rate * 100)}%</td>
                  <td className="num">{p.sold_qty}</td>
                  <td className="num">{p.base_qty}</td>
                  <td className="num">{p.uplift_qty}</td>
                  <td className="num"><span className="badge amber">{p.markdown_demand_qty}</span></td>
                  <td className="num">{p.sold_qty > 0 ? `${Math.round(p.markdown_share * 100)}%` : '—'}</td>
                  <td className="small muted">计划 v{p.rule_version_no} · 拆分 v{p.md_rule_version_no ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>
          折价单录入 <span className="sub">窗口内（营业日次日 12:00 前）重算；过窗归档并注明来源，已锁定建议量不动</span>
        </h3>
        {plans.length === 0 && <div className="muted">暂无可录入的折价计划</div>}
        {plans.length > 0 && (
          <table className="grid">
            <thead>
              <tr><th>批次</th><th>SKU</th><th className="num">折价实销</th><th>录入时点</th><th></th></tr>
            </thead>
            <tbody>
              {plans.map((p) => {
                const f = entryForm[p.id] ?? { qty: '', late: false };
                return (
                  <tr key={p.id}>
                    <td className="small">{p.batch_no}</td>
                    <td>{p.sku_name}</td>
                    <td className="num">
                      <input type="number" min={0} style={{ width: 80, textAlign: 'right' }} value={f.qty}
                        onChange={(e) => setEntryForm((s) => ({ ...s, [p.id]: { ...f, qty: e.target.value } }))} />
                    </td>
                    <td>
                      <select value={f.late ? 'late' : 'normal'}
                        onChange={(e) => setEntryForm((s) => ({ ...s, [p.id]: { ...f, late: e.target.value === 'late' } }))}>
                        <option value="normal">当日 {date} 19:30（窗口内）</option>
                        <option value="late">次日 13:00（过窗）</option>
                      </select>
                    </td>
                    <td><button disabled={busy} onClick={() => submitEntry(p)}>提交折价单</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>补录记录 <span className="sub">窗口内 / 过窗存档各自注明处置</span></h3>
        {(data?.entries ?? []).length === 0 && <div className="muted">当天暂无折价补录</div>}
        {(data?.entries ?? []).length > 0 && (
          <table className="grid">
            <thead>
              <tr><th>批次</th><th>SKU</th><th className="num">实销</th><th>录入时间</th><th>处置</th><th>说明</th></tr>
            </thead>
            <tbody>
              {(data?.entries ?? []).map((e) => (
                <tr key={e.id}>
                  <td className="small">{e.batch_no}</td>
                  <td>{e.sku_name}</td>
                  <td className="num">{e.sold_qty}</td>
                  <td className="small">{new Date(e.recorded_at).toLocaleString('zh-CN')}</td>
                  <td>{e.disposition === 'recalc'
                    ? <span className="badge green">重算</span>
                    : <span className="badge amber">过窗存档</span>}</td>
                  <td className="small muted">{e.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {isManager && <div className="muted small">门店账号只能为本店批次建计划/录折价单。</div>}
    </>
  );
}
