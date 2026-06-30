type Question = Record<string, unknown>;
type Option = Record<string, unknown>;

const MULTICHOICE = new Set(["radio_button", "dropdown", "drop_down", "single_choice", "multiple_choice", "checkbox", "check_box", "picture_choice"]);
const SHORTANSWER = new Set(["matching_text", "match_text", "short_answer", "fill_in_the_blank", "fill_in_the_blanks", "fill_blank"]);
const ESSAY = new Set(["free_text", "essay", "file_upload"]);

export type MoodleOptions = {
  category?: string;
  skipUnsupported?: boolean;
  multiWrongPenalty?: "proportional" | "none";
  shuffleAnswers?: boolean;
  includeTags?: boolean;
};

export type MoodleResult = {
  xml: string;
  warnings: string[];
  convertedCount: number;
};

class ConvertError extends Error {}

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

function xml(value: unknown): string {
  return text(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripHtml(value: unknown): string {
  return text(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeType(value: unknown): string {
  return text(value).toLowerCase().replace(/[\s-]+/g, "_");
}

function optionText(option: Option): string {
  for (const key of ["text", "answer", "value", "label"]) {
    const value = text(option[key]);
    if (value) return value;
  }
  return "";
}

function isCorrect(option: Option): boolean {
  const value = option.correct;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["true", "1", "yes", "y"].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function title(question: Question, index: number): string {
  const explicit = text(question.name || question.title);
  if (explicit) return explicit;
  const fromText = stripHtml(question.text || question.question || question.prompt);
  return fromText ? (fromText.length > 90 ? `${fromText.slice(0, 89).replace(/[ .,;:!?]+$/, "")}...` : fromText) : `Question ${index}`;
}

function questionText(question: Question): string {
  const value = text(question.text || question.question || question.prompt);
  if (!value) throw new ConvertError(`Question ${text(question.question_id)} has no question text.`);
  return value;
}

function pushTextNode(lines: string[], indent: number, tag: string, value: unknown, attrs = "") {
  const pad = " ".repeat(indent);
  lines.push(`${pad}<${tag}${attrs ? ` ${attrs}` : ""}>`, `${pad}  <text>${xml(value)}</text>`, `${pad}</${tag}>`);
}

function common(lines: string[], question: Question, index: number) {
  pushTextNode(lines, 4, "name", title(question, index));
  pushTextNode(lines, 4, "questiontext", questionText(question), 'format="html"');
  lines.push(`    <defaultgrade>${xml(question.points_available || question.points || "1")}</defaultgrade>`);
  lines.push("    <penalty>0.3333333</penalty>", "    <hidden>0</hidden>");
}

function pushTags(lines: string[], question: Question, flexiType: string) {
  const tags = [`flexiquiz:${flexiType}`];
  if (text(question.question_id)) tags.push(`flexiquiz-id:${text(question.question_id)}`);
  const categories = Array.isArray(question.categories) ? question.categories : [];
  for (const category of categories) {
    const value = typeof category === "object" && category ? text((category as Record<string, unknown>).name) : text(category);
    if (value) tags.push(value);
  }
  lines.push("    <tags>");
  for (const tag of tags) {
    lines.push("      <tag>", `        <text>${xml(tag)}</text>`, "      </tag>");
  }
  lines.push("    </tags>");
}

function decimal(value: number): string {
  return Number(value.toFixed(5)).toString();
}

function convertMultichoice(lines: string[], question: Question, index: number, flexiType: string, options: Option[], opts: Required<MoodleOptions>) {
  if (!options.length) throw new ConvertError(`${title(question, index)} has no answer options.`);
  const correct = options.filter(isCorrect);
  if (!correct.length) throw new ConvertError(`${title(question, index)} has no correct answer marked.`);
  const labels = new Set(options.map((item) => optionText(item).toLowerCase()));
  const single = !["checkbox", "check_box", "multiple_choice"].includes(flexiType) && correct.length === 1;
  if (single && labels.size === 2 && labels.has("true") && labels.has("false")) {
    lines.push('  <question type="truefalse">');
    common(lines, question, index);
    for (const label of ["true", "false"]) {
      const option = options.find((item) => optionText(item).toLowerCase() === label);
      lines.push(`    <answer fraction="${option && isCorrect(option) ? "100" : "0"}">`, `      <text>${label}</text>`, "      <feedback><text></text></feedback>", "    </answer>");
    }
    if (opts.includeTags) pushTags(lines, question, flexiType);
    lines.push("  </question>");
    return;
  }
  const wrongCount = options.length - correct.length;
  const correctFraction = single ? 100 : 100 / correct.length;
  const wrongFraction = opts.multiWrongPenalty === "none" || single || wrongCount === 0 ? 0 : -100 / wrongCount;
  lines.push('  <question type="multichoice">');
  common(lines, question, index);
  lines.push(`    <single>${single ? "true" : "false"}</single>`, `    <shuffleanswers>${opts.shuffleAnswers ? 1 : 0}</shuffleanswers>`, "    <answernumbering>abc</answernumbering>");
  for (const option of options) {
    const answer = optionText(option);
    if (!answer) throw new ConvertError(`${title(question, index)} has an option with no text. Image-only answer choices must be recreated manually in Moodle.`);
    lines.push(`    <answer fraction="${decimal(isCorrect(option) ? correctFraction : wrongFraction)}" format="html">`, `      <text>${xml(answer)}</text>`, "      <feedback><text></text></feedback>", "    </answer>");
  }
  if (opts.includeTags) pushTags(lines, question, flexiType);
  lines.push("  </question>");
}

function convertShortanswer(lines: string[], question: Question, index: number, flexiType: string, options: Option[], opts: Required<MoodleOptions>) {
  let answers = options.filter(isCorrect).map(optionText).filter(Boolean);
  const fallback = text(question.answer || question.correct_answer);
  if (!answers.length && fallback) answers = [fallback];
  if (!answers.length) throw new ConvertError(`${title(question, index)} has no short-answer key.`);
  lines.push('  <question type="shortanswer">');
  common(lines, question, index);
  lines.push("    <usecase>0</usecase>");
  for (const answer of answers) lines.push('    <answer fraction="100" format="html">', `      <text>${xml(answer)}</text>`, "      <feedback><text></text></feedback>", "    </answer>");
  if (opts.includeTags) pushTags(lines, question, flexiType);
  lines.push("  </question>");
}

function convertEssay(lines: string[], question: Question, index: number, flexiType: string, opts: Required<MoodleOptions>) {
  lines.push('  <question type="essay">');
  common(lines, question, index);
  lines.push('    <answer fraction="0">', "      <text></text>", "    </answer>");
  if (opts.includeTags) pushTags(lines, question, flexiType);
  lines.push("  </question>");
}

export function convertQuestions(questions: Question[], options: MoodleOptions = {}): MoodleResult {
  const opts: Required<MoodleOptions> = {
    category: options.category || "",
    skipUnsupported: options.skipUnsupported ?? true,
    multiWrongPenalty: options.multiWrongPenalty || "proportional",
    shuffleAnswers: options.shuffleAnswers ?? true,
    includeTags: options.includeTags ?? true,
  };
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', "<quiz>"];
  const warnings: string[] = [];
  let convertedCount = 0;
  if (opts.category) lines.push('  <question type="category">', "    <category>", `      <text>$course$/${xml(opts.category)}</text>`, "    </category>", "  </question>");
  questions.forEach((question, offset) => {
    const index = offset + 1;
    const flexiType = normalizeType(question.type);
    const options = Array.isArray(question.options) ? question.options as Option[] : [];
    const block: string[] = [];
    try {
      if (MULTICHOICE.has(flexiType)) convertMultichoice(block, question, index, flexiType, options, opts);
      else if (SHORTANSWER.has(flexiType)) convertShortanswer(block, question, index, flexiType, options, opts);
      else if (ESSAY.has(flexiType)) convertEssay(block, question, index, flexiType, opts);
      else throw new ConvertError(`${title(question, index)} uses unsupported FlexiQuiz type '${flexiType || "unknown"}'.`);
      lines.push(...block);
      convertedCount += 1;
    } catch (error) {
      if (!opts.skipUnsupported) throw error;
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  });
  lines.push("</quiz>");
  return { xml: `${lines.join("\n")}\n`, warnings, convertedCount };
}
