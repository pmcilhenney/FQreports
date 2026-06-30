import { flexiFetch, FlexiQuizApi, HttpError, latestSubmitted, quizId, responseId } from "./flexiquiz";
import { convertQuestions } from "./moodle";
import { filterRows, normalizeResponse, questionRows, questionsCsv, ReportFilters, responsesCsv, summarize } from "./reports";

type Env = Cloudflare.Env;
type Ctx = ExecutionContext;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function textResponse(body: string, filename: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
      "Cache-Control": "no-store",
    },
  });
}

async function readJson<T>(request: Request): Promise<T> {
  if (!request.body) return {} as T;
  return await request.json() as T;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function slug(value: string): string {
  return (value || "export").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "export";
}

async function cacheQuizzes(env: Env, quizzes: FlexiQuizApi[], ctx: Ctx) {
  const now = new Date().toISOString();
  const statements = quizzes
    .filter((quiz) => quizId(quiz))
    .map((quiz) => env.DB.prepare(
      "INSERT INTO flexiquiz_quiz_cache (quiz_id, name, status, date_created, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(quiz_id) DO UPDATE SET name = excluded.name, status = excluded.status, date_created = excluded.date_created, payload = excluded.payload, updated_at = excluded.updated_at"
    ).bind(quizId(quiz), String(quiz.name || ""), String(quiz.status || ""), String(quiz.date_created || ""), JSON.stringify(quiz), now));
  if (statements.length) ctx.waitUntil(env.DB.batch(statements));
}

async function cacheResponses(env: Env, quiz: FlexiQuizApi, responses: FlexiQuizApi[], ctx: Ctx) {
  const now = new Date().toISOString();
  const qid = quizId(quiz);
  const statements = responses
    .filter((response) => responseId(response))
    .map((response) => {
      const row = normalizeResponse(qid, String(quiz.name || ""), response);
      return env.DB.prepare(
        "INSERT INTO flexiquiz_response_cache (response_id, quiz_id, status, date_submitted, learner_name, email, percentage_score, pass, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(response_id) DO UPDATE SET quiz_id = excluded.quiz_id, status = excluded.status, date_submitted = excluded.date_submitted, learner_name = excluded.learner_name, email = excluded.email, percentage_score = excluded.percentage_score, pass = excluded.pass, payload = excluded.payload, updated_at = excluded.updated_at"
      ).bind(row.responseId, row.quizId, row.status, row.dateSubmitted, row.learnerName, row.email, row.score, row.pass === null ? null : row.pass ? 1 : 0, JSON.stringify(response), now);
    });
  if (statements.length) ctx.waitUntil(env.DB.batch(statements));
}

async function listQuizzes(env: Env, ctx: Ctx) {
  const quizzes = await flexiFetch<FlexiQuizApi[]>(env, "/quizzes");
  quizzes.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  await cacheQuizzes(env, quizzes, ctx);
  return json({ quizzes });
}

async function listResponses(env: Env, ctx: Ctx, quizIdValue: string) {
  const [quizzes, responses] = await Promise.all([
    flexiFetch<FlexiQuizApi[]>(env, "/quizzes"),
    flexiFetch<FlexiQuizApi[]>(env, `/quizzes/${encodeURIComponent(quizIdValue)}/responses`),
  ]);
  const quiz = quizzes.find((item) => quizId(item) === quizIdValue) || { quiz_id: quizIdValue, name: quizIdValue };
  responses.sort((a, b) => String(b.date_submitted || "").localeCompare(String(a.date_submitted || "")));
  await cacheResponses(env, quiz, responses, ctx);
  return json({ responses });
}

async function moodleExport(request: Request, env: Env, ctx: Ctx) {
  const body = await readJson<{ quizId?: string; quizName?: string; responseId?: string; category?: string }>(request);
  if (!body.quizId) throw new HttpError(400, "quizId is required.");
  let responseIdValue = body.responseId;
  if (!responseIdValue) {
    const responses = await flexiFetch<FlexiQuizApi[]>(env, `/quizzes/${encodeURIComponent(body.quizId)}/responses`);
    const latest = latestSubmitted(responses);
    if (!latest) throw new HttpError(404, "No submitted responses found. Pick a specific response.");
    responseIdValue = responseId(latest);
  }
  const questions = await flexiFetch<Array<Record<string, unknown>>>(env, `/quizzes/${encodeURIComponent(body.quizId)}/responses/${encodeURIComponent(responseIdValue)}/questions`);
  const result = convertQuestions(questions, {
    category: body.category || `EMS Academy/${body.quizName || body.quizId}`,
    skipUnsupported: true,
  });
  const filename = `${slug(body.quizName || body.quizId)}-${stamp()}.moodle.xml`;
  const key = `moodle/${filename}`;
  ctx.waitUntil(env.EXPORTS.put(key, result.xml, { httpMetadata: { contentType: "application/xml; charset=utf-8" } }));
  return json({
    filename,
    downloadUrl: `/downloads/${encodeURIComponent(key)}`,
    convertedCount: result.convertedCount,
    skippedCount: result.warnings.length,
    warnings: result.warnings,
    xml: result.xml,
  });
}

async function runReport(request: Request, env: Env, ctx: Ctx) {
  const filters = await readJson<ReportFilters>(request);
  const quizIds = Array.isArray(filters.quizIds) ? filters.quizIds.filter(Boolean) : [];
  if (!quizIds.length) throw new HttpError(400, "Choose at least one quiz.");

  const allQuizzes = await flexiFetch<FlexiQuizApi[]>(env, "/quizzes");
  await cacheQuizzes(env, allQuizzes, ctx);
  const rows = [];
  const questionDetailRows = [];
  for (const id of quizIds) {
    const quiz = allQuizzes.find((item) => quizId(item) === id) || { quiz_id: id, name: id };
    const responses = await flexiFetch<FlexiQuizApi[]>(env, `/quizzes/${encodeURIComponent(id)}/responses`);
    await cacheResponses(env, quiz, responses, ctx);
    const normalized = filterRows(responses.map((response) => normalizeResponse(id, String(quiz.name || id), response)), filters);
    rows.push(...normalized);
    if (filters.includeQuestions) {
      for (const row of normalized) {
        if (!row.responseId) continue;
        const questions = await flexiFetch<Array<Record<string, unknown>>>(env, `/quizzes/${encodeURIComponent(id)}/responses/${encodeURIComponent(row.responseId)}/questions`);
        questionDetailRows.push(...questionRows(row, questions));
      }
    }
  }
  rows.sort((a, b) => b.dateSubmitted.localeCompare(a.dateSubmitted));
  const csv = filters.includeQuestions ? questionsCsv(questionDetailRows) : responsesCsv(rows);
  const summary = summarize(rows);
  const runId = crypto.randomUUID();
  const key = `reports/${runId}.csv`;
  await env.EXPORTS.put(key, csv, { httpMetadata: { contentType: "text/csv; charset=utf-8" } });
  ctx.waitUntil(env.DB.prepare("INSERT INTO report_runs (run_id, created_at, filters, summary, csv_object_key) VALUES (?, ?, ?, ?, ?)")
    .bind(runId, new Date().toISOString(), JSON.stringify(filters), JSON.stringify(summary), key).run());
  return json({ runId, summary, rows, csvUrl: `/downloads/${encodeURIComponent(key)}`, questionRows: questionDetailRows.length });
}

async function download(env: Env, key: string) {
  const object = await env.EXPORTS.get(key);
  if (!object) throw new HttpError(404, "Export not found.");
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${key.split("/").pop() || "export"}"`,
      "Cache-Control": "private, max-age=300",
    },
  });
}

async function api(request: Request, env: Env, ctx: Ctx, url: URL): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/api/config") {
    return json({ flexiquizConfigured: Boolean(env.FLEXIQUIZ_API_KEY) });
  }
  if (request.method === "GET" && url.pathname === "/api/quizzes") return listQuizzes(env, ctx);
  const responsesMatch = url.pathname.match(/^\/api\/quizzes\/([^/]+)\/responses$/);
  if (request.method === "GET" && responsesMatch) return listResponses(env, ctx, decodeURIComponent(responsesMatch[1]));
  if (request.method === "POST" && url.pathname === "/api/moodle/export") return moodleExport(request, env, ctx);
  if (request.method === "POST" && url.pathname === "/api/reports/run") return runReport(request, env, ctx);
  throw new HttpError(404, "API route not found.");
}

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await api(request, env, ctx, url);
      if (url.pathname.startsWith("/downloads/")) return await download(env, decodeURIComponent(url.pathname.slice("/downloads/".length)));
      if (url.pathname === "/health") return json({ ok: true });
      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(JSON.stringify({ message: "Unhandled request error", error: error instanceof Error ? error.message : String(error) }));
      return json({ error: error instanceof Error ? error.message : "Unexpected error." }, 500);
    }
  },
};
