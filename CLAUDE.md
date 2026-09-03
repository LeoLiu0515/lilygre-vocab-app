# LilyGRE 字根單字通勤機

一個離線可用的 GRE 單字 PWA,使用者在通勤時用手機背單字。介面全中文(繁體)。

- **線上網址**:https://leoliu0515.github.io/lilygre-vocab-app/
- **Repo**:https://github.com/LeoLiu0515/lilygre-vocab-app(GitHub Pages,`main` 分支根目錄)

## 檔案結構

純靜態,沒有 build step、沒有框架、沒有 npm。直接改檔案即可。

| 檔案 | 內容 |
|---|---|
| `index.html` | 全部 6 個畫面(view-home / session / quiz / listen / done / stats) |
| `style.css` | 深色編輯風格主題,金色強調色,襯線字體標題 |
| `app.js` | 所有邏輯(約 1000 行,無模組) |
| `data.js` | `const VOCAB_DATA = [...]`,1738 個單字物件 |
| `sw.js` | Service Worker,離線快取 |
| `manifest.json`, `icon-*.png` | PWA 安裝設定 |

### 單字資料格式(`data.js`)

```js
{ num, root, root_gloss, word, mnemonic, meaning_zh[], meaning_en[], example[], synonyms[], day }
```

1738 個字依字根分成 7 天(每天 246–250 字),`day` 欄位 1–7。使用者的目標是**一週把整本輪一遍**。

## 記憶法(`mnemonic`)的撰寫規則

這是這個專案最重要的品質標準,使用者非常在意。全部 1738 條都是照這套規則重寫過的:

1. **只能用使用者一定認得的日常英文字**當鉤子(acid、stain、genius、fatigue、credit、trick…)。
2. **不准用他沒學過的拉丁字根**去「解釋」(`pusill`、`spic`、`cret`、`sequ` 這種一律禁止)。
3. 拆不出來的字就用**中文諧音**(amiable = 「阿姨-able」、pusillanimous = 「怕死」的心)或**流行文化**(bane = 蝙蝠俠反派、quixotic = 唐吉訶德)。
4. **同字根的相似字必須給完全不同的鉤子**,能互相區分才有用。例:
   - abstain → 藏著 **stain**(汙漬)
   - abstemious → 藏著 **steam**(清蒸)
   - abstinent → 藏著 **tin**(罐頭)
5. 一行講完,格式大致是 `鉤子→畫面→意思`。

## 使用者進度(localStorage)

| key | 用途 |
|---|---|
| `lgv_progress_v2` | 主要進度:看過的字、封存的字、currentDay、streak |
| `lgv_last_reset_backup_v1` | 重置前的自動快照(統計頁有「復原上次重置」) |
| `lgv_sync_v1` | GitHub Gist 跨裝置同步設定 |

**重要**:封存(archive)的字和背誦進度是分開存的,「重置」只能清背誦進度,**不可以連封存一起清掉** —— 這是修過的 bug,不要改回去。

## 部署流程

推上 `main` 就會自動部署。但有兩個**必踩的坑**:

### 1. 改完一定要把 `sw.js` 的 CACHE_NAME 版號 +1

```js
const CACHE_NAME = 'lgv-cache-v11';  // → 改成 v12
```

不改的話使用者手機會繼續吃舊快取,以為你沒改到。

(`install` 灌快取時已經改用 `new Request(u, {cache:'reload'})` 硬走網路。
之前是預設的 `cache.addAll(ASSETS)`,會走瀏覽器自己的 HTTP 快取 ——
版號跳了、新快取裡裝的卻還是舊檔案。不要改回去。)

### 2. GitHub Pages 有時候不會自動觸發 build

push 完要確認 build 真的跑了、而且跑的是你這個 commit:

```bash
gh api repos/LeoLiu0515/lilygre-vocab-app/pages/builds/latest --jq '.status + " " + .commit'
```

如果沒有你的 commit,手動觸發:

```bash
gh api -X POST repos/LeoLiu0515/lilygre-vocab-app/pages/builds
```

最後用**加隨機參數繞過 CDN 快取**的方式驗證真的上線了:

```bash
curl -s "https://leoliu0515.github.io/lilygre-vocab-app/sw.js?cb=$RANDOM" | head -1
```

## 本機預覽

任何靜態伺服器都行(service worker 需要 http://,不能用 file://)。例如:

```bash
python -m http.server 8000
```

測試時如果要重設進度,在瀏覽器 console 執行 `localStorage.removeItem('lgv_progress_v2')`。

## 慣例

- 介面文字一律**繁體中文**。
- 手機優先,設計時用 375×812 檢查。
- 沒有測試框架;改完請實際開瀏覽器點過主要流程再推。
