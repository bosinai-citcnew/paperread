// Web Speech API wrapper (Chrome/Edge/Android, Safari 14.5+ via webkit prefix).
// Local minimal typings: lib.dom does not ship SpeechRecognition types in every TS version.

interface SpeechAlternativeLike { readonly transcript: string; readonly confidence: number }
interface SpeechResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechAlternativeLike | undefined;
}
interface SpeechResultListLike {
  readonly length: number;
  readonly [index: number]: SpeechResultLike | undefined;
}
interface SpeechResultEventLike {
  readonly resultIndex: number;
  readonly results: SpeechResultListLike;
}
interface SpeechErrorEventLike { readonly error: string }

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: SpeechResultEventLike) => void) | null;
  onerror: ((e: SpeechErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;
interface SpeechWindow {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
}

export interface DictationHandlers {
  lang: string;                       // e.g. 'zh-TW'
  onInterim: (text: string) => void;  // current, not-yet-final text of the utterance in progress
  onFinal: (text: string) => void;    // a finalized chunk (already trimmed)
  onError: (msg: string) => void;     // user-facing (繁中) message
  onEnd: () => void;                  // recognition stopped (by user, error or timeout)
}

const ERROR_MESSAGES: Record<string, string> = {
  'not-allowed': '麥克風權限被拒絕，請到瀏覽器設定允許麥克風',
  'service-not-allowed': '此瀏覽器不允許語音辨識服務',
  'audio-capture': '找不到麥克風',
  'network': '語音服務連線失敗，請檢查網路',
  'no-speech': '沒有偵測到語音，請再試一次',
  'language-not-supported': '不支援此語言的語音辨識',
};

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as SpeechWindow;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isVoiceSupported(): boolean {
  return getCtor() !== null;
}

/** Starts continuous dictation with interim results. Returns a stop() function (idempotent). */
export function startDictation(h: DictationHandlers): () => void {
  const Ctor = getCtor();
  if (!Ctor) {
    h.onError('此瀏覽器不支援語音輸入');
    h.onEnd();
    return () => {};
  }

  const rec = new Ctor();
  rec.lang = h.lang;
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  let ended = false;
  let stopped = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    h.onEnd();
  };

  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const text = r?.[0]?.transcript ?? '';
      if (r?.isFinal) {
        const t = text.trim();
        if (t) h.onFinal(t);
      } else {
        interim += text;
      }
    }
    h.onInterim(interim.trim());
  };
  rec.onerror = (e) => {
    if (e.error === 'aborted') return; // triggered by our own stop()
    h.onError(ERROR_MESSAGES[e.error] ?? `語音辨識錯誤（${e.error}）`);
  };
  rec.onend = finish;

  try {
    rec.start();
  } catch {
    h.onError('無法啟動語音辨識，請稍後再試');
    finish();
    return () => {};
  }

  return () => {
    if (stopped || ended) return;
    stopped = true;
    try { rec.stop(); } catch { finish(); }
  };
}
