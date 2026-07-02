# TODO: Rename the app (currently "Cortex")

**Why:** "Album" implies *photos*, but the app has grown into a **chat-first, local, fully-offline private AI** that works across all your files (docs, data, images), runs an agent with tools, charts, a trust/grounding layer, and can reach out to live data via MCP connectors. The name undersells it.

## Candidate names
Picked for: easy to say, distinctive, evokes *private / local / second-brain*. **Verify domain + trademark before committing** — some may be taken.

| Name | Pron. | Note |
|------|-------|------|
| **Hearth** | "harth" | Warm, private, "home for your data." On-theme. Minor spell/say friction. |
| ~~Cortex~~ | — | Liked, but **already an AI product** — avoid. |
| **Cairn** | KAIRN | Stack of stones marking a trail → "your knowledge, guiding you." Clean, uncommon. |
| **Burrow** | — | Private den; "burrow into your files." Friendly, easy. |
| **Mnemo** | NEM-oh | From *memory*; clearly "second brain." Brandable. |
| **Tome** | — | A book of knowledge; "your tome." One syllable. |
| Coined: **Mindra / Lumora / Cogna** | — | Almost certainly unclaimed; less grounded. |

**Leaning:** Cairn or Hearth. Drop the literal "AI" from the name; let a tagline carry it (e.g. "Cairn — a private, local AI for your files").

## When renaming, update:
- `public/index.html` → `<title>` and `<base>`-adjacent copy
- `public/js/app.jsx` → sidebar `brand-name` ("Cortex")
- `README.md` → title + body
- `server.js` → startup `console.log` banner
- Any in-app copy / empty-state text mentioning "Cortex"
- (Leave the `data/` dir and folder name as-is — internal only.)
