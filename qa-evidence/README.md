# QA Evidence store

Structure:

```
qa-evidence/
  manifest.json
  QA-001/
    recording.mp4          # gitignored
    final-state.png
    api-response.json      # redacted
    database-assertion.txt
    notes.md
  QA-002/
    ...
```

Initialize empty dirs:

```bash
npm run qa:evidence:init -- --all
```

Recordings and raw tokens must never be committed. Redacted supplemental JSON and
`manifest.json` may be committed after review.
