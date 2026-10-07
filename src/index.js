/**
 * Muse Chat — Cloudflare Worker
 *
 * One Worker does two jobs:
 *   1. Serves the static chat UI from ./public (via the ASSETS binding).
 *   2. Proxies POST /api/chat to the Muse API, streaming the answer back to
 *      the browser in real time. The API key lives only in server-side
 *      environment variables and is NEVER sent to the client.
 *
 * Environment variables (set in the Cloudflare dashboard, or .dev.vars locally):
 *   MUSE_API_ENDPOINT  Base URL or full chat-completions URL of the Muse API.
 *   MUSE_API_KEY       Secret key for the Muse API (store as a Worker "Secret").
 *   MUSE_MODEL         Optional model name (default provided in wrangler.jsonc).
 *   SYSTEM_PROMPT      Optional system prompt prepended to every conversation.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") {
        return json({ error: "METHOD_NOT_ALLOWED", message: "Use POST for /api/chat." }, 405);
      }
      return handleChat(request, env);
    }

    if (url.pathname === "/api/config" && request.method === "GET") {
      return handleConfig(env);
    }

    // Everything else is served by the static assets binding (or 404s there).
    return env.ASSETS.fetch(request);
  },
};

/* ------------------------------------------------------------------ */
/* GET /api/config — lets the UI know if the server is configured.     */
/* Returns no secrets.                                                 */
/* ------------------------------------------------------------------ */
function handleConfig(env) {
  return json({
    configured: Boolean(env.MUSE_API_ENDPOINT && env.MUSE_API_KEY),
    model: env.MUSE_MODEL ? String(env.MUSE_MODEL) : null,
  });
}

/* ------------------------------------------------------------------ */
/* POST /api/chat                                                      */
/*   Request:  { "messages": [{ "role": "user", "content": "..." }] }  */
/*   Response: text/event-stream                                       */
/*     data: {"type":"delta","text":"..."}   a chunk of the answer     */
/*     data: {"type":"error","message":"..."} something broke          */
/*     data: {"type":"done"}                 the answer is complete    */
/* ------------------------------------------------------------------ */

// Simple guard rails — tune them for your own use case.
const LIMITS = {
  maxBodyBytes: 128 * 1024, // 128 KB request body
  maxMessages: 40, // max history messages accepted per request
  maxCharsPerMessage: 16_000, // max characters per message
};

async function handleChat(request, env) {
  const endpoint = normalizeEndpoint(env.MUSE_API_ENDPOINT);
  const apiKey = env.MUSE_API_KEY;

  if (!endpoint) {
    return json(
      {
        error: "MISSING_CONFIG",
        message:
          "MUSE_API_ENDPOINT is not set. Add it under Settings → Variables and Secrets in the Cloudflare dashboard (or in .dev.vars for local development).",
      },
      500
    );
  }
  if (!apiKey) {
    return json(
      {
        error: "MISSING_CONFIG",
        message:
          "MUSE_API_KEY is not set. Add it as a Secret under Settings → Variables and Secrets in the Cloudflare dashboard (or in .dev.vars for local development).",
      },
      500
    );
  }

  // Same-origin guard: other websites must not be able to burn your API key.
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(request.url).host) {
        return json({ error: "FORBIDDEN", message: "Cross-origin requests are not allowed." }, 403);
      }
    } catch {
      /* malformed Origin header — ignore and continue */
    }
  }

  // Read + validate the request body.
  const raw = await request.text();
  if (raw.length > LIMITS.maxBodyBytes) {
    return json({ error: "PAYLOAD_TOO_LARGE", message: "Request body is too large." }, 413);
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "INVALID_JSON", message: "Request body must be valid JSON." }, 400);
  }

  const history = Array.isArray(body?.messages) ? body.messages.slice(-LIMITS.maxMessages) : [];
  const messages = [];
  for (const m of history) {
    const role = m?.role === "assistant" ? "assistant" : "user";
    const content = typeof m?.content === "string" ? m.content.slice(0, LIMITS.maxCharsPerMessage) : "";
    if (content.trim()) messages.push({ role, content });
  }
  if (!messages.length) {
    return json(
      {
        error: "INVALID_MESSAGES",
        message: 'Send { "messages": [{ "role": "user", "content": "..." }] }.',
      },
      400
    );
  }

  // Optional system prompt — server-side only, the client cannot inject one.
  const systemPrompt = typeof env.SYSTEM_PROMPT === "string" ? env.SYSTEM_PROMPT.trim() : "";
  const upstreamMessages = systemPrompt
    ? [{ role: "system", content: systemPrompt }, ...messages]
    : messages;

  const upstreamBody = { messages: upstreamMessages, stream: true };
  if (env.MUSE_MODEL && String(env.MUSE_MODEL).trim()) {
    upstreamBody.model = String(env.MUSE_MODEL).trim();
  }

  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(upstreamBody),
      signal: request.signal, // if the user hits "Stop", close the upstream too
    });
  } catch (err) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return json(
      {
        error: "UPSTREAM_UNREACHABLE",
        message: `Could not reach the Muse API at ${endpoint}. Double-check MUSE_API_ENDPOINT.`,
        detail: String(err?.message || err),
      },
      502
    );
  }

  if (!upstream.ok) {
    const detail = (await upstream.text().catch(() => "")).slice(0, 1000);
    return json(
      {
        error: "UPSTREAM_ERROR",
        message: `The Muse API responded with HTTP ${upstream.status}. Check MUSE_API_KEY / MUSE_MODEL.`,
        status: upstream.status,
        detail,
      },
      502
    );
  }

  const contentType = upstream.headers.get("content-type") || "";
  return contentType.includes("text/event-stream") ? relaySSE(upstream, request) : relayJSON(upstream);
}

