/* =========================================================================
 * dictEngine.js — Lõi tìm kiếm của từ điển Bahnar–Việt
 * Module thuần (không phụ thuộc React) nên có thể test độc lập.
 *
 * Khả năng chính:
 *  - Tra không dấu / sai dấu  (fold + chỉ mục theo dạng bỏ dấu)
 *  - Ghép cụm dài nhất trước, rồi dịch từng từ (forward maximum matching)
 *  - Gợi ý khi gõ sai chính tả (khoảng cách Levenshtein có giới hạn)
 *  - Tô sáng đúng vị trí kể cả khi người dùng gõ không dấu
 *  - Sinh câu hỏi trắc nghiệm và "từ của ngày"
 * ======================================================================= */

/* ---------- Cấu hình (chỉnh ở đây) ---------- */

// Loại từ / hư từ tiếng Việt thường không có từ tương ứng trong tiếng Bahnar
// (ví dụ "con" trong "con heo"). Chúng vẫn được tra nhưng bị làm mờ,
// không đưa vào bản ghép và không làm nhiễu danh sách kết quả.
export const LOOSE_WORDS = {
  vb: new Set(["con", "cái", "chiếc", "những", "các", "một", "mấy", "cây", "quả", "trái"]),
  bv: new Set(),
};

// Số từ tối đa của một cụm khi ghép (ví dụ "cây lúa nước" = 3)
export const MAX_PHRASE_WORDS = 6;

/* ---------- Chuẩn hoá chuỗi ---------- */

