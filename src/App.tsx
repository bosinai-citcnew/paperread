import { lazy, Suspense, useEffect, useState } from 'react';
import { ensureSeed } from './db';
import QuickCapture from './components/QuickCapture';
import Icon from './components/Icons';

const Board = lazy(() => import('./views/Board'));
const Research = lazy(() => import('./views/Research'));
const PaperEditor = lazy(() => import('./views/PaperEditor'));
const SettingsView = lazy(() => import('./views/Settings'));
const Reader = lazy(() => import('./views/Reader'));

export type Tab = 'board' | 'research' | 'paper' | 'settings';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'board', label: '知識卡', icon: 'cards' },
  { id: 'research', label: '研究', icon: 'search' },
  { id: 'paper', label: '論文', icon: 'doc' },
  { id: 'settings', label: '設定', icon: 'settings' },
];

function initialTab(): Tab {
  const h = location.hash.replace('#', '') as Tab;
  return TABS.some(t => t.id === h) ? h : 'board';
}

export default function App() {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [ready, setReady] = useState(false);
  const [reading, setReading] = useState<{ cardId: string; pointId?: string } | null>(null);
  useEffect(() => {
    const onRead = (e: Event) => setReading((e as CustomEvent<{ cardId: string; pointId?: string } | null>).detail);
    window.addEventListener('app:read', onRead);
    return () => window.removeEventListener('app:read', onRead);
  }, []);

  useEffect(() => { ensureSeed().then(() => setReady(true)); }, []);
  useEffect(() => {
    history.replaceState(null, '', '#' + tab);
  }, [tab]);
  useEffect(() => {
    const onNav = (e: Event) => setTab((e as CustomEvent<Tab>).detail);
    const onHash = () => setTab(initialTab());
    window.addEventListener('app:navigate', onNav);
    window.addEventListener('hashchange', onHash);
    return () => { window.removeEventListener('app:navigate', onNav); window.removeEventListener('hashchange', onHash); };
  }, []);

  if (!ready) return <div className="loading">載入中…</div>;

  return (
    <div className="app">
      <nav className="nav">
        <div className="brand">PaperRead</div>
        {TABS.map(t => (
          <button key={t.id} className={'nav-item' + (tab === t.id ? ' active' : '')} aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>
            <span className="nav-icon" aria-hidden><Icon name={t.icon} /></span>
            <span className="nav-label">{t.label}</span>
          </button>
        ))}
      </nav>
      <main className="main">
        <Suspense fallback={<div className="loading">載入中…</div>}>
          {tab === 'board' && <Board />}
          {tab === 'research' && <Research />}
          {tab === 'paper' && <PaperEditor />}
          {tab === 'settings' && <SettingsView />}
        </Suspense>
      </main>
      <QuickCapture />
      {reading && (
        <Suspense fallback={null}>
          <Reader key={reading.cardId} cardId={reading.cardId} pointId={reading.pointId} onClose={() => setReading(null)} />
        </Suspense>
      )}
    </div>
  );
}

/** Open the close-reading (精讀) view for a paper card, optionally jumping to a key point. */
export function openReader(cardId: string, pointId?: string) {
  window.dispatchEvent(new CustomEvent('app:read', { detail: { cardId, pointId } }));
}

/** Helper any module can call to switch tabs. */
export function navigate(tab: Tab) {
  window.dispatchEvent(new CustomEvent('app:navigate', { detail: tab }));
}
