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
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", key: "GROQ_API_KEY", model: "llama-3.3-70b-versatile" },
  openrouter: { url: "https://openrouter.ai/api/v1/chat/completions", key: "OPENROUTER_API_KEY", model: "meta-llama/llama-3.3-70b-instruct:free" },
  cerebras: { url: "https://api.cerebras.ai/v1/chat/completions", key: "CEREBRAS_API_KEY", model: "llama-3.3-70b" },
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", key: "GEMINI_API_KEY", model: "gemini-2.5-flash" },
};

const providerName = (process.env.AI_PROVIDER || "groq").toLowerCase();
const provider = PROVIDERS[providerName];
const MODEL = process.env.AI_MODEL || provider?.model;

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

function similar(text, n = 5) {
  const q = new Set(splitWords(text).map(fold));
  return getDb()
    .sentences.map((s) => ({ s, hit: splitWords(s.bana).filter((w) => q.has(fold(w))).length }))
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
  if (req.method !== "POST") return res.status(405).json({ error: "Chỉ hỗ trợ POST" });
  if (!provider) return res.status(500).json({ error: "Cấu hình AI_PROVIDER không hợp lệ" });
  if (!process.env[provider.key]) return res.status(500).json({ error: `Thiếu ${provider.key} trên máy chủ` });

  const text = String(req.body?.text ?? "").slice(0, 300);
  if (!text.trim()) return res.status(400).json({ error: "Thiếu nội dung" });

  const an = analyze(getDb().bv, text, "bv");
  const key = splitWords(text).join(" ");
  if (cache.has(key)) return res.json({ translation: cache.get(key), draft: an.draft, cached: true });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (overLimit(ip)) return res.status(429).json({ error: "Bạn đã dùng hết lượt dịch AI trong giờ này, thử lại sau." });

  const words = an.segments
    .filter((s) => s.entries[0])
    .map((s) => `${s.text} = ${s.entries[0].meanings.slice(0, 3).join("; ")}`)
    .join("\n");
  const examples = similar(text).map((s) => `${s.bana} => ${s.viet}`).join("\n");

  const prompt = `Dịch câu tiếng Bahnar sang tiếng Việt. Chỉ dựa vào từ điển và câu mẫu bên dưới.
Một từ có thể có vài nghĩa, hãy chọn nghĩa hợp với cả câu và với các câu mẫu.
Từ nào không có trong đó thì giữ nguyên và ghi [?]. Không bịa nghĩa.

Từ điển:
${words || "(không có)"}

Câu mẫu:
${examples || "(không có)"}

Câu cần dịch: ${text}
Chỉ trả về bản dịch tiếng Việt.`;

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
