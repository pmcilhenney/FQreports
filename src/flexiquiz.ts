export type FlexiQuizApi = {
  quiz_id?: string;
  response_id?: string;
  name?: string;
  status?: string;
  date_created?: string;
  date_submitted?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  percentage_score?: number | string;
  grade?: string;
  pass?: boolean | string | number;
  duration?: string | number;
  registration_fields?: Record<string, unknown> | Array<Record<string, unknown>>;
  [key: string]: unknown;
};

type EnvLike = {
  FLEXIQUIZ_API_KEY?: string;
  FLEXIQUIZ_API_BASE?: string;
};

const DEFAULT_API_BASE = "https://www.flexiquiz.com/api/v1";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function flexiFetch<T>(env: EnvLike, path: string): Promise<T> {
  const apiKey = env.FLEXIQUIZ_API_KEY;
  if (!apiKey) {
    throw new HttpError(401, "FlexiQuiz API key is not configured. Set FLEXIQUIZ_API_KEY with wrangler secret put.");
  }
  const base = (env.FLEXIQUIZ_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
  const response = await fetch(`${base}${path}`, {
    headers: { "X-API-KEY": apiKey },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(response.status, `FlexiQuiz returned HTTP ${response.status}: ${text}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

export function quizId(quiz: FlexiQuizApi): string {
  return String(quiz.quiz_id || quiz.id || "");
}

export function responseId(response: FlexiQuizApi): string {
  return String(response.response_id || response.id || "");
}

export function learnerName(response: FlexiQuizApi): string {
  const first = String(response.first_name || "").trim();
  const last = String(response.last_name || "").trim();
  const full = `${first} ${last}`.trim();
  if (full) return full;
  const fields = response.registration_fields;
  if (Array.isArray(fields)) {
    const values = fields.map((field) => String(field.value || field.answer || "")).filter(Boolean);
    return values.slice(0, 2).join(" ");
  }
  return String(response.name || response.respondent || "").trim();
}

export function emailFor(response: FlexiQuizApi): string {
  if (response.email) return String(response.email);
  const fields = response.registration_fields;
  if (Array.isArray(fields)) {
    const field = fields.find((item) => /email/i.test(String(item.name || item.label || "")));
    return field ? String(field.value || field.answer || "") : "";
  }
  if (fields && typeof fields === "object") {
    const entry = Object.entries(fields).find(([key]) => /email/i.test(key));
    return entry ? String(entry[1] || "") : "";
  }
  return "";
}

export function scoreFor(response: FlexiQuizApi): number | null {
  const raw = response.percentage_score ?? response.score_percentage ?? response.score;
  if (raw === undefined || raw === null || raw === "") return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

export function passFor(response: FlexiQuizApi): boolean | null {
  const raw = response.pass ?? response.passed ?? response.result;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw > 0;
  if (typeof raw === "string") {
    const value = raw.trim().toLowerCase();
    if (["true", "pass", "passed", "yes", "1"].includes(value)) return true;
    if (["false", "fail", "failed", "no", "0"].includes(value)) return false;
  }
  return null;
}

export function latestSubmitted(responses: FlexiQuizApi[]): FlexiQuizApi | null {
  return responses
    .filter((item) => String(item.status || "").toLowerCase() === "submitted")
    .sort((a, b) => String(b.date_submitted || "").localeCompare(String(a.date_submitted || "")))[0] || null;
}
