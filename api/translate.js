import { buildIndexes } from "../loadData.mjs";
import { analyze, splitWords, fold } from "../dictEngine.js";

/* Vercel Serverless Function: POST /api/translate
 * Biến môi trường (đặt trong Vercel → Settings → Environment Variables):
 *   AI_PROVIDER = groq | openrouter | cerebras | gemini   (mặc định groq)
 *   AI_MODEL    = tên model (tuỳ chọn)
 *   GROQ_API_KEY | OPENROUTER_API_KEY | CEREBRAS_API_KEY | GEMINI_API_KEY
 *   RATE_LIMIT_PER_HOUR = số lượt/IP/giờ (mặc định 30)
 */
const PROVIDERS = {
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", key: "GROQ_API_KEY", model: "openai/gpt-oss-120b" },
  openrouter: { url: "https://openrouter.ai/api/v1/chat/completions", key: "OPENROUTER_API_KEY", model: "meta-llama/llama-3.3-70b-instruct:free" },
  cerebras: { url: "https://api.cerebras.ai/v1/chat/completions", key: "CEREBRAS_API_KEY", model: "llama-3.3-70b" },
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", key: "GEMINI_API_KEY", model: "gemini-2.5-flash" },
};

const providerName = (process.env.AI_PROVIDER || "groq").toLowerCase();
const provider = PROVIDERS[providerName];
const MODEL =
  process.env[`${providerName.toUpperCase()}_MODEL`] ||
  process.env.AI_MODEL ||
  provider?.model;

async function callLLM(prompt) {
  const r = await fetch(provider.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env[provider.key]}` },
    body: JSON.stringify({ model: MODEL, temperature: 0.2, messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    err.status = r.status;
    throw err;
  }
  const data = await r.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

// Nạp dữ liệu một lần cho mỗi instance (các lần gọi sau trên instance "ấm" dùng lại)
let db;
const getDb = () => (db ??= buildIndexes());

function similar(text, direction, n = 5) {
  const q = new Set(splitWords(text).map(fold));
  return getDb()
    .sentences.map((s) => {
      const source = direction === "vb" ? s.viet : s.bana;
      return { s, source, hit: splitWords(source).filter((w) => q.has(fold(w))).length };
    })
    .filter((x) => x.hit > 0)
    .sort((a, b) => b.hit - a.hit)
    .slice(0, n)
    .map((x) => x.s);
}

// Cache và giới hạn lượt trong bộ nhớ: chỉ có tác dụng TRONG MỘT instance,
// instance mới hoặc khởi động lại là mất. Chỉ là lớp giảm tải cơ bản.
const cache = new Map();
const hits = new Map();
const LIMIT = Number(process.env.RATE_LIMIT_PER_HOUR || 30);
function overLimit(ip) {
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || now > h.reset) h = { n: 0, reset: now + 3600_000 };
  h.n++;
  hits.set(ip, h);
  return h.n > LIMIT;
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin === "*" ? "*" : origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Chỉ hỗ trợ POST" });
  if (!provider) return res.status(500).json({ error: "Cấu hình AI_PROVIDER không hợp lệ" });
  if (!process.env[provider.key]) return res.status(500).json({ error: `Thiếu ${provider.key} trên máy chủ` });

  const text = String(req.body?.text ?? "").slice(0, 300);
  if (!text.trim()) return res.status(400).json({ error: "Thiếu nội dung" });

  const direction = req.body?.direction === "vb" ? "vb" : "bv";
  const sourceLanguage = direction === "vb" ? "tiếng Việt" : "tiếng Bahnar";
  const targetLanguage = direction === "vb" ? "tiếng Bahnar" : "tiếng Việt";
  const an = analyze(getDb()[direction], text, direction);
  const key = `${direction}:${splitWords(text).join(" ")}`;
  if (cache.has(key)) return res.json({ translation: cache.get(key), draft: an.draft, cached: true });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (overLimit(ip)) return res.status(429).json({ error: "Bạn đã dùng hết lượt dịch AI trong giờ này, thử lại sau." });

  const words = an.segments
    .filter((s) => s.entries[0])
    .map((s) => `${s.text} = ${s.entries[0].meanings.slice(0, 3).join("; ")}`)
    .join("\n");
  const examples = similar(text, direction)
    .map((s) => direction === "vb" ? `${s.viet} => ${s.bana}` : `${s.bana} => ${s.viet}`)
    .join("\n");

  // Từ chưa tra được + gợi ý gần giống (nếu có), để AI chọn từ thay thế
const unknown = an.segments
  .filter((s) => !s.loose && s.entries.length === 0)
  .map((s) => {
    const sug = s.suggestions
      .map((g) => `${g.display} = ${g.meanings.slice(0, 2).join("; ")}`)
      .join(" | ");
    return `${s.text} → ${sug || "(không có gợi ý)"}`;
  })
  .join("\n");

const prompt = `Dịch câu ${sourceLanguage} sang ${targetLanguage}. Chỉ dựa vào từ điển, câu mẫu và gợi ý bên dưới.

Quy tắc:
1. Một từ có thể có vài nghĩa, hãy chọn nghĩa hợp với cả câu và các câu mẫu.
2. Với từ không có trong từ điển, xử lý theo thứ tự:
   a. Thay bằng từ có nghĩa gần nhất mà từ điển, câu mẫu hoặc mục "Từ chưa tra được" đã có (đồng nghĩa hoặc gần nghĩa).
   b. Nếu không có từ nào gần nghĩa, mà bỏ từ đó đi vẫn giữ nguyên ý câu (loại từ, từ đệm, từ nhấn mạnh như "rất", "những", "các", "con", "cái"), thì bỏ qua từ đó.
   c. Nếu từ đó quan trọng, không thể thay hay bỏ, thì giữ nguyên từ gốc tại chỗ đó.
3. Khi dịch sang tiếng Bahnar, chỉ dùng từ Bahnar có trong từ điển hoặc câu mẫu, không tự tạo từ Bahnar mới.
4. Không dùng dấu [?], dấu ngoặc, ghi chú hay giải thích.

Từ điển:
${words || "(không có)"}

Từ chưa tra được (kèm gợi ý gần giống):
${unknown || "(không có)"}

Câu mẫu:
${examples || "(không có)"}

Câu cần dịch: ${text}
Chỉ trả về bản dịch ${targetLanguage}, không thêm gì khác.`;

  try {
    const translation = await callLLM(prompt);
    if (translation) {
      if (cache.size >= 500) cache.delete(cache.keys().next().value);
      cache.set(key, translation);
    }
    res.json({ translation, draft: an.draft });
  } catch (e) {
    console.error(`[${providerName}]`, e.message);
    if (e.status === 429) return res.status(429).json({ error: "Hôm nay hết lượt dịch AI, thử lại sau." });
    res.status(502).json({ error: "Không gọi được dịch vụ AI" });
  }
}
