/**
 * A tiny OpenAI-compatible mock server for local development.
 *
 * Run it in a second terminal:
 *   npm run mock            (http://127.0.0.1:8788)
 *
 * Then point your .dev.vars at it:
 *   MUSE_API_ENDPOINT=http://127.0.0.1:8788/v1
 *   MUSE_API_KEY=test-key-123
 *
 * Tips:
 *   - Include "JSON_MODE" in a message to get a non-streaming JSON response
 *     (tests the worker's fallback path).
 *   - Any other Authorization than "Bearer test-key-123" gets a 401.
 */
import http from "node:http";

const PORT = Number(process.argv[2] || process.env.MOCK_PORT || 8788);
const API_KEY = "test-key-123";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildReply(userText) {
  return [
    `You said: **${userText}**`,
    "",
    "Here is a quick demo of the streaming UI:",
    "",
    "```python",
    "def greet(name):",
    '    return f"Hello, {name}!"',
    "",
    "print(greet('Muse'))",
    "```",
    "",
    "- Responses render *markdown* and `inline code`",
    "- Tokens arrive in real time over SSE",
    "- Press the stop button to interrupt me",
    "",
    "Ask me anything else!",
  ].join("\n");
}

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url.startsWith("/v1/chat/completions")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Not found. Use POST /v1/chat/completions" } }));
    return;
  }

  if (req.headers.authorization !== `Bearer ${API_KEY}`) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Invalid API key. Use Bearer test-key-123" } }));
    return;
  }

  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", async () => {
    let data = {};
    try {
      data = JSON.parse(raw || "{}");
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid JSON body" } }));
      return;
    }

    const messages = Array.isArray(data.messages) ? data.messages : [];
    const lastUser = [...messages].reverse().find((m) => m && m.role === "user");
    const userText = String(lastUser?.content || "");
    const text = buildReply(userText.trim() || "hello");

    // Fallback path: pretend the API ignored stream:true.
    if (userText.includes("JSON_MODE")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    });

    sse(res, { id: "mock-1", choices: [{ index: 0, delta: { role: "assistant" } }] });

    // Emit a few words at a time so the streaming is visible.
    const pieces = text.match(/\S+\s*/g) || [text];
    let line = "";
    for (const piece of pieces) {
      line += piece;
      if (line.length >= 8) {
        sse(res, { choices: [{ index: 0, delta: { content: line } }] });
        line = "";
        await sleep(30);
      }
    }
    if (line) sse(res, { choices: [{ index: 0, delta: { content: line } }] });

    sse(res, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-muse] listening on http://127.0.0.1:${PORT}/v1/chat/completions`);
  console.log(`[mock-muse] API key: ${API_KEY}`);
});
