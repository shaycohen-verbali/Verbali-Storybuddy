# PDF to Q&A-Ready Package

This document defines the setup pipeline that transforms an uploaded story PDF into a Q&A-ready package used by StoryBuddy turn generation.

## Goal
Given a book PDF, produce a package that supports:
- answer generation grounded in book text
- image consistency via style/entity references

## Package location
The package is generated in backend setup and returned as:
- `storyPack.qaReadyPackage`

It is persisted in IndexedDB under:
- `story_assets.metadata.qaReadyPackage`

## Pipeline
1. Ingest and validate PDF metadata.
2. Extract page-level text entries (`pagesText`) and quality score (`good|mixed|poor`).
3. Build page image manifest from stored style refs sourced from `pdf_page`.
4. Build style bible from scene refs.
5. Build entity catalog records (characters, objects, locations, scenes) with stable IDs.
6. Compute readiness checklist and final `qaReadyManifest`.

## Output schema (high-level)
`qaReadyPackage` contains:
- `version`
- `createdAt`
- `manifest`
- `pagesText`
- `pagesImages`
- `illustrationPages`
- `styleBible`
- `entityRecords`
- `qaReadyManifest`

## Runtime usage notes
- During turn generation, keep reference set small and stable.
- Always prioritize character gold refs when those characters are participants.
- Avoid random page refs as runtime grounding; prefer pinned style/entity refs.
