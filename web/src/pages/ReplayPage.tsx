import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { shiftDate, todayStr, useApp } from '../store';
import { COST_ATTRIBUTION_LABEL, REPLAY_ACTION_LABEL } from '../types';
import type { Meta, ReplayLine, ReplayRun, RuleVersion } from '../types';

/**
 * 历史复盘：分组规则调整后按当时版本重算历史区间，只重算未确认部分；
 * 已确认订单不追溯改写（明细标 skipped_confirmed）；
 * 结转成本归属按当时规则版本分叉（v1 归原到货日 / v2 归结转日）；
 * 折价需求按当时规则版本的 uplift 系数重新拆分。
 */
export default function ReplayPage({ meta }: { meta: Meta | null }) {
  const { filters, user, showToast } = useApp();
  const [runs, setRuns] = useState<ReplayRun[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<{ run: ReplayRun; lines: ReplayLine[] } | null>(null);
  const [rules, setRules] = useState<RuleVersion[]>([]);
  const [dateFrom, setDateFrom] = useState(shiftDate(todayStr(), -7));
  const [dateTo, setDateTo] = useState(shiftDate(todayStr(), -1));
  const [busy, setBusy] = useState(false);

  const storeId = filters.storeId;
  const isHq = user?.role === 'hq';

  const load = useCallback(async () => {
    if (!storeId) return;
    try {
      const [rp, rv] = await Promise.all([
        api<{ runs: ReplayRun[] }>(`/api/replays?storeId=${storeId}`),
        api<{ versions: RuleVersion[] }>(`/api/shelf/rule-versions?date=${dateFrom}`),
      ]);
      setRuns(rp.runs);
      setRules(rv.versions);
      setSelected((cur) => cur ?? (rp.runs[0]?.id ?? null));
    } catch (e) {
      showToast(e instanceof Error ? e.message : '加载失败');
    }
  }, [storeId, dateFrom]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!selected || !storeId) {
      setDetail(null);
      return;
    }
    api<{ run: ReplayRun; lines: ReplayLine[] }>(`/api/replays/${selected}?storeId=${storeId}`)
      .then(setDetail)
      .catch((e) => showToast(e.message));
  }, [selected, storeId]);

  const replay = async () => {
    if (!storeId) return;
    setBusy(true);
    try {
      const r = await api<{ run: ReplayRun; summary: ReplayRun['summary'] }>('/api/replays', {
        method: 'POST',
        body: { storeId, dateFrom, dateTo, categoryId: filters.categoryId ?? null },
      });
      showToast(
        `重算完成：重算 ${r.summary.recomputed} · 未变 ${r.summary.unchanged} · 已确认跳过 ${r.summary.skippedConfirmed} · 成本差 ${r.summary.costDelta}`,
      );
      await load();
      setSelected(r.run?.id ?? null);
    } catch (e) {
      showToast(e instanceof Error ? e.message : '重算失败');
    } finally {
      setBusy(false);
    }
  };

  const lines = useMemo(
    () => (detail?.lines ?? []).filter((l) => !filters.categoryId || true),
    [detail, filters.categoryId],
  );
  const run = detail?.run ?? runs.find((r) => r.id === selected) ?? null;

  const actions = useMemo(() => {
    const by: Record<string, number> = {};
    for (const l of lines) by[l.action] = (by[l.action] ?? 0) + 1;
    return by;
  }, [lines]);

  return (
    <>
      <div className="card">
        <h3>
          按当时规则版本重算 <span className="sub">规则一改历史毛利口径就分叉：只重算未确认区间，已确认订单不追溯改写</span>
        </h3>
        <div className="row">
          <label className="muted">起始日 <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} /></label>
          <label className="muted">结束日 <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} /></label>
          {isHq
            ? <button className="primary" disabled={busy || !storeId} onClick={replay}>重算未确认区间</button>
            : <span className="muted small">重算由总部发起（门店账号只读查看）</span>}
          <span className="muted small">结转量为既成事实；重算的是成本归属日、成本金额与折价需求拆分。</span>
        </div>
        <div className="kv mt8">
          {rules.map((v) => (
            <span key={v.id}>
              v{v.version_no} {v.status === 'active' ? '生效中' : '已归档'} · {v.effective_from} ~ {v.effective_to ?? '—'} ·
              {Object.entries(v.rules.groups).map(([code, g]) => {
                const cat = meta?.categories.find((c) => c.code === code);
                return `${cat?.name ?? code} ${g.shelfLifeDays}天 ${COST_ATTRIBUTION_LABEL[g.costAttribution]}`;
              }).join(' / ')}
            </span>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>重算记录</h3>
        {runs.length === 0 && <div className="muted">暂无重算记录</div>}
        {runs.length > 0 && (
          <div className="tabs">
            {runs.map((r) => (
              <button key={r.id} className={run?.id === r.id ? 'active' : ''} onClick={() => setSelected(r.id)}>
                {r.date_from} ~ {r.date_to} · {r.category_name ?? '全部品类'}
              </button>
            ))}
          </div>
        )}
        {run && (
          <>
            <div className="stat mb8">
              <div><b>{run.summary.recomputed}</b><span>已重算</span></div>
              <div><b>{run.summary.unchanged}</b><span>口径未变</span></div>
              <div><b>{run.summary.skippedConfirmed}</b><span>已确认 · 不追溯</span></div>
              <div><b>{run.summary.markdownRecomputed}</b><span>折价需求重算</span></div>
              <div><b>{run.summary.costDelta}</b><span>结转成本差</span></div>
              <div><b>{run.summary.ruleVersions.join(' / ')}</b><span>用到的规则版本</span></div>
            </div>
            <div className="kv mb8">
              <span>重算区间 {run.date_from} ~ {run.date_to}</span>
              <span>口径 {run.summary.grain}</span>
              <span>{run.summary.note}</span>
              <span>操作人 {run.created_by}</span>
            </div>
            {Object.keys(actions).length > 0 && (
              <div className="kv mb8">
                {Object.entries(actions).map(([a, n]) => (
                  <span key={a}>{REPLAY_ACTION_LABEL[a] ?? a}: {n}</span>
                ))}
              </div>
            )}
            <table className="grid">
              <thead>
                <tr>
                  <th>营业日</th><th>SKU</th><th>规则版本</th><th>处置</th>
                  <th className="num">原成本</th><th className="num">新成本</th><th className="num">差额</th>
                  <th>归属日（原 → 新）</th><th>说明</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.business_date}</td>
                    <td>{l.sku_name}</td>
                    <td className="small muted">v{l.rule_version_no ?? '—'}</td>
                    <td>
                      {l.action === 'skipped_confirmed' || l.review_confirmed
                        ? <span className="badge">不追溯</span>
                        : l.action === 'recomputed'
                          ? <span className="badge green">已重算</span>
                          : l.action.startsWith('markdown')
                            ? <span className="badge blue">折价需求</span>
                            : <span className="badge">未变</span>}
                    </td>
                    <td className="num">{l.old_cost ?? '—'}</td>
                    <td className="num">{l.new_cost ?? '—'}</td>
                    <td className="num">{l.delta === null ? '—' : l.delta}</td>
                    <td className="small">{l.old_attribution_date ?? '—'} → {l.new_attribution_date ?? '—'}</td>
                    <td className="small muted">{l.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </>
  );
}
