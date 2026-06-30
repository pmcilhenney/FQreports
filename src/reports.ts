import { emailFor, FlexiQuizApi, learnerName, passFor, responseId, scoreFor } from "./flexiquiz";

export type ReportFilters = {
  quizIds: string[];
  dateFrom?: string;
  dateTo?: string;
  passFilter?: "all" | "pass" | "fail" | "unknown";
  statusFilter?: string;
  search?: string;
  includeQuestions?: boolean;
};

export type ReportRow = {
  quizId: string;
  quizName: string;
  responseId: string;
  learnerName: string;
  email: string;
  status: string;
  dateSubmitted: string;
  score: number | null;
  pass: boolean | null;
  duration: string;
  grade: string;
};

export type QuestionRow = ReportRow & {
  questionId: string;
  question: string;
  selectedAnswer: string;
  correctAnswer: string;
  correct: boolean | null;
  pointsAvailable: string;
  pointsScored: string;
};

export type ReportSummary = {
  totalResponses: number;
  passCount: number;
  failCount: number;
  unknownCount: number;
  averageScore: number | null;
  byQuiz: Array<{
    quizId: string;
    quizName: string;
    responses: number;
    passCount: number;
    failCount: number;
    averageScore: number | null;
  }>;
};

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

function csvCell(value: unknown): string {
  const raw = value === undefined || value === null ? "" : String(value);
  return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function withinDate(value: string, from?: string, to?: string): boolean {
  if (!value) return true;
  const day = value.slice(0, 10);
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

export function normalizeResponse(quizId: string, quizName: string, response: FlexiQuizApi): ReportRow {
  return {
    quizId,
    quizName,
    responseId: responseId(response),
    learnerName: learnerName(response),
    email: emailFor(response),
    status: text(response.status),
    dateSubmitted: text(response.date_submitted || response.date_completed || response.submitted_at),
    score: scoreFor(response),
    pass: passFor(response),
    duration: text(response.duration),
    grade: text(response.grade),
  };
}

export function filterRows(rows: ReportRow[], filters: ReportFilters): ReportRow[] {
  const query = text(filters.search).toLowerCase();
  return rows.filter((row) => {
    if (!withinDate(row.dateSubmitted, filters.dateFrom, filters.dateTo)) return false;
    if (filters.statusFilter && row.status !== filters.statusFilter) return false;
    if (filters.passFilter === "pass" && row.pass !== true) return false;
    if (filters.passFilter === "fail" && row.pass !== false) return false;
    if (filters.passFilter === "unknown" && row.pass !== null) return false;
    if (!query) return true;
    return [row.quizName, row.learnerName, row.email, row.responseId].some((value) => value.toLowerCase().includes(query));
  });
}

function average(values: Array<number | null>): number | null {
  const numeric = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!numeric.length) return null;
  return Math.round((numeric.reduce((sum, value) => sum + value, 0) / numeric.length) * 100) / 100;
}

export function summarize(rows: ReportRow[]): ReportSummary {
  const groups = new Map<string, ReportRow[]>();
  for (const row of rows) {
    const key = row.quizId;
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  return {
    totalResponses: rows.length,
    passCount: rows.filter((row) => row.pass === true).length,
    failCount: rows.filter((row) => row.pass === false).length,
    unknownCount: rows.filter((row) => row.pass === null).length,
    averageScore: average(rows.map((row) => row.score)),
    byQuiz: [...groups.values()].map((items) => ({
      quizId: items[0].quizId,
      quizName: items[0].quizName,
      responses: items.length,
      passCount: items.filter((row) => row.pass === true).length,
      failCount: items.filter((row) => row.pass === false).length,
      averageScore: average(items.map((row) => row.score)),
    })).sort((a, b) => a.quizName.localeCompare(b.quizName)),
  };
}

export function responsesCsv(rows: ReportRow[]): string {
  const header = ["Quiz", "Quiz ID", "Response ID", "Learner", "Email", "Submitted", "Status", "Score", "Pass", "Grade", "Duration"];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push([
      row.quizName,
      row.quizId,
      row.responseId,
      row.learnerName,
      row.email,
      row.dateSubmitted,
      row.status,
      row.score ?? "",
      row.pass === null ? "" : row.pass ? "Pass" : "Fail",
      row.grade,
      row.duration,
    ].map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function plainQuestion(value: unknown): string {
  return text(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function selectedOptions(question: Record<string, unknown>): string {
  const options = Array.isArray(question.options) ? question.options as Array<Record<string, unknown>> : [];
  return options
    .filter((option) => Boolean(option.selected) || text(option.selected).toLowerCase() === "true")
    .map((option) => text(option.text || option.answer || option.value || option.label))
    .filter(Boolean)
    .join("; ");
}

function correctOptions(question: Record<string, unknown>): string {
  const options = Array.isArray(question.options) ? question.options as Array<Record<string, unknown>> : [];
  return options
    .filter((option) => Boolean(option.correct) || text(option.correct).toLowerCase() === "true")
    .map((option) => text(option.text || option.answer || option.value || option.label))
    .filter(Boolean)
    .join("; ");
}

function questionCorrect(question: Record<string, unknown>): boolean | null {
  const raw = question.correct ?? question.is_correct;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const value = raw.toLowerCase();
    if (["true", "yes", "1", "correct"].includes(value)) return true;
    if (["false", "no", "0", "incorrect"].includes(value)) return false;
  }
  return null;
}

export function questionRows(base: ReportRow, questions: Array<Record<string, unknown>>): QuestionRow[] {
  return questions.map((question) => ({
    ...base,
    questionId: text(question.question_id || question.id),
    question: plainQuestion(question.text || question.question || question.prompt),
    selectedAnswer: selectedOptions(question),
    correctAnswer: correctOptions(question),
    correct: questionCorrect(question),
    pointsAvailable: text(question.points_available || question.points),
    pointsScored: text(question.points_scored || question.score),
  }));
}

export function questionsCsv(rows: QuestionRow[]): string {
  const header = ["Quiz", "Quiz ID", "Response ID", "Learner", "Email", "Submitted", "Score", "Pass", "Question ID", "Question", "Selected Answer", "Correct Answer", "Question Correct", "Points Available", "Points Scored"];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push([
      row.quizName,
      row.quizId,
      row.responseId,
      row.learnerName,
      row.email,
      row.dateSubmitted,
      row.score ?? "",
      row.pass === null ? "" : row.pass ? "Pass" : "Fail",
      row.questionId,
      row.question,
      row.selectedAnswer,
      row.correctAnswer,
      row.correct === null ? "" : row.correct ? "Correct" : "Incorrect",
      row.pointsAvailable,
      row.pointsScored,
    ].map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}
