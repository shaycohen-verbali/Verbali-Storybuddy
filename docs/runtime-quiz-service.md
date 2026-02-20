# Runtime Quiz Service

Server-side runtime service that consumes a loaded Q&A-ready package and turns a question into MCQ answers + consistent images.

## Endpoints

## `POST /api/runtime-load-book`
Load/cache one book package by `book_id`.

Request:
```json
{
  "book_id": "book_h1234",
  "qa_ready_package": { "...": "..." },
  "style_references": [
    { "mimeType": "image/jpeg", "data": "...", "kind": "scene", "source": "pdf_page" }
  ]
}
```

Response fields:
- `book_id`
- `session_id`
- `book_package_hash`
- `text_quality`
- `entity_count`
- `style_ref_count`
- `style_ref_image_id_count`

## `POST /api/runtime-plan`
Step 2 only: build text quiz plan (no images yet).

Request:
```json
{
  "book_id": "book_h1234",
  "question_text": "Where does the story happen?",
  "difficulty": "easy"
}
```

Response fields:
- `qa_plan_id`
- `choices[]` (`A/B/C` answer text)
- `internal.correct_choice_id`
- debug entity resolution info

## `POST /api/runtime-render`
Step 3: generate A/B/C images from an existing `qa_plan_id`.

Request:
```json
{ "qa_plan_id": "plan_xxx" }
```

Response fields:
- `images[]` with `choice_id`, `image_id`, `storage_uri`, `image_data_url`

## `POST /api/runtime-quiz`
Combined flow: plan + image fan-out in one request.

Request:
```json
{
  "book_id": "book_h1234",
  "question_text": "Where does the story happen?",
  "difficulty": "easy"
}
```

Response fields:
- `choices[]` with answer text + generated image
- `internal.correct_choice_id`

## `GET|POST /api/runtime-events`
Fetch runtime event logs for analytics/debug.

Filters:
- `book_id`
- `qa_plan_id`
- `limit`

## Runtime internals implemented
- Book package cache keyed by `book_id`, invalidated by `book_package_hash`.
- Entity resolver with normalized alias matching + light fuzzy fallback.
- Single orchestrator LLM call for MCQ + scene plans + prompt packages.
- One repair call when orchestrator JSON is malformed.
- Strict post-parse contract checks (3 choices, 1 correct, wrongness diversity).
- Plan persistence in memory (`qa_plan_id`, request hash, prompt packages, raw LLM output).
- Parallel Nano Banana Pro image fan-out with global concurrency cap.
- Deterministic output path format:
  - `generated/<book_id>/<session_id>/<question_id>/<choice_id>.png`
