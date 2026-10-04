/* loadData.mjs — nạp vocab/sentences/patterns vào dictEngine.js
 * dictEngine cần rows dạng { bana, viet, example? }.
 * Dữ liệu JSON dùng { bahnar, vietnamese, note } nên cần chuyển đổi tại đây.
 */
import { readFileSync } from "node:fs";
import { buildIndex } from "./dictEngine.js";

const nfc = (s) => String(s ?? "").normalize("NFC").trim();
const readJson = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));

// Từ vựng -> rows
export function vocabRows(data = readJson("./vocab.json")) {
  const rows = [];
  for (const t of data.vocab_database)
    for (const w of t.words)
      rows.push({
        bana: nfc(w.bahnar),
        viet: nfc(w.vietnamese),
        type: w.type,
        page: w.note,
        topic: t.topic,
        kind: "vocab",
      });
  return rows;
}

// Câu -> rows (kèm id để tách test set)
export function sentenceRows(data = readJson("./sentences.json")) {
  const rows = [];
  let n = 0;
  for (const t of data.sentences_database)
    for (const s of t.sentences)
      rows.push({
        id: `S${String(++n).padStart(3, "0")}`,
        bana: nfc(s.bahnar),
        viet: nfc(s.vietnamese),
        page: s.note,
        topic: t.topic,
        kind: "sentence",
      });
  return rows;
}

// Mẫu câu -> danh sách phẳng (dùng cho RAG, không đưa vào index từ)
export function patternList(data = readJson("./patterns.json")) {
  return data.patterns_database.flatMap((c) =>
    c.patterns.map((p) => ({ ...p, category: c.category }))
  );
}

/* ---------- Gộp nhiều nguồn từ vựng ----------
 * Thứ tự quyết định nghĩa nào hiện đầu tiên trong bản dịch nháp:
 *   1. giáo trình (vocab.json)  — có số trang, ưu tiên cao nhất
 *   2. mẫu câu (patterns.json)  — một ít từ chức năng lấy từ phần "meaning" của mẫu câu
 *   3. bana_viet_dict.json      — từ điển lớn, không có số trang
 */

// Từ chức năng mà giáo trình ghi nghĩa rõ trong patterns.json (cột meaning / câu ví dụ).
// Đặt trước từ điển lớn để "păng" ra "và" thay vì "đốt, lóng".
const PATTERN_WORDS = [
  ["păng", "và", "PAT_05, Trang 40"],
  ["oěi", "ở", "PAT_06, Trang 35"],
  ["lờm", "trong", "PAT_06, Trang 35"],
  ["rim nar", "mỗi ngày", "PAT_02, Trang 32"],
  ["mă hơdrol xỡ", "trước đây", "PAT_03, Trang 129"],
  ["ră hơ'nhao dang ěi", "hiện nay", "PAT_04, Trang 129"],
  ["atŭm", "cùng nhau", "PAT_05, Trang 40"],
  ["ưh kơ", "không", "PAT_10, Trang 143"],
  ["ăn", "cho", "PAT_08, Trang 151"],
  ["jĭ", "là", "PAT_01, Trang 142"],
];

export function patternWordRows() {
  return PATTERN_WORDS.map(([bana, viet, page]) => ({
    bana: nfc(bana), viet: nfc(viet), page, src: "mẫu câu", kind: "vocab",
  }));
}

const dictKey = (s) => nfc(s).toLowerCase().replace(/\s+/g, " ");

// Từ điển lớn: chuẩn hóa NFC, bỏ khoảng trắng thừa và dấu "-" thừa ở cuối, bỏ dòng trùng hệt.
export function dictRows(path = "./bana_viet_dict.json") {
  let raw;
  try { raw = readJson(path); } catch { return []; }
  const seen = new Set();
  const rows = [];
  for (const r of raw) {
    const bana = nfc(r?.bana).replace(/\s+/g, " ");
    const viet = nfc(r?.viet).replace(/\s+/g, " ").replace(/\s*-\s*$/, "");
    if (!bana || !viet) continue;
    const k = dictKey(bana) + "|" + dictKey(viet);
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push({ bana, viet, src: "bana_viet_dict", kind: "vocab" });
  }
  return rows;
}

// Gộp 3 nguồn; bỏ dòng từ điển lớn nếu trùng hệt (cùng từ Bahnar, cùng nghĩa) với dòng đã có.
export function allVocabRows() {
  const base = vocabRows().map((r) => ({ ...r, src: "giáo trình" })).concat(patternWordRows());
  const seen = new Set(base.map((r) => dictKey(r.bana) + "|" + dictKey(r.viet)));
  const extra = dictRows().filter((r) => !seen.has(dictKey(r.bana) + "|" + dictKey(r.viet)));
  return base.concat(extra);
}

// Chiều Việt → Bahnar: tách "tìm / hái", "phân, cứt" thành từng nghĩa riêng,
// và thêm bản bỏ loại từ đứng đầu ("con trâu" -> "trâu") để tra "trâu" ra "kơpô".
const CLASSIFIERS = /^(con|cái|chiếc)\s+/i;
export function vbRowsOf(rows) {
  const out = [];
  for (const r of rows) {
    for (const part of r.viet.split(/\s*[\/,;]\s*/).map((s) => s.trim()).filter(Boolean)) {
      out.push({ ...r, viet: part });
      const bare = part.replace(CLASSIFIERS, "");
      if (bare !== part && bare) out.push({ ...r, viet: bare });
    }
  }
  return out;
}

/**
 * Xây chỉ mục tra cứu.
 * excludeIds: tập id câu bị loại (test set) để không rò rỉ vào RAG.
 * Chỉ nạp TỪ VỰNG vào index từ-điển; câu được tra riêng.
 */
export function buildIndexes({ excludeIds = new Set() } = {}) {
  const vocab = allVocabRows();
  const sentences = sentenceRows().filter((s) => !excludeIds.has(s.id));
  return {
    vocab,
    sentences,
    patterns: patternList(),
    bv: buildIndex(vocab, "bv"),
    vb: buildIndex(vbRowsOf(vocab), "vb"),
  };
}
