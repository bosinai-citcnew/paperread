# PaperRead 研究筆記

本機優先（local-first）的研究筆記 PWA：主題 → 關鍵字 → 分層搜尋論文 → 關聯圖 → 研究缺口 → 精讀重點 → 結構化論文（中/英，APA 7／IEEE／Chicago，匯出 Word）。手機、電腦都能用，可離線。

## 執行

```bash
cd app
npm install
npm run dev        # http://localhost:5173 ；同網路手機可開 Network 網址
npm run build      # 產生 dist/
npm run deploy     # 建置並上傳到 GitHub Pages（https://bosinai-citcnew.github.io/paperread/）
```

> 手機要「安裝成 App」、使用麥克風語音輸入、接收 Keep 分享，需要 **HTTPS**（部署後的網址），區網 http 網址瀏覽器會封鎖麥克風。

## 第一次使用（完全免費，不需要 AI）

1. **研究**：輸入主題（中英文皆可）按「深入挖掘」。系統會先試搜 OpenAlex，從結果自動取得英文關鍵詞，再分層搜尋（關鍵字 → 參考文獻 → 被引用）。
2. **缺口與建議**：按「產生缺口分析」，依 OpenAlex 真實統計（年份趨勢、國家分布、文獻回顧比例）與已收集摘要（研究方法、族群、概念交集）列出缺口，每項附數據與例證論文。
3. **精讀**：論文點「精讀」→「整理重點」，依原文線索詞自動挑出研究問題、方法、樣本、發現、限制、貢獻的原句（標「建議」，確認後保留）；也可在「全文」選取文字加為重點。
4. **論文**：從主題建立 → 一鍵產生全文。產生的是「結構化草稿」：真實引用、各篇重點原句與統計數字；需要你補寫之處標示【待補】。⋯ 可匯出 .docx。
5. **Google Keep**：設定 → 匯入 Keep（Google Takeout 匯出的 zip）；Android 安裝後可從 Keep「傳送」到 PaperRead。

### OpenAlex 額度
OpenAlex 免費，但沒有金鑰時同一網路每天約可搜尋 100 次（一次深入挖掘＋缺口分析約用 5–8 次）。到 [openalex.org/settings/api](https://openalex.org/settings/api) 申請免費金鑰，填到「設定 → 論文資料庫」，每天約 1000 次。

### AI 輔助（選用）
設定 → AI 輔助：可填 Google Gemini 或 Groq 的免費金鑰（或 DeepSeek 等付費服務），之後撰寫段落、翻譯、AI 判讀支持／矛盾會改用 AI。金鑰只存在本機瀏覽器，不會進備份檔。

## 架構

- React 19 + Vite + TypeScript，資料存 IndexedDB（Dexie），`src/types.ts` 為資料模型，`SPEC.md` 為規格。
- 論文資料來源：OpenAlex（免金鑰）。
- 研究方法（關鍵字拆解、分層搜尋、五類研究缺口、文獻回顧結構）參考 [academic-research-skills](https://github.com/Imbad0202/academic-research-skills)（CC BY-NC 4.0）的方法論，未複製其內容。
