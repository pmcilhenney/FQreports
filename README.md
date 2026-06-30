# FQ Reports

Cloudflare Worker app for FlexiQuiz reports.

It has two modules:

- Moodle Export: converts FlexiQuiz response-question data into Moodle XML for Navigate imports.
- SCORM Export: builds a Moodle-uploadable SCORM 1.2 launcher package that opens the live FlexiQuiz quiz.
- Reports: runs analytics across one or more quizzes, filters by date/status/pass-fail/search, and exports CSV.

The app uses the FlexiQuiz API directly. Full authored question detail for Moodle exports comes from:

```text
GET /v1/quizzes/{quiz_id}/responses/{response_id}/questions
```

## Cloudflare Setup

This repo is meant to bootstrap an empty Cloudflare project from the Git checkout.

```sh
npm install
wrangler login
export FLEXIQUIZ_API_KEY="your-flexiquiz-key"
npm run deploy
```

`npm run deploy` runs `npm run cf:bootstrap` first. The bootstrap script:

- creates or reuses the D1 database named `fqreports`
- creates or reuses the R2 bucket named `fqreports-exports`
- writes the D1 database id into `wrangler.jsonc`
- applies the D1 migrations remotely
- uploads `FLEXIQUIZ_API_KEY` as a Cloudflare secret when the env var is present
- deploys the Worker and static assets

If the secret is not available during bootstrap, set it later:

```sh
wrangler secret put FLEXIQUIZ_API_KEY
wrangler deploy
```

For Cloudflare Git deployments, set the build/deploy command to:

```sh
npm run deploy
```

That keeps the first deploy from expecting D1/R2 bindings to already exist.

## Local Development

Create `.dev.vars`:

```sh
FLEXIQUIZ_API_KEY=your-flexiquiz-key
```

Start the Worker locally:

```sh
npm run dev
```

Open:

```text
http://127.0.0.1:4317
```

## Validate

```sh
npm run check
python3 -m unittest
```

## SCORM Export Notes

The SCORM export intentionally does not copy questions or answers into Moodle. It packages a small SCO wrapper that launches the live FlexiQuiz URL, so FlexiQuiz remains the source of truth for scoring, responses, and review/audit history.

Because the hosted FlexiQuiz page is cross-origin, the SCORM package cannot reliably read the learner's FlexiQuiz score from inside Moodle. The package records SCORM launch/completion interaction only. Use the reports module or FlexiQuiz itself for authoritative pass/fail and score reporting.

## Legacy Python CLI

The original local converter is still available for one-off command-line use:

```sh
python3 flexiquiz_to_moodle.py list-quizzes
python3 flexiquiz_to_moodle.py export \
  --quiz-id "flexiquiz-quiz-id" \
  --output exports/exam.moodle.xml \
  --raw-output exports/exam.flexiquiz.json \
  --category "EMS Academy/Exam"
```

The Worker implementation is now the primary web app path.
