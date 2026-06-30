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
export FLEXIQUIZ_JWT_SECRET="your-flexiquiz-sso-secret"
npm run deploy
```

`npm run deploy` runs `npm run cf:bootstrap` first. The bootstrap script:

- creates or reuses the D1 database named `fqreports`
- creates or reuses the R2 bucket named `fqreports-exports`
- writes the D1 database id into `wrangler.jsonc`
- applies the D1 migrations remotely
- uploads `FLEXIQUIZ_API_KEY` and `FLEXIQUIZ_JWT_SECRET` as Cloudflare secrets when the env vars are present
- deploys the Worker and static assets

If the secret is not available during bootstrap, set it later:

```sh
wrangler secret put FLEXIQUIZ_API_KEY
wrangler secret put FLEXIQUIZ_JWT_SECRET
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
FLEXIQUIZ_JWT_SECRET=your-flexiquiz-sso-secret
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

The SCORM export intentionally does not copy questions or answers into Moodle. It packages a small SCO wrapper that creates a FlexiQuiz SSO session for the Moodle learner, embeds the live FlexiQuiz quiz, polls FlexiQuiz for the submitted response, and writes the resulting score/pass-fail values back to Moodle through the SCORM 1.2 API.

Moodle SCORM exposes `student_id` and `student_name` to the package, but not a guaranteed email field. If Moodle's `student_id` is an email address, the bridge uses it as the FlexiQuiz username/email. Otherwise, it creates a stable FlexiQuiz username from the Moodle student id and carries the learner name into FlexiQuiz.

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
