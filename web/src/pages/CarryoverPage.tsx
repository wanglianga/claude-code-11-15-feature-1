import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { shiftDate, todayStr, useApp } from '../store';
import { COST_ATTRIBUTION_LABEL, FLAG_TYPE_LABEL } from '../types';
import type { CarryoverResponse, CarryoverRun, Meta, ReconciliationFlag } from '../types';

/**
 * 多期结转：跨日把剩余库存滚到次日并裁定成本归属。
 * - 叶菜当天清不结转，鲜肉三天保质期滚存；
 * - 有盘点以实盘为基数（差额独立账），与结转按（批次, 盘点时点）幂等合并；
 * - 成本归属按当时分组规则版本（v1 归原到货日 / v2 归结转日）；
 * - 台账 / 结转 / 复盘口径按到货日逐项对账，对不上的批次单列交品类经理复核。
 */
export default function CarryoverPage({ meta }: { meta: Meta | null }) {
  const { filters, user, showToast } = useApp();
  const [data, setData] = useState<CarryoverResponse | null>(null);
  const [flags, setFlags] = useState<ReconciliationFlag[]>([]);
  const [selectedRun, setSelectedRun] = useState<number | null>(null);
  const [dateFrom, setDateFrom] = useState(shiftDate(todayStr(), -7));
  const [dateTo, setDateTo] = useState(todayStr());
  const [busy, setBusy] = useState(false);

  const storeId = filters.storeId;
  const isHq = user?.role === 'hq';

  const load = useCallback(async () => {
    if (!storeId) return;
    try {
      const [co, rc] = await Promise.all([
        api<CarryoverResponse>(`/api/shelf/carryover?storeId=${storeId}`),
        api<{ flags: ReconciliationFlag[] }>(`/api/shelf/reconciliation?storeId=${storeId}`),
      ]);
      setData(co);
      setFlags(rc.flags);
      setSelectedRun((cur) => cur ?? (co.runs[0]?.id ?? null));
    } catch (e) {
      showToast(e instanceof Error ? e.message : '加载失败');
    }
  }, [storeId]);

  useEffect(() => { load(); }, [load]);

  const runNow = async (businessDate: string) => {
    if (!storeId) return;
    setBusy(true);
    try {
      const r = await api<{ run: CarryoverRun; idempotent: boolean; mergedIntoStocktakeAt?: string; lines: CarryoverRun['lines'] }>('/api/shelf/carryover', {
        method: 'POST',
        body: {
          storeId, businessDate,
          stocktakeAt: `${businessDate}T22:00:00`,
          idempotencyKey: `ui-co-${businessDate}`,
        },
      });
      showToast(
        r.idempotent
          ? r.mergedIntoStocktakeAt
            ? '该营业日已结转：本次盘点时点合并到已有结转，不重复滚存'
            : '同一营业日、同一盘点时点的结转已存在：幂等返回，不重复生成'
          : `结转完成：滚存 ${r.run?.totals?.carriedQty ?? 0}，成本 ${r.run?.totals?.costAmount ?? 0} 元`,
      );
      await load();
      setSelectedRun(r.run?.id ?? null);
    } catch (e) {
      showToast(e instanceof Error ? e.message : '结转失败');
    } finally {
      setBusy(false);
    }
  };

  const reconcileNow = async () => {
    if (!storeId) return;
    setBusy(true);
    try {
      const r = await api<{ summary: { newFlags: number } }>('/api/shelf/reconcile', {
        method: 'POST',
        body: { storeId, dateFrom, dateTo, categoryId: filters.categoryId ?? null },
      });
      showToast(r.summary.newFlags === 0 ? '对账完成：未发现新的不一致' : `对账完成：新增 ${r.summary.newFlags} 条待复核`);
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '对账失败');
    } finally {
      setBusy(false);
    }
  };

  const resolveFlag = async (id: number) => {
    try {
      await api(`/api/shelf/reconciliation/${id}/resolve`, {
        method: 'POST',
        body: { storeId, note: '品类经理已复核' },
      });
      showToast('已标记复核');
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '复核失败');
    }
  };

  const run = useMemo(
    () => data?.runs.find((r) => r.id === selectedRun) ?? data?.runs[0] ?? null,
    [data, selectedRun],
  );
  const runs = useMemo(
    () => (data?.runs ?? []).filter((r) => {
      if (!filters.categoryId) return true;
      return r.lines.some((l) => {
        const sku = meta?.skus.find((s) => s.id === l.sku_id);
        return sku?.category_id === filters.categoryId;
      });
    }),
    [data, filters.categoryId, meta],
  );
  const lines = useMemo(
    () => (run?.lines ?? []).filter((l) => {
      if (!filters.categoryId) return true;
      const sku = meta?.skus.find((s) => s.id === l.sku_id);
      return sku?.category_id === filters.categoryId;
    }),
    [run, filters.categoryId, meta],
  );

  return (
    <>
      <div className="card">
        <h3>
          结转作业 <span className="sub">跨日滚存 + 成本归属裁定 · 按（门店, 营业日, 盘点时点）幂等，重复上报不生成两份结转</span>
        </h3>
        <div className="row">
          <label className="muted">营业日
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </label>
          <button className="primary" disabled={busy || !storeId} onClick={() => runNow(dateTo)}>
            执行当日结转
          </button>
          <button disabled={busy || !storeId} onClick={() => runNow(shiftDate(dateTo, -1))}>
            补跑前一日结转
          </button>
          <span className="muted small">
            叶菜：当天清（闭店未售即清出，不滚存）；鲜肉：三天保质期滚存次日；到期批次按规则清货。
          </span>
        </div>
      </div>

      <div className="card">
        <h3>结转历史 <span className="sub">每批次一行：结转基数 / 报废 / 清出 / 滚存 + 成本归属日</span></h3>
        {runs.length === 0 && <div className="muted">暂无结转记录，可执行上一步结转</div>}
        {runs.length > 0 && (
          <div className="tabs">
            {runs.map((r) => (
              <button
                key={r.id}
                className={run?.id === r.id ? 'active' : ''}
                onClick={() => setSelectedRun(r.id)}
              >
                {r.business_date} → {r.target_date} · v{r.rule_version_no}
              </button>
            ))}
          </div>
        )}
        {run && (
          <>
            <div className="kv mb8">
              <span>营业日 {run.business_date} → 次日 {run.target_date}</span>
              <span>规则版本 v{run.rule_version_no}</span>
              <span>盘点时点 {new Date(run.stocktake_at).toLocaleString('zh-CN')}</span>
              <span>滚存 {run.totals.carriedQty ?? 0}</span>
              <span>报废 {run.totals.expiredQty ?? 0}</span>
              <span>当天清 {run.totals.clearedQty ?? 0}</span>
              <span>结转成本 {run.totals.costAmount ?? 0}</span>
            </div>
            <table className="grid">
              <thead>
                <tr>
                  <th>批次</th><th>SKU</th><th className="num">到期日</th>
                  <th className="num">结转基数</th><th className="num">报废</th><th className="num">清出</th>
                  <th className="num">滚存</th><th className="num">单位成本</th><th className="num">成本</th>
                  <th>成本归属</th><th className="num">归属日</th><th>说明</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id}>
                    <td className="small">{l.batch_no}</td>
                    <td>{l.sku_name}</td>
                    <td className="num">{l.expiry_date}</td>
                    <td className="num">{l.basis_qty}</td>
                    <td className="num">{l.expired_qty > 0 ? <span className="badge amber">{l.expired_qty}</span> : '—'}</td>
                    <td className="num">{l.cleared_qty > 0 ? <span className="badge">{l.cleared_qty}</span> : '—'}</td>
                    <td className="num">{l.carried_qty > 0 ? <b>{l.carried_qty}</b> : '—'}</td>
                    <td className="num">{l.unit_cost}</td>
                    <td className="num">{l.cost_amount}</td>
                    <td>
                      <span className={`badge ${l.cost_attribution === 'origin_arrival' ? 'blue' : 'green'}`}>
                        {COST_ATTRIBUTION_LABEL[l.cost_attribution]}
                      </span>
                    </td>
                    <td className="num">{l.attributed_date}</td>
                    <td className="small muted">{l.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      <div className="card">
        <h3>
          按到货日对账 <span className="sub">台账 / 结转结果 / 复盘口径逐项比对；对不上的批次单列，交品类经理复核</span>
        </h3>
        <div className="row">
          <label className="muted">起始日
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </label>
          <label className="muted">结束日
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </label>
          <button className="primary" disabled={busy || !storeId} onClick={reconcileNow}>执行对账</button>
          <span className="muted small">对账口径固定按到货日（reconciliation_grain=arrival_date）</span>
        </div>
        {flags.length === 0 && <div className="muted mt8">当前无对账差异</div>}
        {flags.length > 0 && (
          <table className="grid mt8">
            <thead>
              <tr>
                <th>到货日</th><th>批次</th><th>SKU</th><th>类型</th>
                <th className="num">台账量</th><th className="num">结转合计</th><th className="num">复盘量</th>
                <th className="num">差额</th><th>说明</th><th>状态</th>
              </tr>
            </thead>
            <tbody>
              {flags.map((f) => (
                <tr key={f.id}>
                  <td>{f.arrival_date}</td>
                  <td className="small">{f.batch_no}</td>
                  <td>{f.sku_name}</td>
                  <td><span className="badge red">{FLAG_TYPE_LABEL[f.flag_type] ?? f.flag_type}</span></td>
                  <td className="num">{f.ledger_qty}</td>
                  <td className="num">{f.carryover_total}</td>
                  <td className="num">{f.review_qty}</td>
                  <td className="num"><b>{f.variance}</b></td>
                  <td className="small muted">{f.note}</td>
                  <td>
                    {f.status === 'pending_review'
                      ? <span className="badge amber">待复核</span>
                      : <span className="badge green">已复核</span>}
                    {isHq && f.status === 'pending_review' && (
                      <> <button onClick={() => resolveFlag(f.id)}>复核</button></>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
