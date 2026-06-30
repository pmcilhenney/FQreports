import { flexiFetch, flexiPost, FlexiQuizApi, HttpError, latestSubmitted, passFor, quizId, responseId, scoreFor } from "./flexiquiz";
import { convertQuestions } from "./moodle";
import { filterRows, normalizeResponse, questionRows, questionsCsv, ReportFilters, responsesCsv, summarize } from "./reports";
import { buildScormPackage } from "./scorm";

type Env = Cloudflare.Env & { FLEXIQUIZ_JWT_SECRET?: string };
type Ctx = ExecutionContext;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function signJwt(secret: string, payload: Record<string, unknown>): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64Url(new TextEncoder().encode(JSON.stringify(header)));
  const encodedPayload = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret.trim()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`));
  return `${encodedHeader}.${encodedPayload}.${base64Url(signature)}`;
}

function siteBaseUrl(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function emailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function stableUserName(studentId: string): string {
  if (emailLike(studentId)) return studentId.toLowerCase();
  return `moodle-${studentId.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "student"}`;
}

function userId(value: FlexiQuizApi): string {
  return String(value.user_id || value.id || "");
}

function userName(value: FlexiQuizApi): string {
  return String(value.user_name || value.email_address || value.email || "");
}

async function ensureFlexiQuizUser(env: Env, body: { moodleStudentId: string; firstName?: string; lastName?: string }): Promise<FlexiQuizApi> {
  const name = stableUserName(body.moodleStudentId || "unknown");
  try {
    const found = await flexiPost<FlexiQuizApi>(env, "/users/find", { user_name: name });
    if (userId(found)) return { ...found, user_name: name };
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 404) throw error;
  }
  const createParams: Record<string, string | number | boolean> = {
    user_name: name,
    password: randomToken(),
    first_name: body.firstName || "Moodle",
    last_name: body.lastName || "Learner",
    email_invite: false,
  };
  if (emailLike(name)) createParams.email_address = name;
  const created = await flexiPost<FlexiQuizApi>(env, "/users", {
    ...createParams,
  });
  if (!userId(created)) throw new HttpError(502, "FlexiQuiz did not return a user_id for the created user.");
  return { ...created, user_name: name };
}

async function assignQuiz(env: Env, user: FlexiQuizApi, quizIdValue: string) {
  try {
    await flexiPost<unknown>(env, `/users/${encodeURIComponent(userId(user))}/quizzes`, { quiz_id: quizIdValue });
  } catch (error) {
    if (error instanceof HttpError && [400, 409].includes(error.status) && /already|assigned/i.test(error.message)) return;
    throw error;
  }
}

async function buildSsoLaunchUrl(env: Env, user: FlexiQuizApi, quizIdValue: string): Promise<string> {
  const secret = env.FLEXIQUIZ_JWT_SECRET;
  if (!secret) throw new HttpError(500, "FLEXIQUIZ_JWT_SECRET is not configured.");
  const loginName = userName(user);
  if (!loginName) throw new HttpError(502, "FlexiQuiz user_name was not available for SSO.");
  const jwt = await signJwt(secret, {
    user_name: loginName,
    exp: String(Math.floor(Date.now() / 1000) + 15 * 60),
  });
  return `https://www.flexiquiz.com/account/auth?cla=t&jwt=${encodeURIComponent(jwt)}&quiz_id=${encodeURIComponent(quizIdValue)}`;
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

async function scormExport(request: Request, env: Env) {
  const body = await readJson<{ quizId?: string; quizName?: string }>(request);
  if (!body.quizId) throw new HttpError(400, "quizId is required.");
  if (!env.FLEXIQUIZ_JWT_SECRET) throw new HttpError(500, "FLEXIQUIZ_JWT_SECRET is not configured.");
  const quizName = body.quizName || body.quizId;
  const packageToken = randomToken();
  const zip = buildScormPackage({
    quizId: body.quizId,
    quizName,
    bridgeUrl: siteBaseUrl(request),
    packageToken,
  });
  const filename = `${slug(quizName)}-${stamp()}.scorm.zip`;
  const key = `scorm/${filename}`;
  await env.EXPORTS.put(key, zip, { httpMetadata: { contentType: "application/zip" } });
  const exportId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO flexiquiz_launch_urls (quiz_id, launch_url, launch_mode, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(quiz_id) DO UPDATE SET launch_url = excluded.launch_url, launch_mode = excluded.launch_mode, updated_at = excluded.updated_at")
      .bind(body.quizId, "sso", "iframe", now),
    env.DB.prepare("INSERT INTO scorm_exports (export_id, quiz_id, quiz_name, launch_url, launch_mode, package_object_key, created_at, package_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(exportId, body.quizId, quizName, "sso", "iframe", key, now, packageToken),
  ]);
  return json({
    exportId,
    filename,
    downloadUrl: `/downloads/${encodeURIComponent(key)}`,
    launchMode: "iframe",
  });
}

