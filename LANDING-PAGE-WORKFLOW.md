# Landing page generation workflow

This note records the successful AURELIA House flow and how to use the same path with a local model.

## Successful reference

- Preview: `http://localhost:3000/generated/aurelia-house/index.html`
- HTML: `frontend/generated/aurelia-house/index.html`
- Saved project facts and original design brief: `frontend/generated/aurelia-house/chat-blueprint.json`
- Chat transcript: `frontend/generated/aurelia-house/chat-history.json`
- Engine used: OpenCode. This page was not generated with the Gemini API.

The page is explicitly presented as a fictional Gurugram concept. It uses “On Request” and “Details on request” for unknown property facts, marks RERA as not applicable, and uses original inline SVG imagery. It does not contain Prestige Parklane or Bengaluru content. Its Google Fonts stylesheet needs internet access in the visitor’s browser; the page has fallback fonts.

## What happened and why the final brief worked

The first visual brief requested Gurugram but did not name a project or provide facts. The dashboard still had Prestige Parklane selected, with Bengaluru-specific RERA and media. The backend correctly stopped that request rather than combine facts from two cities.

The successful prompt explicitly named `AURELIA House`, identified it as fictional, set its city, and marked unknown details as unavailable. The backend now recognizes a named fictional concept as its own facts source and ignores the selected dashboard project's identity and media. The page was generated through OpenCode and saved at the reference path above.

The first saved blueprint accidentally inherited Prestige Parklane's hero image URL from the hidden intake form even though the generated HTML did not use it. That stale reference has been removed from AURELIA's blueprint. The backend now skips dashboard intake media whenever a self-contained brief supplies project facts, preventing the same leak in future builds.

## Reproducing the workflow

1. Open the dashboard at `http://localhost:3000` and use the chat generation box.
2. Select **OpenCode** for OpenCode or a local model configured through OpenCode. The Gemini API key is not used in this path.
3. For a fictional concept, provide explicit fields for `Project name`, `Developer`, and `Location`, and clearly say it is fictional or imaginary. State that it is not a real or registered property. Mark unknown price, RERA, sizes, dates, approvals, amenities, contacts, and travel times as “On Request” or “Details on request.”
4. Add the visual direction, palette, page sections, imagery constraints, responsive behavior, and any interaction requirements. Do not leave a different property selected as the factual source; the self-contained concept brief should be the only source of identity and facts.
5. The backend recognizes a full-page brief, extracts its project identity, and treats an explicitly fictional concept as a standalone facts record. It reads the LandingPageAgent skill from `C:\Users\Lenovo\.gemini\config\skills\LandingPageAgent\SKILL.md` and sends the skill, project facts, and full brief to OpenCode.
6. OpenCode must write to `frontend/generated/<project-slug>/index.opencode-staging.html` and verify that it exists. The backend independently checks for a complete HTML document, project and developer names, any supplied RERA, city conflicts, and every requested hex color. If OpenCode reports done but the staged file is missing or invalid, the backend sends one repair instruction in the same session and checks again. It copies the staged file to `index.html` only after validation passes. Failed builds leave the previous live page in place.
7. The generated page, blueprint, and chat history are saved under `frontend/generated/<project-slug>/`.

The chat selector currently sends `generationEngine: "opencode"` or `generationEngine: "gemini"` to `/api/chat/message`. Use OpenCode for code-agent generation. Gemini is a separate direct API path and uses the Gemini key field in the chat panel; it is intended for full-page design briefs. OpenCode generation does not require a Gemini key.

For a real property, replace the fictional identity with verified project facts and matching media. A city-only art brief cannot safely reuse a different city’s RERA, contact details, map, or property images.

## Using a local LLM through OpenCode

The dashboard’s OpenCode path talks to the OpenCode server API; it does not call a model provider directly. The default server URL is `http://127.0.0.1:4096`. Set `JUSTFLIP_OPENCODE_SERVER_URL` only if OpenCode listens elsewhere. The backend creates a fresh OpenCode build session and submits the same skill-backed prompt. It does not specify a model in that request, so OpenCode’s configured default model is used.

To use a local LLM:

1. Configure and start the local model runtime (for example, a local inference server) and make the model available to OpenCode.
2. Configure OpenCode to use that local model as its default model, then start the OpenCode server on the same computer as this dashboard.
3. Confirm OpenCode’s build agent can use its file tools in this workspace and can create/edit the requested staging HTML file.
4. Keep the local model runtime, OpenCode server, and dashboard running; choose **OpenCode** in the dashboard and submit the brief.

This integration is model-provider independent at the dashboard boundary, so a local model can use the existing workflow through OpenCode. It has not yet been validated against a specific local model. The model must handle the long brief plus skill in its context window, produce a full HTML page, and work with OpenCode’s file tools. Smaller models may time out, omit palette colors, or produce incomplete HTML; validation will then keep the current live page unchanged. A local LLM does not need a Gemini API key. Browser assets such as Google Fonts may still need internet access even when inference runs locally.

### OpenCode reports “done” but no page exists

This happened during a NEER House attempt: the OpenCode transcript showed a `bash` call that only ran `mkdir`, followed by text claiming the HTML was written. The expected staging file was absent. The dashboard caught this and did not replace the page. The backend now instructs OpenCode to use a real file-writing tool and verify the exact path, then allows one automatic repair attempt. If it still fails, check that OpenCode's selected build agent/model has file-writing tools enabled and can write inside this project. Trust the filesystem validation, not a model's text saying it wrote a file.

## Direct local LLM connection is not implemented

Selecting OpenCode and configuring OpenCode to use a local model is supported by the current architecture. Selecting a local model directly in this dashboard, without OpenCode, is not currently supported. Do not tell users that a raw local model endpoint is already connected.

If direct local connection is requested, add it as a third provider while preserving OpenCode and Gemini:

1. Add a clear `Local LLM` chat option and settings for a local base URL and model name. Keep credentials, if the local server needs them, out of browser storage and chat history.
2. Add a backend adapter for the chosen local server API. If using an OpenAI-compatible endpoint, document that requirement and send the same generation prompt containing the LandingPageAgent skill, authoritative project facts, and full design brief.
3. For direct model calls, request the complete HTML as text, write it to the per-project staging file, and reuse the existing HTML, identity, city, and palette validator before replacing `index.html`. The local model need not have filesystem tools if the backend receives its complete HTML response.
4. Reuse the existing per-project staging lock and error behavior. On connection, timeout, truncated output, or validation failure, leave the current live page unchanged and show a useful error.
5. Add a local connection check, then verify against an actual running local model with the AURELIA brief. Check output completeness, exact palette, no stale project facts, and successful browser preview before claiming support.

The local model server must be reachable from the dashboard backend process. A model needs enough context for the long prompt plus skill and enough output capacity for a full page. Local inference avoids a Gemini key; it does not automatically make external page assets, such as Google Fonts, available offline.

## Relevant implementation

- `backend/server.js`: fictional-brief extraction, stale-dashboard-conflict checks, skill injection, OpenCode API integration, HTML validation, and staged publishing.
- `frontend/landing-page-studio.html`: OpenCode/Gemini selector and chat request payload.
- `frontend/generated/aurelia-house/`: successful output and saved source brief.
- `AGENTS.md`: short entry point telling future coding agents to read this workflow note first.
