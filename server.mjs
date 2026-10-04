import express from "express";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { buildIndexes } from "./loadData.mjs";
import { analyze, splitWords, fold } from "./dictEngine.js";

/* ---------- Chọn nhà cung cấp AI bằng biến môi trường ----------
 * AI_PROVIDER = groq | openrouter | cerebras | gemini   (mặc định: groq)
 * AI_MODEL    = tên model (bỏ trống thì dùng mặc định bên dưới)
 * Key: GROQ_API_KEY | OPENROUTER_API_KEY | CEREBRAS_API_KEY | GEMINI_API_KEY
 *
 * Tên model và hạn mức miễn phí đổi thường xuyên: kiểm tra lại trên trang
 * của từng nhà cung cấp rồi đặt AI_MODEL cho đúng.
 * Groq, OpenRouter, Cerebras, và cả Gemini (qua đường /openai) đều dùng giao diện giống OpenAI.
 */
const PROVIDERS = {
  groq: {
    url: "https://api.groq.com/openai/v1/chat/completions",
    key: "GROQ_API_KEY",
    model: "llama-3.3-70b-versatile",
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/chat/completions",
    key: "OPENROUTER_API_KEY",
    model: "meta-llama/llama-3.3-70b-instruct:free",
  },
  cerebras: {
    url: "https://api.cerebras.ai/v1/chat/completions",
    key: "CEREBRAS_API_KEY",
    model: "llama-3.3-70b",
  },
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    key: "GEMINI_API_KEY",
    model: "gemini-2.5-flash",
  },
};

const providerName = (process.env.AI_PROVIDER || "groq").toLowerCase();
const provider = PROVIDERS[providerName];
if (!provider) {
  console.error(`AI_PROVIDER không hợp lệ: ${providerName}. Chọn: ${Object.keys(PROVIDERS).join(", ")}`);
  process.exit(1);
}
const apiKey = process.env[provider.key];
if (!apiKey) {
  console.error(`Thiếu ${provider.key}. Chạy: node --env-file=.env server.mjs`);
  process.exit(1);
}
const MODEL = process.env.AI_MODEL || provider.model;

async function callLLM(prompt) {
  const r = await fetch(provider.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    err.status = r.status;
    throw err;
  }
  const data = await r.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

/* ---------- Dữ liệu tra cứu ---------- */
const db = buildIndexes();

function similar(text, n = 5) {
  const q = new Set(splitWords(text).map(fold));
  return db.sentences
    .map((s) => ({ s, hit: splitWords(s.bana).filter((w) => q.has(fold(w))).length }))
    .filter((x) => x.hit > 0)
    .sort((a, b) => b.hit - a.hit)
    .slice(0, n)
    .map((x) => x.s);
}

/* ---------- Cache kết quả (theo câu đã chuẩn hóa) ---------- */
const CACHE_MAX = 2000;
const cache = new Map();
const cacheKey = (t) => splitWords(t).join(" ");
function cacheSet(k, v) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(k, v);
}

/* ---------- Giới hạn lượt mỗi IP (không cần thư viện) ---------- */
const LIMIT = Number(process.env.RATE_LIMIT_PER_HOUR || 30);
const hits = new Map(); // ip -> { n, reset }
function overLimit(ip) {
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || now > h.reset) h = { n: 0, reset: now + 3600_000 };
  h.n++;
  hits.set(ip, h);
  if (hits.size > 10000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
  return h.n > LIMIT;
}

/* ---------- Máy chủ ---------- */
const app = express();
app.set("trust proxy", 1); // sau proxy của Render/Railway để lấy đúng IP
app.use(express.json({ limit: "10kb" }));

// Chỉ phục vụ đúng index.html, KHÔNG phục vụ cả thư mục (tránh lộ .env, server.mjs)
const indexPath = fileURLToPath(new URL("./index.html", import.meta.url));
app.get("/", (req, res) => {
  if (!existsSync(indexPath)) return res.status(404).send("Chưa có index.html. Chạy: node build.mjs");
  res.sendFile(indexPath);
});

app.post("/api/translate", async (req, res) => {
  const text = String(req.body?.text ?? "").slice(0, 300);
  if (!text.trim()) return res.status(400).json({ error: "Thiếu nội dung" });

  const an = analyze(db.bv, text, "bv");
  const key = cacheKey(text);
  if (cache.has(key)) return res.json({ translation: cache.get(key), draft: an.draft, cached: true });

  if (overLimit(req.ip)) {
    return res.status(429).json({ error: "Bạn đã dùng hết lượt dịch AI trong giờ này, thử lại sau." });
  }

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
    if (translation) cacheSet(key, translation);
    res.json({ translation, draft: an.draft });
  } catch (e) {
    console.error(`[${providerName}]`, e.message);
    if (e.status === 429) {
      return res.status(429).json({ error: "Hôm nay hết lượt dịch AI, thử lại sau." });
    }
    res.status(502).json({ error: "Không gọi được dịch vụ AI" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server chạy tại http://localhost:${port} — AI: ${providerName} / ${MODEL}`));