async function scormSession(request: Request, env: Env) {
  const body = await readJson<{
    packageToken?: string;
    quizId?: string;
    moodleStudentId?: string;
    moodleStudentName?: string;
    firstName?: string;
    lastName?: string;
  }>(request);
  if (!body.packageToken || !body.quizId || !body.moodleStudentId) throw new HttpError(400, "packageToken, quizId, and moodleStudentId are required.");
  const exportRow = await env.DB.prepare("SELECT quiz_id FROM scorm_exports WHERE package_token = ?").bind(body.packageToken).first<{ quiz_id: string }>();
  if (!exportRow || exportRow.quiz_id !== body.quizId) throw new HttpError(403, "SCORM package token is not valid for this quiz.");
  const user = await ensureFlexiQuizUser(env, {
    moodleStudentId: body.moodleStudentId,
    firstName: body.firstName,
    lastName: body.lastName,
  });
  await assignQuiz(env, user, body.quizId);
  const sessionId = crypto.randomUUID();
  const launchUrl = await buildSsoLaunchUrl(env, user, body.quizId);
  await env.DB.prepare(
    "INSERT INTO scorm_sessions (session_id, package_token, quiz_id, moodle_student_id, moodle_student_name, flexiquiz_user_id, flexiquiz_user_name, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(sessionId, body.packageToken, body.quizId, body.moodleStudentId, body.moodleStudentName || "", userId(user), userName(user), new Date().toISOString(), "launched").run();
  return json({ sessionId, launchUrl });
}

async function scormResult(request: Request, env: Env) {
  const body = await readJson<{ packageToken?: string; sessionId?: string }>(request);
  if (!body.packageToken || !body.sessionId) throw new HttpError(400, "packageToken and sessionId are required.");
  const session = await env.DB.prepare(
    "SELECT session_id, package_token, quiz_id, flexiquiz_user_id FROM scorm_sessions WHERE session_id = ? AND package_token = ?"
  ).bind(body.sessionId, body.packageToken).first<{ session_id: string; package_token: string; quiz_id: string; flexiquiz_user_id: string }>();
  if (!session) throw new HttpError(404, "SCORM session not found.");
  const responses = await flexiFetch<FlexiQuizApi[]>(env, `/quizzes/${encodeURIComponent(session.quiz_id)}/responses`);
  const matched = responses
    .filter((response) => String(response.user_id || "") === session.flexiquiz_user_id && String(response.status || "").toLowerCase() === "submitted")
    .sort((a, b) => String(b.date_submitted || "").localeCompare(String(a.date_submitted || "")))[0];
  const now = new Date().toISOString();
  if (!matched) {
    await env.DB.prepare("UPDATE scorm_sessions SET last_checked_at = ?, status = ? WHERE session_id = ?").bind(now, "incomplete", body.sessionId).run();
    return json({ completed: false });
  }
  const score = scoreFor(matched);
  const pass = passFor(matched);
  await env.DB.prepare("UPDATE scorm_sessions SET last_checked_at = ?, completed_at = ?, response_id = ?, score = ?, pass = ?, status = ? WHERE session_id = ?")
    .bind(now, now, responseId(matched), score, pass === null ? null : pass ? 1 : 0, pass === false ? "failed" : "passed", body.sessionId).run();
  return json({
    completed: true,
    responseId: responseId(matched),
    score: score ?? 0,
    pass: pass !== false,
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
    return json({ flexiquizConfigured: Boolean(env.FLEXIQUIZ_API_KEY), flexiquizSsoConfigured: Boolean(env.FLEXIQUIZ_JWT_SECRET) });
  }
  if (request.method === "GET" && url.pathname === "/api/quizzes") return listQuizzes(env, ctx);
  const responsesMatch = url.pathname.match(/^\/api\/quizzes\/([^/]+)\/responses$/);
  if (request.method === "GET" && responsesMatch) return listResponses(env, ctx, decodeURIComponent(responsesMatch[1]));
  if (request.method === "POST" && url.pathname === "/api/moodle/export") return moodleExport(request, env, ctx);
  if (request.method === "POST" && url.pathname === "/api/scorm/export") return scormExport(request, env);
  if (request.method === "POST" && url.pathname === "/api/scorm/session") return scormSession(request, env);
  if (request.method === "POST" && url.pathname === "/api/scorm/result") return scormResult(request, env);
  if (request.method === "POST" && url.pathname === "/api/reports/run") return runReport(request, env, ctx);
  throw new HttpError(404, "API route not found.");
}

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS") return json({ ok: true });
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