const SEPARATORS = /[\s,;.!?:()"“”/\\|]+/;
const MARKS = /[\u0300-\u036f]/g;

// Bỏ dấu, không cắt khoảng trắng (dùng được cho từng ký tự)
function foldRaw(s) {
  return s.normalize("NFC").toLowerCase().normalize("NFD").replace(MARKS, "").replace(/đ/g, "d");
}

// NFC + chữ thường: tránh lỗi "gõ đúng mà không khớp" do dấu tổ hợp / dựng sẵn
export function normalize(s) {
  return String(s ?? "").normalize("NFC").toLowerCase().trim();
}

// Dạng không dấu: "Cây lúa" -> "cay lua", "đường" -> "duong"
export function fold(s) {
  return foldRaw(String(s ?? "")).trim();
}

// Tách câu thành danh sách từ THEO ĐÚNG THỨ TỰ (giữ cả từ lặp)
export function splitWords(s) {
  return normalize(s).split(SEPARATORS).filter(Boolean);
}

// Tách một đoạn nhập thành nhiều CÂU theo dấu chấm ".", để mỗi câu được
// tra/ghép/chấm điểm độc lập — tránh việc "Tôi đi học. Bạn đi làm." bị
// gộp thành một chuỗi từ duy nhất (splitWords() coi "." là separator nên
// không giữ được ranh giới câu).
// Chỉ tách theo "." ở bước này; "?" và "!" vẫn được splitWords() coi như
// separator bên trong câu như trước — có thể mở rộng sau mà không đổi
// kiến trúc (xem analyzeSentence()/analyze() bên dưới).
export function splitSentences(s) {
  return String(s ?? "")
    .normalize("NFC")
    .split(/\.+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

// Như splitWords nhưng GIỮ NGUYÊN hoa/thường — dùng để nhận diện danh từ
// riêng (viết hoa) trước khi normalize() làm mất thông tin đó.
function splitRawWords(s) {
  return String(s ?? "").normalize("NFC").trim().split(SEPARATORS).filter(Boolean);
}

// Từ viết hoa chữ cái đầu và không nằm ở đầu câu -> nhiều khả năng là danh
// từ riêng (tên người, địa danh...). Bỏ qua vị trí đầu câu vì tiếng Việt
// luôn viết hoa chữ đầu câu bất kể đó có phải tên riêng hay không.
function looksLikeProperNoun(rawWord, isFirst) {
  return !isFirst && /^\p{Lu}/u.test(rawWord ?? "");
}

export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ---------- Xây chỉ mục ---------- */

/**
 * rows: [{ bana, viet, example? }]
 * direction: "bv" (Bahnar → Việt) hoặc "vb" (Việt → Bahnar)
 *
 * Trả về:
 *  - map:    khoá chuẩn hoá (có dấu) → nhóm mục từ
 *  - byFold: khoá không dấu → mảng các nhóm (các biến thể dấu)
 *  - maxLen: số từ của cụm dài nhất trong từ điển (bị chặn bởi MAX_PHRASE_WORDS)
 */
export function buildIndex(rows, direction) {
  const map = new Map();
  for (const row of rows) {
    const src = direction === "bv" ? row.bana : row.viet;
    const tgt = direction === "bv" ? row.viet : row.bana;
    const words = splitWords(src);
    const key = words.join(" ");
    if (!key || !tgt) continue;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        display: String(src).trim(),
        words,
        fkey: fold(key),
        fwords: words.map(fold),
        meanings: [],
        examples: [],
      };
      map.set(key, g);
    }
    if (!g.meanings.includes(tgt)) g.meanings.push(tgt);
    if (row.example && !g.examples.includes(row.example)) g.examples.push(row.example);
  }

  const byFold = new Map();
  let maxLen = 1;
  for (const g of map.values()) {
    if (!byFold.has(g.fkey)) byFold.set(g.fkey, []);
    byFold.get(g.fkey).push(g);
    maxLen = Math.max(maxLen, g.words.length);
  }
  return { map, byFold, maxLen: Math.min(maxLen, MAX_PHRASE_WORDS) };
}

/* ---------- Tra một cụm ---------- */

/**
 * - Gõ CÓ dấu và khớp đúng  → chỉ lấy mục đó ("gà" không kéo theo "ga").
 * - Gõ KHÔNG dấu           → lấy mọi biến thể ("ga" → ga, gà, gả…), mục khớp đúng lên trước.
 * - Gõ có dấu nhưng sai     → lấy các biến thể cùng dạng không dấu.
 * - opts.strict: khi nghi ngờ đây là danh từ riêng (viết hoa giữa câu),
 *   KHÔNG rơi về các biến thể cùng dạng bỏ dấu nếu không có khớp đúng dấu —
 *   tránh đoán nhầm tên riêng thành một từ thường trùng dạng bỏ dấu
 *   (ví dụ "Minh" bị đoán thành "mình").
 */
export function lookup(index, cand, opts = {}) {
  const strict = !!opts.strict;
  const variants = index.byFold.get(fold(cand)) ?? [];
  if (variants.length === 0) return [];
  const exact = index.map.get(cand);
  if (exact && fold(cand) !== cand) return [exact];
  if (exact) return [exact, ...variants.filter((v) => v !== exact)];
  if (strict) return [];
  return variants;
}

/* ---------- Chấm điểm ---------- */

/**
 * Chấm điểm một nhóm so với câu tìm kiếm (đã bỏ dấu).
 * Khớp nguyên cụm > từng từ (nguyên từ > bắt đầu bằng > chứa).
 * Mục khớp đủ mọi từ khoá được cộng thêm.
 */
/**
 * tokensRaw (tuỳ chọn): dạng CÓ dấu thật của từng phần tử trong `ftokens`,
 * cùng thứ tự. Dùng để biết người dùng có thực sự gõ dấu hay không:
 *  - Nếu từ người dùng gõ vốn KHÔNG dấu (vd gõ "toi"), việc so khớp trên
 *    dạng bỏ dấu là đúng ý — giữ nguyên hành vi "tra không dấu" như cũ.
 *  - Nếu từ người dùng gõ CÓ dấu (vd gõ "tôi", "là"), thì so khớp bằng
 *    dạng bỏ dấu sẽ gây nhầm với những từ khác dấu nhưng cùng phụ âm/nguyên
 *    âm gốc (vd "tôi" trùng "tới", "là" trùng "lăng") — trường hợp này bắt
 *    buộc phải so khớp trên dạng CÓ dấu thật, không rơi về dạng bỏ dấu nữa.
 * Không truyền tokensRaw (như suggest() gọi để bắt lỗi chính tả) thì giữ
 * nguyên hành vi khoan dung cũ.
 */
/**
 * Chấm điểm theo TẦNG rõ ràng, mỗi tầng cách nhau đủ xa để không bao giờ bị
 * lẫn bởi điểm cộng dồn của phần khớp từng từ bên dưới:
 *
 *   1. Khớp chính xác CÓ dấu   (g.key === phrase)        → 100000
 *   2. Khớp chính xác KHÔNG dấu (g.fkey === fphrase)      →  80000
 *   3. Bắt đầu bằng cụm (không dấu)                        →  60000
 *   4. Chứa cụm (không dấu)                                →  40000
 *
 * Nhờ vậy "chào" (tầng 1) luôn đứng trước "cháo" (tầng 2) khi người dùng gõ
 * đúng dấu "chào"; còn gõ không dấu "chao" thì cả hai cùng tầng 2 và được
 * xếp tiếp theo các tiêu chí phụ (độ dài, alphabet) như cũ.
 *
 * `phrase` (có dấu, đã normalize) là tuỳ chọn — suggest() không truyền vì
 * nó vốn đã làm việc trên dạng bỏ dấu (bắt lỗi chính tả), lúc đó tầng 1/2
 * gộp làm một như hành vi cũ.
 */
export function scoreEntry(g, fphrase, ftokens, tokensRaw = null, phrase = null) {
  if (!fphrase) return 0;
  let score = 0;
  if (phrase != null && g.key === phrase) score += 100000;
  else if (g.fkey === fphrase) score += 80000;
  else if (g.fkey.startsWith(fphrase)) score += 60000;
  else if (g.fkey.includes(fphrase)) score += 40000;

  let matched = 0;
  for (let ti = 0; ti < ftokens.length; ti++) {
    const t = ftokens[ti];
    const raw = tokensRaw ? tokensRaw[ti] : null;
    const tIsPlain = raw == null || fold(raw) === raw;
    let best = 0;
    for (let wi = 0; wi < g.fwords.length; wi++) {
      const w = g.fwords[wi];
      if (w === t) {
        if (tIsPlain || g.words[wi] === raw) {
          best = 100;
          break;
        }
        // Trùng dạng bỏ dấu nhưng khác dấu thực (vd "tôi" ↔ "tới") — không
        // tính điểm cho trường hợp này nữa, tránh nhiễu kết quả.
        continue;
      }
      // Từ 1 ký tự chỉ được khớp nguyên từ, tránh ra quá nhiều kết quả nhiễu
      if (t.length >= 2) {
        if (tIsPlain) {
          if (w.startsWith(t)) best = Math.max(best, 60);
          else if (w.includes(t)) best = Math.max(best, 30);
        } else if (raw.length >= 2) {
          // Có dấu: chỉ so khớp tiền tố/chứa trên dạng CÓ dấu thật.
          const rw = g.words[wi];
          if (rw.startsWith(raw)) best = Math.max(best, 60);
          else if (rw.includes(raw)) best = Math.max(best, 30);
        }
      }
    }
    if (best > 0) {
      matched++;
      score += best;
    }
  }
  if (ftokens.length > 1 && matched === ftokens.length) score += 150;
  return score + matched * 20;
}

/* ---------- Gợi ý khi gõ sai ---------- */

// Levenshtein có giới hạn: dừng sớm khi chắc chắn vượt quá `max`
export function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Gợi ý cho một từ không tra được: mục bắt đầu/chứa từ đó, rồi mục gần giống chính tả
export function suggest(index, token, limit = 3) {
  const t = fold(token);
  if (!t) return [];

  const scored = [];
  for (const g of index.map.values()) {
    const s = scoreEntry(g, t, [t]);
    if (s > 0) scored.push({ g, s });
  }
  scored.sort((a, b) => b.s - a.s || a.g.key.length - b.g.key.length || a.g.key.localeCompare(b.g.key));
  const out = scored.slice(0, limit).map((x) => x.g);

  const max = t.length <= 3 ? 0 : t.length <= 6 ? 1 : 2;
  if (out.length < limit && max > 0) {
    const near = [];
    for (const [fk, groups] of index.byFold) {
      if (fk.includes(" ")) continue;
      const d = editDistance(t, fk, max);
      if (d <= max) near.push({ groups, d });
    }
    near.sort((a, b) => a.d - b.d);
    for (const n of near) {
      for (const g of n.groups) {
        if (out.length < limit && !out.includes(g)) out.push(g);
      }
    }
  }
  return out;
}

/* ---------- Ghép cụm dài nhất (dịch từng từ) ---------- */

/**
 * "con heo": thử "con heo" → nếu không có thì thử "con", rồi "heo".
 * Mỗi đoạn: { text, entries, len, start }. entries rỗng = không tra được.
 * `properFlags[i]` = true nếu từ ở vị trí i (trong `words`, đã chuẩn hoá)
 * nghi là danh từ riêng — chỉ áp dụng strict khi thử khớp ĐÚNG một mình nó.
 */
export function segment(words, index, properFlags = []) {
  const segs = [];
  let i = 0;
  while (i < words.length) {
    let hit = null;
    for (let len = Math.min(index.maxLen, words.length - i); len >= 1; len--) {
      const text = words.slice(i, i + len).join(" ");
      const strict = len === 1 && !!properFlags[i];
      const entries = lookup(index, text, { strict });
      if (entries.length > 0) {
        hit = { text, entries, len, start: i };
        break;
      }
    }
    if (hit) {
      segs.push(hit);
      i += hit.len;
    } else {
      segs.push({ text: words[i], entries: [], len: 1, start: i });
      i += 1;
    }
  }
  return segs;
}

/* ---------- Phân tích trọn vẹn MỘT câu tra ---------- */

// Toàn bộ logic phân tích cũ của analyze(), thu hẹp lại thành một câu
// (query ở đây được đảm bảo không còn chứa "." nhờ splitSentences() gọi
// từ analyze() bên dưới). Không tự gọi splitSentences() ở đây để có thể
// dùng lại analyzeSentence() độc lập khi cần (ví dụ test).
export function analyzeSentence(index, query, direction) {
  const words = splitWords(query);
  if (words.length === 0) {
    return { text: query, words, phrase: "", terms: [], results: [], segments: [], draft: "" };
  }

  // Từ gốc còn giữ hoa/thường, dùng để nhận diện danh từ riêng trước khi
  // normalize() làm mất thông tin đó. Vị trí i=0 (đầu câu) luôn bị loại vì
  // tiếng Việt viết hoa đầu câu không kể có phải tên riêng hay không.
  const rawWords = splitRawWords(query);
  const properFlags = words.map((_, i) => looksLikeProperNoun(rawWords[i], i === 0));

  const phrase = words.join(" ");
  const fphrase = fold(phrase);
  const plain = fphrase === phrase; // cả câu không có dấu
  const loose = LOOSE_WORDS[direction] ?? new Set();
  const looseFolded = new Set([...loose].map(fold));
  // Nếu gõ không dấu thì "cai"/"con" vẫn được coi là loại từ
  const isLoose = (w) => loose.has(w) || (plain && looseFolded.has(w));

  const uniq = [...new Set(words)];
  const content = uniq.filter((w) => !isLoose(w));
  const srcTokens = content.length > 0 ? content : uniq;

  // Giữ cặp (dạng bỏ dấu → dạng có dấu thật người dùng đã gõ) để
  // scoreEntry() biết có nên rơi về so khớp bỏ dấu hay không (xem
  // scoreEntry() ở trên).
  const tokenSeen = new Map();
  for (const w of srcTokens) {
    const f = fold(w);
    if (!tokenSeen.has(f)) tokenSeen.set(f, w);
  }
  const ftokens = [...tokenSeen.keys()];
  const tokensRaw = [...tokenSeen.values()];

  const terms = [...new Set([fphrase, ...ftokens.filter((t) => t.length >= 2)])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  // Danh sách mục từ liên quan
  const scored = [];
  for (const g of index.map.values()) {
    const s = scoreEntry(g, fphrase, ftokens, tokensRaw, phrase);
    if (s > 0) scored.push({ g, s });
  }
  scored.sort((a, b) => b.s - a.s || a.g.key.length - b.g.key.length || a.g.key.localeCompare(b.g.key));

  // Chỉ hiển thị các mục "sát" mục khớp tốt nhất — bỏ bớt đuôi dài các gợi ý
  // yếu, không còn liên quan trực tiếp đến câu tra.
  const RESULT_RELATIVE_THRESHOLD = 0.9;
  const topScore = scored.length > 0 ? scored[0].s : 0;
  const relevant = topScore > 0 ? scored.filter((x) => x.s >= topScore * RESULT_RELATIVE_THRESHOLD) : scored;
  const results = relevant.slice(0, 60).map((x) => x.g);

  // Dịch từng từ
  const raw = segment(words, index, properFlags);
  const hasContent = raw.some((s) => !isLoose(s.text));
  const segments = raw.map((s) => ({
    ...s,
    loose: hasContent && isLoose(s.text),
    suggestions: s.entries.length > 0 ? [] : suggest(index, s.text),
  }));
  const draft = segments
    .filter((s) => !s.loose)
    .map((s) => (s.entries.length > 0 ? s.entries[0].meanings[0] : `[${s.text}]`))
    .join(" ");

  return { text: query, words, phrase, terms, results, segments, draft };
}

/**
 * Bộ điều phối: tách `query` thành nhiều CÂU (theo dấu ".") rồi phân tích
 * riêng từng câu bằng analyzeSentence(), để kết quả tra/ghép/ranking của
 * câu này không bị trộn với câu kia (xem lỗi mô tả ở đầu file).
 *
 * `sentences` là dữ liệu chính, nên dùng cho UI mới (mỗi câu một khối).
 * Các field phẳng (words/phrase/terms/results/segments/draft) được GIỮ LẠI
 * chỉ để tương thích ngược với UI hiện tại (đang đọc analysis.results,
 * analysis.segments... như một câu duy nhất) — sẽ bỏ dần khi UI chuyển
 * sang render theo `sentences`. Lưu ý: `segments[].start` là chỉ số TRONG
 * từng câu, không phải chỉ số toàn cục trong `words` đã gộp — replaceWord()
 * ở UI cần được sửa để nhận thêm sentenceIndex trước khi dựa vào field này
 * cho câu nhiều-hơn-một-mệnh-đề.
 */
export function analyze(index, query, direction) {
  const sentences = splitSentences(query);
  if (sentences.length === 0) {
    return { sentences: [], words: [], phrase: "", terms: [], results: [], segments: [], draft: "" };
  }

  const sentenceAnalyses = sentences.map((sentence) => analyzeSentence(index, sentence, direction));

  return {
    sentences: sentenceAnalyses,

    // ---- Field phẳng để tương thích ngược (tạm thời) ----
    words: sentenceAnalyses.flatMap((s) => s.words),
    phrase: sentenceAnalyses.map((s) => s.phrase).join(". "),
    terms: [...new Set(sentenceAnalyses.flatMap((s) => s.terms))],
    results: sentenceAnalyses.flatMap((s) => s.results),
    segments: sentenceAnalyses.flatMap((s) => s.segments),
    draft: sentenceAnalyses
      .map((s) => s.draft)
      .filter(Boolean)
      .join(". "),
  };
}

/* ---------- Tô sáng ---------- */

/**
 * Tô sáng trên văn bản GỐC dù từ khoá đã bỏ dấu.
 * Trả về [{ text, hit }]. `fterms` phải là dạng đã bỏ dấu (analyze().terms).
 */
export function highlightParts(text, fterms) {
  const chars = Array.from(String(text ?? "").normalize("NFC"));
  const terms = (fterms || []).filter(Boolean);
  if (terms.length === 0) return [{ text: chars.join(""), hit: false }];

  let folded = "";
  const map = []; // vị trí trong chuỗi đã bỏ dấu → chỉ số ký tự gốc
  chars.forEach((ch, i) => {
    const piece = foldRaw(ch);
    for (let k = 0; k < piece.length; k++) map.push(i);
    folded += piece;
  });

  const re = new RegExp(
    [...terms].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|"),
    "g"
  );
  const hitChar = new Array(chars.length).fill(false);
  let m;
  while ((m = re.exec(folded)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    for (let j = map[m.index]; j <= map[m.index + m[0].length - 1]; j++) hitChar[j] = true;
  }
  // Dấu tổ hợp đứng riêng đi theo ký tự đứng trước
  chars.forEach((ch, i) => {
    if (i > 0 && foldRaw(ch) === "") hitChar[i] = hitChar[i - 1];
  });

  const parts = [];
  chars.forEach((ch, i) => {
    const last = parts[parts.length - 1];
    if (last && last.hit === hitChar[i]) last.text += ch;
    else parts.push({ text: ch, hit: hitChar[i] });
  });
  return parts;
}

/* ---------- Luyện tập & từ của ngày ---------- */

// Chỉ dùng các mục ngắn gọn cho câu hỏi trắc nghiệm / từ của ngày
export function isQuizable(g) {
  return (
    g.meanings.length > 0 &&
    g.meanings[0].length <= 40 &&
    g.display.length <= 40 &&
    g.words.length <= 3
  );
}

// Từ của ngày: cố định trong một ngày, đổi vào ngày hôm sau
export function wordOfTheDay(index, date = new Date()) {
  const pool = [...index.map.values()].filter(isQuizable);
  if (pool.length === 0) return null;
  const day = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
  return pool[(day * 7919) % pool.length];
}

/**
 * Câu hỏi trắc nghiệm: `source` là nhóm để hỏi, `pool` là nguồn lấy đáp án nhiễu.
 * Trả về null nếu không đủ dữ liệu.
 */
export function makeQuestion(source, pool, rng = Math.random, nOptions = 4) {
  if (source.length === 0 || pool.length < nOptions) return null;
  const g = source[Math.floor(rng() * source.length)];
  const correct = g.meanings[0];
  const options = [correct];
  let guard = 0;
  while (options.length < nOptions && guard++ < 300) {
    const d = pool[Math.floor(rng() * pool.length)].meanings[0];
    // không chọn đáp án nhiễu trùng nghĩa với đáp án đúng
    if (!options.includes(d) && !g.meanings.includes(d)) options.push(d);
  }
  if (options.length < nOptions) return null;
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  return { group: g, prompt: g.display, correct, options };
}
