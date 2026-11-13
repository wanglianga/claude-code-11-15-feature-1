import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api';
import { useApp } from './store';
import type { Meta } from './types';
import LoginPage from './pages/LoginPage';
import SamplesPage from './pages/SamplesPage';
import SuggestionsPage from './pages/SuggestionsPage';
import ReviewPage from './pages/ReviewPage';
import BatchLedgerPage from './pages/BatchLedgerPage';
import CarryoverPage from './pages/CarryoverPage';
import MarkdownPage from './pages/MarkdownPage';
import ReplayPage from './pages/ReplayPage';
import FilterBar from './components/FilterBar';

function Shell() {
  const { user, logout, toast } = useApp();
  const [meta, setMeta] = useState<Meta | null>(null);
  useEffect(() => {
    api<Meta>('/api/meta').then(setMeta).catch(() => setMeta(null));
  }, []);

  return (
    <>
      <header className="topbar">
        <div className="brand">生鲜订货决策</div>
        <nav>
          <NavLink to="/samples">需求还原</NavLink>
          <NavLink to="/suggestions">建议与订货</NavLink>
          <NavLink to="/review">收市复盘</NavLink>
          <NavLink to="/batches">批次台账</NavLink>
          <NavLink to="/carryover">多期结转</NavLink>
          <NavLink to="/markdown">临期折价</NavLink>
          <NavLink to="/replay">历史复盘</NavLink>
        </nav>
        <div className="user">
          <span>
            {user?.username}（{user?.role === 'hq' ? '总部' : '门店'}）
          </span>
          <button onClick={logout}>退出</button>
        </div>
      </header>
      <FilterBar meta={meta} />
      <main className="page">
        <Routes>
          <Route path="/" element={<Navigate to="/suggestions" replace />} />
          <Route path="/samples" element={<SamplesPage meta={meta} />} />
          <Route path="/suggestions" element={<SuggestionsPage meta={meta} />} />
          <Route path="/review" element={<ReviewPage meta={meta} />} />
          <Route path="/batches" element={<BatchLedgerPage meta={meta} />} />
          <Route path="/carryover" element={<CarryoverPage meta={meta} />} />
          <Route path="/markdown" element={<MarkdownPage meta={meta} />} />
          <Route path="/replay" element={<ReplayPage meta={meta} />} />
          <Route path="*" element={<Navigate to="/suggestions" replace />} />
        </Routes>
      </main>
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

export default function App() {
  const token = useApp((s) => s.token);
  if (!token) return <LoginPage />;
  return <Shell />;
}
