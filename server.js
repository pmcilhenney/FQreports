const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const EXPORTS_DIR = path.join(ROOT, "exports");
const ENV_FILE = path.join(ROOT, ".env.local");
const API_BASE = "https://www.flexiquiz.com/api/v1";
const PORT = Number(process.env.PORT || 4317);

function parseEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return {};
  const text = fs.readFileSync(ENV_FILE, "utf8");
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function apiKeyInfo() {
  if (process.env.FLEXIQUIZ_API_KEY) {
    return { key: process.env.FLEXIQUIZ_API_KEY, source: "shell environment" };
  }
  const env = parseEnvFile();
  if (env.FLEXIQUIZ_API_KEY) {
    return { key: env.FLEXIQUIZ_API_KEY, source: ".env.local" };
  }
  return { key: "", source: "" };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error("Invalid JSON."));
      }
    });
    req.on("error", reject);
  });
}

async function flexiFetch(apiPath) {
  const { key } = apiKeyInfo();
  if (!key) {
    const error = new Error("FlexiQuiz API key is not configured.");
    error.statusCode = 401;
    throw error;
  }
  const response = await fetch(`${API_BASE}${apiPath}`, {
    headers: { "X-API-KEY": key },
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`FlexiQuiz returned HTTP ${response.status}: ${text}`);
    error.statusCode = response.status;
    throw error;
  }
  return text ? JSON.parse(text) : null;
}

function slugify(value) {
  return String(value || "exam")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "exam";
}

function runExport({ quizId, quizName, responseId, category }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = `${slugify(quizName)}-${stamp}`;
    const xmlPath = path.join(EXPORTS_DIR, `${base}.moodle.xml`);
    const rawPath = path.join(EXPORTS_DIR, `${base}.flexiquiz.json`);
    const args = [
      path.join(ROOT, "flexiquiz_to_moodle.py"),
      "export",
      "--quiz-id",
      quizId,
      "--output",
      xmlPath,
      "--raw-output",
      rawPath,
      "--skip-unsupported",
      "--category",
      category || `EMS Academy/${quizName || "Exam"}`,
    ];
    if (responseId) {
      args.push("--response-id", responseId);
    }
    const env = { ...process.env, FLEXIQUIZ_API_KEY: apiKeyInfo().key };
    execFile("python3", args, { cwd: ROOT, env, timeout: 120000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }
      resolve({
        stdout,
        stderr,
        warnings: stderr
          .split(/\r?\n/)
          .map((line) => line.replace(/^WARNING:\s*/, "").trim())
          .filter(Boolean),
        xmlFile: path.basename(xmlPath),
        rawFile: path.basename(rawPath),
        xmlPath,
        rawPath,
      });
    });
  });
}

function staticFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  };
  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendError(res, 404, "Not found.");
      return;
    }
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "GET" && url.pathname === "/api/key-status") {
      const info = apiKeyInfo();
      sendJson(res, 200, { configured: Boolean(info.key), source: info.source });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/api-key") {
      const body = await readBody(req);
      const apiKey = String(body.apiKey || "").trim();
      if (!apiKey) {
        sendError(res, 400, "API key is required.");
        return;
      }
      fs.writeFileSync(ENV_FILE, `FLEXIQUIZ_API_KEY=${JSON.stringify(apiKey)}\n`, { mode: 0o600 });
      fs.chmodSync(ENV_FILE, 0o600);
      sendJson(res, 200, { configured: true, source: ".env.local" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/quizzes") {
      const quizzes = await flexiFetch("/quizzes");
      quizzes.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
      sendJson(res, 200, { quizzes });
      return;
    }

    const responsesMatch = url.pathname.match(/^\/api\/quizzes\/([^/]+)\/responses$/);
    if (req.method === "GET" && responsesMatch) {
      const responses = await flexiFetch(`/quizzes/${encodeURIComponent(responsesMatch[1])}/responses`);
      responses.sort((a, b) => String(b.date_submitted || "").localeCompare(String(a.date_submitted || "")));
      sendJson(res, 200, { responses });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/export") {
      const body = await readBody(req);
      if (!body.quizId) {
        sendError(res, 400, "quizId is required.");
        return;
      }
      const result = await runExport(body);
      sendJson(res, 200, {
        message: result.stdout.trim(),
        xmlUrl: `/downloads/${result.xmlFile}`,
        rawUrl: `/downloads/${result.rawFile}`,
        xmlFile: result.xmlFile,
        rawFile: result.rawFile,
        skippedCount: result.warnings.length,
        warnings: result.warnings,
      });
      return;
    }

    sendError(res, 404, "API route not found.");
  } catch (error) {
    sendError(res, error.statusCode || 500, error.message || "Unexpected error.");
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url);
    return;
  }

  if (url.pathname.startsWith("/downloads/")) {
    const fileName = path.basename(decodeURIComponent(url.pathname.slice("/downloads/".length)));
    staticFile(res, path.join(EXPORTS_DIR, fileName));
    return;
  }

  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendError(res, 403, "Forbidden.");
    return;
  }
  staticFile(res, filePath);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`FlexiQuiz to Moodle dashboard: http://127.0.0.1:${PORT}`);
});
