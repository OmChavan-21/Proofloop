ProofLoop - Build Spec (v2)

One-liner: AI that checks its own work. The user describes a small tool in plain English; ProofLoop writes tests first, writes the code, runs both in a sandbox, repairs its own failures, and only then shows the working tool with proof.

Audience: People who need small custom tools but cannot tell whether AI-written code is trustworthy (small-business owners, analysts, ops people, beginners). Do NOT pitch as "AI for education".

Hackathon: Meta Global AI Developer Hackathon. Track: Indie. Problem statement: Build for Your World. Rule: All code generation MUST use Meta models (Muse Spark Open via Baseten, and/or the Meta Model API). No other model inside the app. Rule: All work is built during the hackathon, in a public repo. Never commit secrets.

1. Core loop
Tests first: model call #1 turns the request into 5-8 JSON test cases (name, input, expected), including edge cases.
Code: call #2 writes a pure JS function solve(input) plus a small ui_html that uses it.
Run: the sandbox runs every test against solve (pass/fail, actual vs expected).
Repair: on any failure, send request + code + failing results back (call #3). Max 4 rounds.
Result: all pass -> show the live tool with "Verified: N/N tests passed". Still failing -> show honestly "Not fully verified: X/N passed". Never hide failures.
2. Engines
Primary (confirmed access): Muse Spark Open through Baseten.
OpenAI-compatible. Base URL: https://inference.baseten.co/v1
Model name must be exactly meta-models/muse-spark-open-1026
Key in .env as BASETEN_API_KEY (never in the browser or repo)
IMPORTANT: this model always reasons. Responses include reasoning; the parser must extract only the final answer and ignore the reasoning. Confirm the exact response shape from the first test call before writing the parser.
Secondary (to evaluate): Meta Model API (dev.meta.ai, $150 credits, needs payment method on file). Candidate models for multi-model use: Muse Spark (tests/planning), Muse Code (coding), Muse Image or SAM 3.1 (screenshot-to-tool stretch). Verify against the docs; do not assume.
Design the engine layer as one small adapter so the loop can switch engines. Using more than one Meta piece on purpose helps the "Use of Meta AI Tooling" score.
3. Architecture
Single-page web app (index.html) plus a tiny serverless proxy (/api/generate.js on Vercel or Cloudflare Worker) that holds the key.
Sandbox: <iframe sandbox="allow-scripts"> (NO allow-same-origin), loaded via srcdoc, results via postMessage, 3-second timeout. Two iframes: invisible test runner, visible tool preview.
/index.html        app UI + loop controller
/api/generate.js   serverless proxy to the model API
/.env              keys (never committed)
/.gitignore        includes .env
/README.md         what it is, how to run, how verification works
/SPEC.md           this file
4. Model contract

JSON only; strip code fences; wrap JSON.parse in try/catch; retry once on a parse failure.

Call #1: { "tests": [ { "name": "...", "input": [...], "expected": ... } ] }
Call #2: { "solve_js": "function solve(input){...}", "ui_html": "<div>...</div>" } (pure, deterministic, no network, no DOM in solve, no libraries)
Call #3 (repair): same shape as #2, given failing results. Deep-equality comparison on JSON values; thrown errors count as failures.
5. UI

Prompt box, "Build it" button, 3 clickable examples. Live loop timeline (demo centerpiece): "Writing tests -> Writing code -> Running 6 tests -> 2 failed -> Repairing (round 1) -> 6/6 passed". Tests table with pass/fail, expected vs actual on failures. Result panel with the working tool and a clickable verification badge. Polished on desktop and mobile; clear loading and error states.

6. Demo examples (must be reliable; keep cached fallbacks)
Grade calculator: marks -> letter grades + class average.
Text cleaner: trim, collapse spaces, title-case a list of names.
Unit converter: temperature/length with validation.
7. Definition of done (MVP)
 Request -> tests -> code -> run -> repair works end-to-end on Muse Spark Open
 Live loop panel and tests table update in real time
 Verified tool renders and works with a correct badge
 All 3 demos pass
 No key in the browser or repo
 README explains the idea and how verification works
 3-minute demo video recorded; submitted a day early (Nov 3)
8. Stretch (only after MVP is solid)

Second engine comparison (Meta Model API); screenshot-to-tool with Muse Image/SAM 3.1; shareable link to a verified tool.

9. Non-goals

No accounts, payments, or databases. No tools that need network access or large frameworks. No Verilog/hardware mode (that earlier project is not part of this submission).

10. First prompt to paste into Antigravity (Planning mode)

Read SPEC.md fully and make a plan before writing code. Build in this order: (1) project skeleton and a serverless proxy that reads BASETEN_API_KEY from .env, (2) a small engine adapter that calls the OpenAI-compatible Baseten endpoint with model meta-models/muse-spark-open-1026 and extracts only the final answer from the reasoning output, (3) the sandbox runner with timeout and postMessage results, (4) the loop controller (tests first, code, run, repair up to 4 rounds), (5) the live loop panel and tests table UI. Never put API keys in client code or commit .env. After each step, tell me how to run and check it.