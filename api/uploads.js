const GITHUB_API = "https://api.github.com";
const DATA_DIR = "data";

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function ghConfig() {
  return {
    token: env("GITHUB_TOKEN"),
    owner: env("GITHUB_OWNER"),
    repo: env("GITHUB_REPO"),
    branch: env("GITHUB_BRANCH", "main"),
  };
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "lua-raw-host",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function toBase64(str) {
  return Buffer.from(str, "utf8").toString("base64");
}
function fromBase64(b64) {
  return Buffer.from(b64, "base64").toString("utf8");
}

function randomId(len = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function getQuery(req) {
  if (req.query) return req.query;
  const url = new URL(req.url, "http://localhost");
  return Object.fromEntries(url.searchParams.entries());
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.end(JSON.stringify(obj));
}

function sendLua(res, status, text) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  res.end(text);
}

async function ghPutFile(cfg, path, contentStr, message) {
  const url = `${GITHUB_API}/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURIComponent(path)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...ghHeaders(cfg.token), "Content-Type": "application/json" },
    body: JSON.stringify({
      message: message || `add ${path}`,
      content: toBase64(contentStr),
      branch: cfg.branch,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`GitHub PUT ${res.status}: ${detail}`);
  }
  return res.json();
}

async function ghGetRaw(cfg, path) {
  const url = `${GITHUB_API}/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURIComponent(
    path
  )}?ref=${encodeURIComponent(cfg.branch)}`;
  const res = await fetch(url, {
    headers: { ...ghHeaders(cfg.token), Accept: "application/vnd.github+json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`GitHub GET ${res.status}: ${detail}`);
  }
  const json = await res.json();
  if (!json.content) return null;
  return fromBase64(json.content.replace(/\n/g, ""));
}

function isRobloxRequest(req) {
  const ua = String(req.headers["user-agent"] || "").toLowerCase();
  if (ua.includes("roblox")) return true;
  if (String(req.headers["x-executor"] || "").length > 0) return true;
  return false;
}

const DEFAULT_DECOY = `-- Access Denied
print("Nice try :)")
`;

function sanitizeId(id) {
  return String(id).replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-upload-key, x-executor");
    return res.end();
  }

  const cfg = ghConfig();

  if (req.method === "GET") {
    const q = getQuery(req);
    const id = q.id;
    if (!id) {
      return sendJson(res, 400, { error: "missing ?id" });
    }
    if (!cfg.token || !cfg.owner || !cfg.repo) {
      return sendJson(res, 500, { error: "GitHub env not configured" });
    }

    let metaStr;
    try {
      metaStr = await ghGetRaw(cfg, `${DATA_DIR}/${sanitizeId(id)}.json`);
    } catch (e) {
      return sendJson(res, 502, { error: "github error", detail: String(e.message) });
    }
    if (!metaStr) {
      return sendLua(res, 404, "-- 404 file not found");
    }

    let meta;
    try {
      meta = JSON.parse(metaStr);
    } catch {
      return sendLua(res, 500, "-- corrupt metadata");
    }

    if (isRobloxRequest(req)) {
      return sendLua(res, 200, meta.code || "");
    }
    return sendLua(res, 200, meta.decoy || DEFAULT_DECOY);
  }

  if (req.method === "POST") {
    if (!cfg.token || !cfg.owner || !cfg.repo) {
      return sendJson(res, 500, { error: "GitHub env not configured" });
    }

    const uploadKey = env("UPLOAD_KEY");
    if (uploadKey) {
      const provided = req.headers["x-upload-key"];
      if (provided !== uploadKey) {
        return sendJson(res, 401, { error: "invalid upload key" });
      }
    }

    const body = await readJsonBody(req);
    const name = String(body.name || "script").slice(0, 100);
    const code = typeof body.code === "string" ? body.code : "";
    const decoy = typeof body.decoy === "string" && body.decoy.length ? body.decoy : DEFAULT_DECOY;

    if (!code.trim()) {
      return sendJson(res, 400, { error: "missing code" });
    }

    const id = randomId(10);
    const meta = {
      id,
      name,
      code,
      decoy,
      createdAt: new Date().toISOString(),
    };

    try {
      await ghPutFile(cfg, `${DATA_DIR}/${id}.json`, JSON.stringify(meta, null, 2), `upload: ${name}`);
    } catch (e) {
      return sendJson(res, 502, { error: "github upload failed", detail: String(e.message) });
    }

    const host = req.headers["x-forwarded-host"] || req.headers.host || "";
    const proto = req.headers["x-forwarded-proto"] || "https";
    const rawUrl = `${proto}://${host}/api/uploads?id=${id}`;

    return sendJson(res, 200, {
      ok: true,
      id,
      name,
      rawUrl,
      loadstring: `loadstring(game:HttpGet("${rawUrl}"))()`,
    });
  }

  return sendJson(res, 405, { error: "method not allowed" });
}
