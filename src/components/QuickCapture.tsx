import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { addCard, getSettings } from '../db';
import { isVoiceSupported, startDictation } from '../lib/voice';
import Icon from './Icons';
import Sheet from './Sheet';
import '../views/capture.css';

/** Splits "a, b，c" into unique trimmed tags. */
function parseTags(s: string): string[] {
  return [...new Set(s.split(/[,，、\s]+/).map(t => t.trim().replace(/^#/, '')).filter(Boolean))];
}

/** Joins dictated text onto the body, adding a space only between two Latin words. */
function appendText(body: string, add: string): string {
  if (!body || /\s$/.test(body)) return body + add;
  const needsSpace = /[A-Za-z0-9]$/.test(body) && /^[A-Za-z0-9]/.test(add);
  return body + (needsSpace ? ' ' : '') + add;
}

const firstLine = (s: string) => s.split('\n').map(l => l.trim()).find(Boolean) ?? '';

/**
 * Web Share Target (GET, params title/text/url). Reads and strips the query string synchronously
 * so a reload or StrictMode re-run cannot create the card twice.
 */
function takeSharedParams(): { title: string; text: string; url: string } | null {
  const sp = new URLSearchParams(location.search);
  if (!sp.has('title') && !sp.has('text') && !sp.has('url')) return null;
  const shared = { title: sp.get('title') ?? '', text: sp.get('text') ?? '', url: sp.get('url') ?? '' };
  history.replaceState(null, '', location.pathname + location.hash);
  if (!shared.title.trim() && !shared.text.trim() && !shared.url.trim()) return null;
  return shared;
}

export default function QuickCapture() {
  const [open, setOpen] = useState(false);
  // Hide the FAB while scrolling down so it never covers content; show again on scroll up.
  const [fabHidden, setFabHidden] = useState(false);
  useEffect(() => {
    let last = 0;
    const onScroll = (e: Event) => {
      const el = e.target as HTMLElement | Document;
      const y = el instanceof Document ? window.scrollY : el.scrollTop;
      if (Math.abs(y - last) < 8) return;
      setFabHidden(y > last && y > 80);
      last = y;
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', onScroll, { capture: true });
  }, []);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [dictated, setDictated] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [voiceLang, setVoiceLang] = useState('zh-TW');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [more, setMore] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const stopRef = useRef<(() => void) | null>(null);
  const sessionRef = useRef(0); // guards onEnd of a previous dictation session
  const toastTimer = useRef<number | undefined>(undefined);
  const voiceOK = isVoiceSupported();

  const showToast = (msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  };

  // Web Share Target: create a card from shared content.
  useEffect(() => {
    const shared = takeSharedParams();
    if (!shared) return;
    const text = shared.text.trim();
    const url = shared.url.trim();
    const cardBody = [text, url].filter(Boolean).join('\n\n');
    const cardTitle = shared.title.trim() || firstLine(text) || url || '分享的內容';
    void (async () => {
      await addCard({ title: cardTitle, body: cardBody, kind: 'note', source: 'share', columnId: 'inbox' });
      showToast('已收到分享');
    })();
  }, []);

  // Stop the microphone when the sheet unmounts.
  useEffect(() => () => { stopRef.current?.(); }, []);

  const stopDictation = () => {
    stopRef.current?.();
    stopRef.current = null;
    setListening(false);
    setInterim('');
  };

  const openSheet = () => {
    setError(null);
    setOpen(true);
    getSettings()
      .then(s => setVoiceLang(s.voiceLang || 'zh-TW'))
      .catch(() => { /* keep default */ });
  };

  const closeSheet = () => {
    stopDictation();
    setOpen(false);
  };

  const resetDraft = () => {
    setTitle('');
    setBody('');
    setTagsText('');
    setMore(false);
    setDictated(false);
    setError(null);
  };

  const toggleMic = () => {
    if (listening) { stopDictation(); return; }
    setError(null);
    const session = ++sessionRef.current;
    stopRef.current = startDictation({
      lang: voiceLang,
      onInterim: (text) => { if (sessionRef.current === session) setInterim(text); },
      onFinal: (text) => {
        if (sessionRef.current !== session) return;
        setDictated(true);
        setBody(b => appendText(b, text));
      },
      onError: (msg) => { if (sessionRef.current === session) setError(msg); },
      onEnd: () => {
        if (sessionRef.current !== session) return;
        stopRef.current = null;
        setListening(false);
        setInterim('');
      },
    });
    setListening(true);
  };

  const save = async () => {
    const t = title.trim();
    const b = body.trim();
    if (!t && !b) return;
    setSaving(true);
    try {
      stopDictation();
      await addCard({
        title: t || firstLine(b).slice(0, 40),
        body: b,
        tags: parseTags(tagsText),
        kind: dictated ? 'voice' : 'note',
        source: dictated ? 'voice' : 'manual',
        columnId: 'inbox',
      });
      resetDraft();
      setOpen(false);
      showToast('已存入收件匣');
    } catch (e) {
      setError(e instanceof Error ? e.message : '儲存失敗');
    } finally {
      setSaving(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
  };

  const canSave = !saving && (title.trim() !== '' || body.trim() !== '');

  const hasMore = title.trim() !== '' || tagsText.trim() !== '';

  return (
    <>
      <button type="button" className={'qc-fab' + (fabHidden ? ' qc-fab-hidden' : '')} aria-label="新增知識卡" title="新增知識卡" onClick={openSheet}><Icon name="plus" size={28} /></button>

      <Sheet open={open} onClose={closeSheet} title="快速記錄" label="快速記錄"
        headerRight={
          <button type="button" className={'icon-btn sm' + (more || hasMore ? ' qc-on' : '')} aria-label="標題與標籤" aria-pressed={more}
            onClick={() => setMore(m => !m)}><Icon name="hash" size={20} /></button>
        }
        footer={<>
          <span className="muted qc-shortcut">Ctrl / ⌘ + Enter</span>
          <button type="button" className="btn btn-primary" disabled={!canSave} onClick={() => void save()}>
            {saving ? '儲存中…' : '儲存'}
          </button>
        </>}>
        <div className="qc-sheet" onKeyDown={onKey}>
          {more && (
            <>
              <input className="input" placeholder="標題（可留空，會取內容首行）" value={title} onChange={e => setTitle(e.target.value)} />
              <input className="input" placeholder="標籤，以逗號分隔（例如：心理學, 方法）" value={tagsText} onChange={e => setTagsText(e.target.value)} />
            </>
          )}
          <div className="qc-body-wrap">
            <textarea className="textarea qc-textarea" autoFocus placeholder="寫下想法、摘錄或直接說話…"
              value={body} onChange={e => setBody(e.target.value)} />
            {listening && interim && <div className="qc-interim" aria-live="polite">{interim}</div>}
          </div>

          <div className="qc-mic-row">
            {voiceOK ? (
              <>
                <button type="button" className={'qc-mic' + (listening ? ' is-on' : '')} onClick={toggleMic}
                  aria-pressed={listening} aria-label={listening ? '停止語音' : '語音輸入'}>
                  <Icon name={listening ? 'stop' : 'mic'} size={28} />
                </button>
                <span className="muted qc-hint">{listening ? '聆聽中…點一下停止' : dictated ? '已加入語音內容' : '點麥克風開始說話'}</span>
              </>
            ) : (
              <span className="muted qc-hint">此瀏覽器不支援語音輸入（iPhone 請用 Safari，Android 請用 Chrome）</span>
            )}
          </div>
          {error && <div className="error qc-error">{error}</div>}
        </div>
      </Sheet>

      {toast && <div className="qc-toast" role="status">{toast}</div>}
    </>
  );
}
