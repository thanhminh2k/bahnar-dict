/* build.mjs — tạo public/index.html (một file, nhúng sẵn engine và dữ liệu)
 * Chạy: node build.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { allVocabRows, sentenceRows, patternList } from "./loadData.mjs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// Engine là ES module; bỏ "export" để nhúng vào <script> thường
const engine = read("./dictEngine.js").replace(/^export\s+/gm, "");

const data = {
  // chỉ giữ các trường cần cho giao diện để file nhẹ hơn
  vocab: allVocabRows().map((r) => ({ bana: r.bana, viet: r.viet, ...(r.example ? { example: r.example } : {}) })),
  sentences: sentenceRows().map((s) => ({ id: s.id, bana: s.bana, viet: s.viet, page: s.page })),
  patterns: patternList(),
};

// tránh "</script>" và ký tự phân cách dòng làm hỏng thẻ script
const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

const html = read("./page.template.html")
  .replace("/*__ENGINE__*/", () => engine.replace(/<\/script/gi, "<\\/script"))
  .replace("/*__DATA__*/", () => json);

mkdirSync(new URL("./public", import.meta.url), { recursive: true });
writeFileSync(new URL("./public/index.html", import.meta.url), html);
console.log(`Đã tạo public/index.html (${(html.length / 1024).toFixed(0)} KB): ${data.vocab.length} mục từ, ${data.sentences.length} câu, ${data.patterns.length} mẫu câu`);