/* Stream the upstream SSE response, re-emitting it in the simple protocol
 * documented above. Works with any OpenAI-compatible streaming API. */
function relaySSE(upstream, request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const send = (obj) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          open = false; // client went away
        }
      };

      try {
        for await (const line of readLines(upstream.body)) {
          if (request.signal.aborted || !open) break;
          if (!line.startsWith("data:")) continue; // skip comments / event lines
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let evt;
          try {
            evt = JSON.parse(payload);
          } catch {
            continue;
          }
          const text = extractDelta(evt);
          if (text) send({ type: "delta", text });
        }
        if (!request.signal.aborted) send({ type: "done" });
      } catch {
        if (!request.signal.aborted) {
          send({ type: "error", message: "The stream from the Muse API was interrupted." });
        }
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      upstream.body.cancel().catch(() => {});
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

/* Some APIs ignore stream:true and answer with a single JSON object.
 * Detect that and replay the text through the same SSE protocol. */
async function relayJSON(upstream) {
  let text = "";
  try {
    const data = await upstream.json();
    text =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.text ??
      data?.content ??
      data?.output_text ??
      (typeof data === "string" ? data : "");
  } catch {
    text = "";
  }
  if (typeof text !== "string") text = "";

  const frames = [];
  if (text) {
    for (let i = 0; i < text.length; i += 64) {
      frames.push(`data: ${JSON.stringify({ type: "delta", text: text.slice(i, i + 64) })}\n\n`);
    }
    frames.push(`data: ${JSON.stringify({ type: "done" })}\n\n`);
  } else {
    frames.push(
      `data: ${JSON.stringify({ type: "error", message: "The Muse API returned an empty response." })}\n\n`
    );
  }
  return new Response(frames.join(""), { headers: SSE_HEADERS });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/**
 * Accepts a base URL ("https://api.meta.ai/v1"), a bare host ("https://host"),
 * or a full chat-completions URL, and normalizes it to the full endpoint URL.
 * Anything else is passed through untouched, so custom gateways work too.
 */
function normalizeEndpoint(raw) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const path = url.pathname.replace(/\/+$/, ""); // strip trailing "/"
  if (path === "") {
    url.pathname = "/v1/chat/completions";
  } else if (/\/v\d+$/.test(path)) {
    url.pathname = `${path}/chat/completions`;
  }
  return url.toString();
}

/** Pull the new text out of an OpenAI-style streaming chunk. */
function extractDelta(evt) {
  const choice = evt?.choices?.[0];
  if (choice) {
    if (typeof choice.delta?.content === "string") return choice.delta.content;
    if (typeof choice.text === "string") return choice.text;
    if (typeof choice.message?.content === "string") return choice.message.content;
  }
  if (typeof evt?.delta === "string") return evt.delta;
  if (typeof evt?.text === "string") return evt.text;
  if (typeof evt?.content === "string") return evt.content;
  return "";
}

/** Yield complete lines from a (binary) response body stream. */
async function* readLines(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        yield buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
      }
    }
    if (buffer) yield buffer.replace(/\r$/, "");
  } finally {
    reader.releaseLock?.();
  }
}
