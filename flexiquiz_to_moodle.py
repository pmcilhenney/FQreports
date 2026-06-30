#!/usr/bin/env python3
"""Export FlexiQuiz response-question JSON as Moodle XML.

FlexiQuiz's public API exposes authored question details through the
response-questions endpoint, so the usual workflow is:

1. List quizzes.
2. Pick a quiz and one complete response for that quiz.
3. Fetch that response's questions.
4. Convert the JSON payload to Moodle XML.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple
from xml.sax.saxutils import escape


API_BASE = "https://www.flexiquiz.com/api/v1"
SUPPORTED_MULTICHOICE_TYPES = {
    "radio_button",
    "dropdown",
    "drop_down",
    "single_choice",
    "multiple_choice",
    "checkbox",
    "check_box",
    "picture_choice",
}
SUPPORTED_SHORTANSWER_TYPES = {
    "matching_text",
    "match_text",
    "short_answer",
    "fill_in_the_blank",
    "fill_in_the_blanks",
    "fill_blank",
}
SUPPORTED_ESSAY_TYPES = {"free_text", "essay", "file_upload"}


class WorkflowError(Exception):
    """Raised when input data cannot be safely converted."""


class _HTMLTextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: List[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)

    def text(self) -> str:
        return " ".join(" ".join(self.parts).split())


@dataclass
class ConvertOptions:
    category: Optional[str] = None
    skip_unsupported: bool = False
    multi_wrong_penalty: str = "proportional"
    shuffle_answers: bool = True
    include_tags: bool = True


class FlexiQuizClient:
    def __init__(self, api_key: str, base_url: str = API_BASE, pause_seconds: float = 0.0) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.pause_seconds = pause_seconds

    def get(self, path: str) -> Any:
        if self.pause_seconds:
            time.sleep(self.pause_seconds)
        url = f"{self.base_url}{path}"
        request = urllib.request.Request(url, headers={"X-API-KEY": self.api_key})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                content_type = response.headers.get("Content-Type", "")
                body = response.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise WorkflowError(f"FlexiQuiz API returned HTTP {exc.code} for {path}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise WorkflowError(f"Could not reach FlexiQuiz API for {path}: {exc.reason}") from exc

        if "json" not in content_type.lower() and body[:1] not in (b"[", b"{"):
            return body
        return json.loads(body.decode("utf-8"))

    def quizzes(self) -> List[Dict[str, Any]]:
        return self.get("/quizzes")

    def responses(self, quiz_id: str) -> List[Dict[str, Any]]:
        return self.get(f"/quizzes/{quiz_id}/responses")

    def response_questions(self, quiz_id: str, response_id: str) -> List[Dict[str, Any]]:
        return self.get(f"/quizzes/{quiz_id}/responses/{response_id}/questions")


def normalize_type(raw_type: Any) -> str:
    return str(raw_type or "").strip().lower().replace(" ", "_").replace("-", "_")


def text_value(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def xml_text(value: Any) -> str:
    return escape(text_value(value), {'"': "&quot;"})


def bool_text(value: bool) -> str:
    return "true" if value else "false"


def pct(value: Decimal) -> str:
    rounded = value.quantize(Decimal("0.00001"), rounding=ROUND_HALF_UP).normalize()
    return format(rounded, "f")


def is_correct(option: Dict[str, Any]) -> bool:
    value = option.get("correct", False)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes", "y"}
    return bool(value)


def option_text(option: Dict[str, Any]) -> str:
    for key in ("text", "answer", "value", "label"):
        value = text_value(option.get(key))
        if value:
            return value
    return ""


def plain_text(value: Any) -> str:
    raw = text_value(value)
    if not raw:
        return ""
    parser = _HTMLTextExtractor()
    parser.feed(raw)
    extracted = parser.text()
    return extracted or " ".join(raw.split())


def truncate_title(value: str, limit: int = 90) -> str:
    value = " ".join(value.split())
    if len(value) <= limit:
        return value
    return value[: limit - 1].rstrip(" .,;:!?") + "..."


def question_title(question: Dict[str, Any], index: int) -> str:
    explicit = text_value(question.get("name") or question.get("title"))
    if explicit:
        return explicit
    title = truncate_title(plain_text(question.get("text") or question.get("question") or question.get("prompt")))
    if title:
        return title
    return f"Question {index}"


def question_text(question: Dict[str, Any]) -> str:
    value = text_value(question.get("text") or question.get("question") or question.get("prompt"))
    if not value:
        raise WorkflowError(f"Question {question.get('question_id') or ''} has no question text.")
    return value


def categories(question: Dict[str, Any]) -> List[str]:
    result = []
    for category in question.get("categories") or []:
        if isinstance(category, dict):
            name = text_value(category.get("name"))
        else:
            name = text_value(category)
        if name:
            result.append(name)
    return result


def write_text_node(lines: List[str], indent: int, tag: str, value: Any, attrs: str = "") -> None:
    pad = " " * indent
    attr_text = f" {attrs}" if attrs else ""
    lines.append(f"{pad}<{tag}{attr_text}>")
    lines.append(f"{pad}  <text>{xml_text(value)}</text>")
    lines.append(f"{pad}</{tag}>")


def write_common_question_header(lines: List[str], question: Dict[str, Any], index: int) -> None:
    write_text_node(lines, 4, "name", question_title(question, index))
    write_text_node(lines, 4, "questiontext", question_text(question), 'format="html"')
    defaultgrade = text_value(question.get("points_available") or question.get("points") or "1")
    lines.append(f"    <defaultgrade>{xml_text(defaultgrade)}</defaultgrade>")
    lines.append("    <penalty>0.3333333</penalty>")
    lines.append("    <hidden>0</hidden>")


def write_tags(lines: List[str], question: Dict[str, Any], flexi_type: str) -> None:
    tag_values = [f"flexiquiz:{flexi_type}"]
    question_id = text_value(question.get("question_id"))
    if question_id:
        tag_values.append(f"flexiquiz-id:{question_id}")
    tag_values.extend(categories(question))
    if not tag_values:
        return
    lines.append("    <tags>")
    for tag in tag_values:
        lines.append("      <tag>")
        lines.append(f"        <text>{xml_text(tag)}</text>")
        lines.append("      </tag>")
    lines.append("    </tags>")


def looks_true_false(options: Sequence[Dict[str, Any]]) -> bool:
    labels = {option_text(option).lower() for option in options}
    return labels == {"true", "false"}


def convert_truefalse(lines: List[str], question: Dict[str, Any], index: int, flexi_type: str, options: Sequence[Dict[str, Any]], include_tags: bool) -> None:
    lines.append('  <question type="truefalse">')
    write_common_question_header(lines, question, index)
    for label in ("true", "false"):
        option = next((item for item in options if option_text(item).lower() == label), None)
        fraction = "100" if option and is_correct(option) else "0"
        lines.append(f'    <answer fraction="{fraction}">')
        lines.append(f"      <text>{label}</text>")
        lines.append("      <feedback><text></text></feedback>")
        lines.append("    </answer>")
    if include_tags:
        write_tags(lines, question, flexi_type)
    lines.append("  </question>")


def convert_multichoice(lines: List[str], question: Dict[str, Any], index: int, flexi_type: str, options: Sequence[Dict[str, Any]], opts: ConvertOptions) -> None:
    if not options:
        raise WorkflowError(f"{question_title(question, index)} has no answer options.")
    correct_options = [option for option in options if is_correct(option)]
    if not correct_options:
        raise WorkflowError(f"{question_title(question, index)} has no correct answer marked.")

    single = flexi_type not in {"checkbox", "check_box", "multiple_choice"} and len(correct_options) == 1
    if looks_true_false(options) and single:
        convert_truefalse(lines, question, index, flexi_type, options, opts.include_tags)
        return

    correct_fraction = Decimal(100) if single else Decimal(100) / Decimal(len(correct_options))
    wrong_count = len(options) - len(correct_options)
    if opts.multi_wrong_penalty == "none" or single or wrong_count == 0:
        wrong_fraction = Decimal(0)
    else:
        wrong_fraction = Decimal(-100) / Decimal(wrong_count)

    lines.append('  <question type="multichoice">')
    write_common_question_header(lines, question, index)
    lines.append(f"    <single>{bool_text(single)}</single>")
    lines.append(f"    <shuffleanswers>{1 if opts.shuffle_answers else 0}</shuffleanswers>")
    lines.append("    <answernumbering>abc</answernumbering>")
    for option in options:
        answer_text = option_text(option)
        if not answer_text:
            raise WorkflowError(
                f"{question_title(question, index)} has an option with no text. "
                "Image-only answer choices must be recreated manually in Moodle."
            )
        fraction = correct_fraction if is_correct(option) else wrong_fraction
        lines.append(f'    <answer fraction="{pct(fraction)}" format="html">')
        lines.append(f"      <text>{xml_text(answer_text)}</text>")
        lines.append("      <feedback><text></text></feedback>")
        lines.append("    </answer>")
    if opts.include_tags:
        write_tags(lines, question, flexi_type)
    lines.append("  </question>")


def convert_shortanswer(lines: List[str], question: Dict[str, Any], index: int, flexi_type: str, options: Sequence[Dict[str, Any]], opts: ConvertOptions) -> None:
    answers = [option_text(option) for option in options if is_correct(option) and option_text(option)]
    if not answers:
        fallback = text_value(question.get("answer") or question.get("correct_answer"))
        if fallback:
            answers = [fallback]
    if not answers:
        raise WorkflowError(f"{question_title(question, index)} has no short-answer key.")

    lines.append('  <question type="shortanswer">')
    write_common_question_header(lines, question, index)
    lines.append("    <usecase>0</usecase>")
    for answer in answers:
        lines.append('    <answer fraction="100" format="html">')
        lines.append(f"      <text>{xml_text(answer)}</text>")
        lines.append("      <feedback><text></text></feedback>")
        lines.append("    </answer>")
    if opts.include_tags:
        write_tags(lines, question, flexi_type)
    lines.append("  </question>")


def convert_essay(lines: List[str], question: Dict[str, Any], index: int, flexi_type: str, opts: ConvertOptions) -> None:
    lines.append('  <question type="essay">')
    write_common_question_header(lines, question, index)
    lines.append('    <answer fraction="0">')
    lines.append("      <text></text>")
    lines.append("    </answer>")
    if opts.include_tags:
        write_tags(lines, question, flexi_type)
    lines.append("  </question>")


def convert_questions(questions: Sequence[Dict[str, Any]], opts: ConvertOptions) -> Tuple[str, List[str]]:
    lines = ['<?xml version="1.0" encoding="UTF-8"?>', "<quiz>"]
    warnings: List[str] = []

    if opts.category:
        lines.append('  <question type="category">')
        lines.append("    <category>")
        lines.append(f"      <text>$course$/{xml_text(opts.category)}</text>")
        lines.append("    </category>")
        lines.append("  </question>")

    for index, question in enumerate(questions, start=1):
        flexi_type = normalize_type(question.get("type"))
        options = question.get("options") or []
        if not isinstance(options, list):
            options = []
        question_lines: List[str] = []

        try:
            if flexi_type in SUPPORTED_MULTICHOICE_TYPES:
                convert_multichoice(question_lines, question, index, flexi_type, options, opts)
            elif flexi_type in SUPPORTED_SHORTANSWER_TYPES:
                convert_shortanswer(question_lines, question, index, flexi_type, options, opts)
            elif flexi_type in SUPPORTED_ESSAY_TYPES:
                convert_essay(question_lines, question, index, flexi_type, opts)
            else:
                raise WorkflowError(f"{question_title(question, index)} uses unsupported FlexiQuiz type '{flexi_type or 'unknown'}'.")
            lines.extend(question_lines)
        except WorkflowError as exc:
            if not opts.skip_unsupported:
                raise
            warnings.append(str(exc))

    lines.append("</quiz>")
    return "\n".join(lines) + "\n", warnings


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def save_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)
        handle.write("\n")


def save_text(path: Path, payload: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(payload, encoding="utf-8")


def api_key_from_args(args: argparse.Namespace) -> str:
    api_key = args.api_key or os.environ.get("FLEXIQUIZ_API_KEY")
    if not api_key:
        raise WorkflowError("Set FLEXIQUIZ_API_KEY or pass --api-key.")
    return api_key


def latest_submitted_response(responses: Sequence[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    submitted = [item for item in responses if text_value(item.get("status")).lower() == "submitted"]
    if not submitted:
        return None
    return sorted(submitted, key=lambda item: text_value(item.get("date_submitted")), reverse=True)[0]


def command_list_quizzes(args: argparse.Namespace) -> None:
    client = FlexiQuizClient(api_key_from_args(args), pause_seconds=args.pause)
    for quiz in client.quizzes():
        print(f"{quiz.get('quiz_id')}\t{quiz.get('status')}\t{quiz.get('name')}")


def command_list_responses(args: argparse.Namespace) -> None:
    client = FlexiQuizClient(api_key_from_args(args), pause_seconds=args.pause)
    for response in client.responses(args.quiz_id):
        print(
            f"{response.get('response_id')}\t{response.get('status')}\t"
            f"{response.get('date_submitted')}\t{response.get('first_name', '')} {response.get('last_name', '')}\t"
            f"{response.get('percentage_score', '')}"
        )


def command_fetch_questions(args: argparse.Namespace) -> None:
    client = FlexiQuizClient(api_key_from_args(args), pause_seconds=args.pause)
    response_id = args.response_id
    if not response_id:
        response = latest_submitted_response(client.responses(args.quiz_id))
        if not response:
            raise WorkflowError("No submitted responses found. Pass --response-id for a specific response.")
        response_id = response["response_id"]
    questions = client.response_questions(args.quiz_id, response_id)
    save_json(args.output, questions)
    print(f"Wrote {len(questions)} questions from response {response_id} to {args.output}")


def command_convert(args: argparse.Namespace) -> None:
    questions = load_json(args.input)
    if not isinstance(questions, list):
        raise WorkflowError("Input JSON must be the list returned by FlexiQuiz response questions.")
    xml, warnings = convert_questions(
        questions,
        ConvertOptions(
            category=args.category,
            skip_unsupported=args.skip_unsupported,
            multi_wrong_penalty=args.multi_wrong_penalty,
            shuffle_answers=not args.no_shuffle,
            include_tags=not args.no_tags,
        ),
    )
    save_text(args.output, xml)
    for warning in warnings:
        print(f"WARNING: {warning}", file=sys.stderr)
    print(f"Wrote Moodle XML for {len(questions) - len(warnings)} questions to {args.output}")


def command_export(args: argparse.Namespace) -> None:
    client = FlexiQuizClient(api_key_from_args(args), pause_seconds=args.pause)
    response_id = args.response_id
    if not response_id:
        response = latest_submitted_response(client.responses(args.quiz_id))
        if not response:
            raise WorkflowError("No submitted responses found. Pass --response-id for a specific response.")
        response_id = response["response_id"]
    questions = client.response_questions(args.quiz_id, response_id)
    if args.raw_output:
        save_json(args.raw_output, questions)
    xml, warnings = convert_questions(
        questions,
        ConvertOptions(
            category=args.category,
            skip_unsupported=args.skip_unsupported,
            multi_wrong_penalty=args.multi_wrong_penalty,
            shuffle_answers=not args.no_shuffle,
            include_tags=not args.no_tags,
        ),
    )
    save_text(args.output, xml)
    for warning in warnings:
        print(f"WARNING: {warning}", file=sys.stderr)
    print(f"Wrote Moodle XML for {len(questions) - len(warnings)} questions from response {response_id} to {args.output}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Convert FlexiQuiz API response-question JSON to Moodle XML.")
    parser.add_argument("--api-key", help="FlexiQuiz API key. Prefer FLEXIQUIZ_API_KEY in your shell.")
    parser.add_argument("--pause", type=float, default=0.0, help="Optional pause before each API request.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("list-quizzes", help="List quizzes available through the FlexiQuiz API.").set_defaults(func=command_list_quizzes)

    responses = subparsers.add_parser("list-responses", help="List responses for a quiz.")
    responses.add_argument("--quiz-id", required=True)
    responses.set_defaults(func=command_list_responses)

    fetch = subparsers.add_parser("fetch-questions", help="Fetch response-question JSON for a quiz.")
    fetch.add_argument("--quiz-id", required=True)
    fetch.add_argument("--response-id", help="Specific response to use. Defaults to latest submitted response.")
    fetch.add_argument("--output", type=Path, required=True)
    fetch.set_defaults(func=command_fetch_questions)

    convert = subparsers.add_parser("convert", help="Convert saved response-question JSON to Moodle XML.")
    add_conversion_args(convert)
    convert.add_argument("--input", type=Path, required=True)
    convert.add_argument("--output", type=Path, required=True)
    convert.set_defaults(func=command_convert)

    export = subparsers.add_parser("export", help="Fetch questions from FlexiQuiz and write Moodle XML.")
    add_conversion_args(export)
    export.add_argument("--quiz-id", required=True)
    export.add_argument("--response-id", help="Specific response to use. Defaults to latest submitted response.")
    export.add_argument("--output", type=Path, required=True)
    export.add_argument("--raw-output", type=Path, help="Optionally save the raw FlexiQuiz questions JSON.")
    export.set_defaults(func=command_export)
    return parser


def add_conversion_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--category", help="Moodle question-bank category to create/use, for example EMS Academy/Airway.")
    parser.add_argument("--skip-unsupported", action="store_true", help="Skip questions that cannot be converted instead of failing.")
    parser.add_argument(
        "--multi-wrong-penalty",
        choices=("proportional", "none"),
        default="proportional",
        help="For checkbox questions, give wrong answers a proportional negative fraction or no penalty.",
    )
    parser.add_argument("--no-shuffle", action="store_true", help="Disable Moodle answer shuffling.")
    parser.add_argument("--no-tags", action="store_true", help="Do not include FlexiQuiz metadata as Moodle tags.")


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        args.func(args)
    except WorkflowError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
