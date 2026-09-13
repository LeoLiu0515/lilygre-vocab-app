# LilyGRE 字根單字通勤機

一個離線可用的 GRE 單字 PWA,使用者在通勤時用手機背單字。介面全中文(繁體)。

- **線上網址**:https://leoliu0515.github.io/lilygre-vocab-app/
- **Repo**:https://github.com/LeoLiu0515/lilygre-vocab-app(GitHub Pages,`main` 分支根目錄)

## 檔案結構

純靜態,沒有 build step、沒有框架、沒有 npm。直接改檔案即可。

| 檔案 | 內容 |
|---|---|
| `index.html` | 4 個畫面(view-home / session / done / stats) |
| `style.css` | 深色編輯風格主題,金色強調色,襯線字體標題 |
| `app.js` | 所有邏輯(無模組) |
| `data.js` | `const VOCAB_DATA = [...]`,1738 個單字物件 |
| `sw.js` | Service Worker,離線快取 |
| `manifest.json`, `icon-*.png` | PWA 安裝設定 |

### 單字資料格式(`data.js`)

```js
{ num, root, root_gloss, word, mnemonic, meaning_zh[], meaning_en[], example[], synonyms[], day }
```

`day` 欄位還在(1–7)但**程式已經完全不看它** —— 整本就是一份 1738 字,依 `num` 順序背。

### 三分類 + 每日配額(取代了舊的「第幾天 / 第幾箱 SRS」)

- 每個字屬於三類之一,存在 `PROGRESS.words[num]`:`archived`=已會、`impress`=有印象、都沒有=還沒背。
  **`archived` 是舊的封存旗標,絕對不能改寫或搬移**(使用者說過 "can't afford 重新 archive")。
- `settings.showNew / showImpress / showKnown` 決定哪幾類會出現在單字卡。預設「已會」關著。
- 每日配額 raw = `cycleTarget ÷ 7`(cycleTarget 是輪次開始的 `quotaPool()` 快照)。
  輪次中途標分類不會讓 raw 跳動,只有換輪(`ensureCycle`)或切分類 toggle
  (`setSetting` 裡立刻重算 `cycleTarget = quotaPool()`)才變。
- **`todayStats().quota` 才是實際顯示/用的配額** = `min(raw, 已背 + 今天還抓得到的字)`。
  這一層很重要:整本快背完的時候,剩下的字可能不夠一天 raw 配額,如果不夾住,
  一批背光了進度條卻卡在一半、還跳「這回合完成」—— 這是修過的 bug,不要拿掉這個 min。
  正常情況(還有一大堆字)`todayStats().quota === raw`,不會亂跳。
- `finishSession` 只有 `done >= todayStats().quota` 才顯示「🎉 今天的份量完成了」,
  否則低調顯示「👍 這一批先到這」。`#done-title` / `#done-emoji` 由 JS 動態設定。
- **「今天」= 裝置本地時間凌晨 4 點才換日**,不是午夜。`todayStr()` = `Date.now() - 4h`
  再取本地日期。**不要寫死時區**(例如台灣 UTC+8)—— 試過一次,使用者人在國外時
  裝置時區跟台灣差了大半天,近七天那排圓圈整個錯位、星期幾對不上他實際背的
  那天,這是修過的 bug。
- 換日會自動觸發(`ensureDailyRollover()`,在 `renderHome()` / `startSession()` 呼叫):
  `dailySeen` 自動歸零、把剛結束那天的成績存進 `dailyHistory`。**只在回首頁 / 開始背單字
  時檢查**,不會在背卡背到一半時把畫面抽換掉(`renderCard`/`markSeenToday` 故意不呼叫它)。
  首頁「重設今日進度」按鈕還在,是手動提前開始下一天的選項,不是唯一的換日方式了。

### 首頁「近七天」

- `PROGRESS.dailyHistory`:`{ 'YYYY-MM-DD': {done, quota} }`,只留最近 30 天。
- `recordDailyHistory()` 在 `markSeenToday`(每背一個新字)和 `startNewDay`(歸零前)
  都會呼叫,所以就算使用者從來不按「重設」,前一天最後的樣子也留得住。
- `renderWeekStrip()`:近 7 天一排小圈,今天用 `todayStats()` 即時值,過去 6 天讀
  `dailyHistory`,沒紀錄的那天(沒開 app)就是空圈。達標(`done>=quota`)顯示打勾,
  沒達標顯示完成比例的弧,兩者都沒有的話代表那天完全沒背。
- 背卡頁右上角的齒輪面板 = 統計頁那幾個 toggle 的另一個入口,共用 `SETTING_SWITCHES` 清單。
- 卡片正反面的「有印象／已會」動作鈕置底置中(`.action-stack`),兩隻手單手都按得到,**不要**改回貼單邊或加左右手設定 —— 這是使用者明確要求拿掉的功能。

### 首頁圓環 + 背卡頁頂端進度條 = 今日份的進度

- 兩個都是 `todayStats()`:今日已背(`dailySeen.length`)/ 今天配額(`dailyQuota()`)。
- **整份進度**只在首頁那一小條(`home-breakdown`)= `bookProgress()`:看過的「最後一個字」
  在「toggle 開著的所有單字」裡排第幾(照 num / A→Z 順序),只往前不倒退。
  使用者明確要求整份進度只要小小顯示,不要當主視覺。
- `overallStats()`(已會/有印象/還沒背的終身統計)只用在統計頁四宮格。
- 「輪次」(`cycleStart` / `cycleTarget` / `ensureCycle`)還在,但**只剩配額重分配**這一個
  用途:每 7 天用當下 `quotaPool()` 快照重算 `cycleTarget`,`dailyQuota = cycleTarget ÷ 7`。
  沒有任何 UI 顯示輪次。

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
| `lgv_progress_v2` | 主要進度:`words`(每字的 archived/impress/seen)、`settings`、`dailySeen`、`streak` |
| `lgv_last_reset_backup_v1` | 重置前的自動快照(統計頁有「復原上次重置」) |
| `lgv_sync_v1` | GitHub Gist 跨裝置同步設定 |

**重要**:分類(archived / impress)和背誦進度是分開存的,「重置背誦進度」只清 seen/box 那些,**分類完全不動** —— 這是修過的 bug,不要改回去。

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
