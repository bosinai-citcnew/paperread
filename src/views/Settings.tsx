import { useEffect, useState, type ChangeEvent } from 'react';
import { db, DEFAULT_SETTINGS, ensureSeed, getSettings } from '../db';
import type { Settings } from '../types';
import { chat } from '../lib/llm';
import { importKeepFiles, type KeepImportResult } from '../lib/keep';
import { downloadBackup, importBackup, shareBackup, type ImportCounts } from '../lib/backup';
import Icon from '../components/Icons';
import './capture.css';

const PRESETS: { name: string; baseUrl: string; model: string }[] = [
  { name: 'Google Gemini（免費額度）', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  { name: 'Groq（免費額度）', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  { name: 'DeepSeek（付費）', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  { name: 'Ollama 本機', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
];

const VOICE_LANGS = [
  { value: 'zh-TW', label: '中文（台灣）' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'ja-JP', label: '日本語' },
];

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function SettingsView() {
  const [form, setForm] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const [keepFiles, setKeepFiles] = useState<File[]>([]);
  const [keepBusy, setKeepBusy] = useState(false);
  const [keepResult, setKeepResult] = useState<KeepImportResult | null>(null);
  const [keepError, setKeepError] = useState<string | null>(null);

  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const [installEvt, setInstallEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(() =>
    window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true);

  useEffect(() => {
    getSettings().then(s => { setForm(s); setLoaded(true); }).catch(() => setLoaded(true));
  }, []);

  useEffect(() => {
    const onPrompt = (e: Event) => { e.preventDefault(); setInstallEvt(e as BeforeInstallPromptEvent); };
    const onInstalled = () => { setInstalled(true); setInstallEvt(null); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setForm(f => ({ ...f, [key]: value }));

  const saveSettings = async () => {
    await db.settings.put({ ...form, id: 'settings' });
    setSaveMsg('已儲存');
    setTimeout(() => setSaveMsg(null), 2000);
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      await saveSettings(); // chat() reads the saved settings
      const reply = await chat([{ role: 'user', content: '請只回覆 OK' }], { temperature: 0 });
      setTestResult({ ok: true, text: `連線成功，回覆：${reply.trim().slice(0, 80) || '（空白）'}` });
    } catch (e) {
      setTestResult({ ok: false, text: errMsg(e) });
    } finally {
      setTesting(false);
    }
  };

  const onKeepFiles = (e: ChangeEvent<HTMLInputElement>) => {
    setKeepFiles(Array.from(e.target.files ?? []));
    setKeepResult(null);
    setKeepError(null);
  };

  const runKeepImport = async () => {
    setKeepBusy(true);
    setKeepResult(null);
    setKeepError(null);
    try {
      setKeepResult(await importKeepFiles(keepFiles));
    } catch (e) {
      setKeepError(`匯入失敗：${errMsg(e)}`);
    } finally {
      setKeepBusy(false);
    }
  };

  const doExport = async () => {
    setBackupMsg(null);
    try {
      await downloadBackup();
      setBackupMsg('已下載備份檔');
    } catch (e) {
      setBackupMsg(`匯出失敗：${errMsg(e)}`);
    }
  };

  const doShare = async () => {
    setBackupMsg(null);
    try {
      const r = await shareBackup();
      setBackupMsg(r === 'shared' ? '已分享備份檔' : r === 'downloaded' ? '此裝置不支援檔案分享，已改為下載' : null);
    } catch (e) {
      setBackupMsg(`分享失敗：${errMsg(e)}`);
    }
  };

  const onImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    setImporting(true);
    setBackupMsg(null);
    try {
      const c: ImportCounts = await importBackup(file);
      setBackupMsg(`匯入完成：新增 ${c.added}、更新 ${c.updated}、略過 ${c.skipped}`);
    } catch (err) {
      setBackupMsg(`匯入失敗：${errMsg(err)}`);
    } finally {
      setImporting(false);
    }
  };

  const install = async () => {
    if (!installEvt) return;
    await installEvt.prompt();
    const choice = await installEvt.userChoice;
    if (choice.outcome === 'accepted') setInstalled(true);
    setInstallEvt(null);
  };

  const clearAll = async () => {
    if (!confirm('確定要清除所有知識卡、主題、論文與設定嗎？')) return;
    if (!confirm('再次確認：資料將永久刪除且無法復原。建議先匯出備份。要繼續嗎？')) return;
    await Promise.all(db.tables.map(t => t.clear()));
    await ensureSeed();
    location.reload();
  };

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const presetName = PRESETS.find(p => p.baseUrl === form.llmBaseUrl)?.name ?? '';
  const pickPreset = (name: string) => {
    const p = PRESETS.find(x => x.name === name);
    if (p) setForm(f => ({ ...f, llmBaseUrl: p.baseUrl, llmModel: p.model }));
  };
  const pickVoice = (v: string) => {
    const next = { ...form, voiceLang: v };
    setForm(next);
    void db.settings.put({ ...next, id: 'settings' });
  };

  return (
    <div className="page st-page">
      <h1 className="page-title">設定</h1>

      {/* OpenAlex */}
      <div className="section-label st-label-first">論文資料庫（OpenAlex）</div>
      <section className="group st-group">
        <label className="st-field">
          <span className="st-label">OpenAlex API Key（選填）</span>
          <input className="input" type="password" autoComplete="off" value={form.openalexApiKey ?? ''}
            onChange={e => set('openalexApiKey', e.target.value || undefined)} disabled={!loaded} />
          <span className="st-note muted">免費。沒有金鑰時，同一網路每天約可搜尋 100 次；填入免費金鑰約 1000 次。</span>
          <a href="https://openalex.org/settings/api" target="_blank" rel="noreferrer">申請免費金鑰</a>
        </label>
        <label className="st-field">
          <span className="st-label">聯絡信箱（選填，加入 polite pool）</span>
          <input className="input" type="email" value={form.openalexEmail ?? ''}
            onChange={e => set('openalexEmail', e.target.value || undefined)} disabled={!loaded} />
        </label>
        <div className="st-field">
          <div className="row">
            <button type="button" className="btn" onClick={() => void saveSettings()} disabled={!loaded}>儲存</button>
            {saveMsg && <span className="muted">{saveMsg}</span>}
          </div>
        </div>
      </section>

      {/* AI (optional) */}
      <div className="section-label">AI 輔助（選用）</div>
      <section className="group st-group">
        <details className="st-adv">
          <summary>設定 AI 服務</summary>
          <p className="st-note muted">不設定也能使用全部核心功能；設定後可自動撰寫段落、翻譯與深入解讀。</p>
          <label className="st-field">
            <span className="st-label">服務商</span>
            <select className="select" value={presetName} onChange={e => pickPreset(e.target.value)} disabled={!loaded}>
              {!presetName && <option value="">自訂</option>}
              {PRESETS.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </label>
          <label className="st-field">
            <span className="st-label">API Key</span>
            <input className="input" type="password" autoComplete="off" value={form.llmApiKey}
              onChange={e => set('llmApiKey', e.target.value)} disabled={!loaded} />
            <span className="st-note">只存在本機瀏覽器，不會上傳或包含在備份檔中。</span>
          </label>
          <div className="st-field">
            <div className="row">
              <button type="button" className="btn btn-primary" onClick={() => void testConnection()} disabled={!loaded || testing}>
                {testing ? '測試中…' : '測試連線'}
              </button>
              <button type="button" className="btn" onClick={() => void saveSettings()} disabled={!loaded}>儲存</button>
              {saveMsg && <span className="muted">{saveMsg}</span>}
            </div>
            {testResult && <p className={testResult.ok ? 'st-ok' : 'st-result error'}>{testResult.text}</p>}
          </div>
          <details className="st-adv">
            <summary>進階</summary>
            <label className="st-field">
              <span className="st-label">Base URL（OpenAI 相容）</span>
              <input className="input" value={form.llmBaseUrl} onChange={e => set('llmBaseUrl', e.target.value)} disabled={!loaded} />
            </label>
            <label className="st-field">
              <span className="st-label">模型</span>
              <input className="input" value={form.llmModel} onChange={e => set('llmModel', e.target.value)} disabled={!loaded} />
            </label>
          </details>
        </details>
      </section>

      {/* Voice */}
      <div className="section-label">語音</div>
      <section className="group st-group">
        <label className="st-inline">
          <span>辨識語言</span>
          <select className="select st-select" value={form.voiceLang} onChange={e => pickVoice(e.target.value)} disabled={!loaded}>
            {VOICE_LANGS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
        </label>
      </section>

      {/* Keep */}
      <div className="section-label">Google Keep</div>
      <section className="group st-group">
        <details className="st-adv st-adv-top">
          <summary>匯入 Keep 筆記</summary>
          <ol className="st-steps">
            <li>到 <a href="https://takeout.google.com" target="_blank" rel="noreferrer">takeout.google.com</a>，先取消全選，只勾選「Keep」後匯出。</li>
            <li>下載完成後，直接在下方選擇 .zip 檔（也可解壓後選取其中的 .json 檔，可多選）。</li>
            <li>Android：安裝 PaperRead 後，在 Google Keep 的筆記按「傳送／分享」，選擇 PaperRead，就會建立一張知識卡。（分享功能目前只支援 Android Chrome 安裝後的 App。）</li>
          </ol>
          <input className="st-file" type="file" accept=".zip,.json,application/zip,application/json" multiple onChange={onKeepFiles} />
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={() => void runKeepImport()} disabled={keepBusy || keepFiles.length === 0}>
              {keepBusy ? '匯入中…' : `匯入（${keepFiles.length} 個檔案）`}
            </button>
          </div>
          {keepResult && (
            <p className="st-ok">匯入 {keepResult.imported} 筆，略過 {keepResult.skipped} 筆（已在知識卡中、或在垃圾桶）。</p>
          )}
          {keepError && <p className="error">{keepError}</p>}
        </details>
      </section>

      {/* Backup */}
      <div className="section-label">備份與同步</div>
      <section className="group">
        <button type="button" className="st-row" onClick={() => void doExport()}><span>匯出備份</span><Icon name="chevron" size={18} /></button>
        <button type="button" className="st-row" onClick={() => void doShare()}><span>分享備份（存到 Google Drive）</span><Icon name="chevron" size={18} /></button>
        <label className={'st-row' + (importing ? ' st-disabled' : '')}>
          <span>{importing ? '匯入中…' : '匯入備份'}</span><Icon name="chevron" size={18} />
          <input type="file" accept=".json,application/json" onChange={onImportFile} hidden disabled={importing} />
        </label>
      </section>
      <p className="st-foot">{backupMsg ?? '匯入採合併方式：同一筆資料以較新的修改時間為準，不會整批覆蓋。'}</p>

      {/* Install */}
      <div className="section-label">安裝</div>
      <section className="group">
        {installed ? (
          <div className="st-row st-static"><span>已安裝到主畫面</span></div>
        ) : installEvt ? (
          <button type="button" className="st-row" onClick={() => void install()}><span>安裝 App</span><Icon name="chevron" size={18} /></button>
        ) : (
          <div className="st-row st-static st-note">
            {isIOS ? 'iPhone / iPad：請用 Safari 開啟此頁，點下方「分享」圖示，再選「加入主畫面」。' : '若瀏覽器支援，網址列或選單中會出現「安裝」選項。'}
          </div>
        )}
      </section>

      {/* Danger */}
      <div className="section-label">危險區</div>
      <section className="group">
        <button type="button" className="st-row st-danger" onClick={() => void clearAll()}><span>清除所有資料</span></button>
      </section>
      <p className="st-foot">清除此瀏覽器中的所有知識卡、主題、論文與設定。建議先匯出備份。</p>
    </div>
  );
}
