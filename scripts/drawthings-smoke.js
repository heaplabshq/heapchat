#!/usr/bin/env node
/* Live smoke test for the Draw Things HTTP API integration.
   In the Draw Things app turn on Advanced → API Server (Protocol: HTTP, default :7860), then:

     node scripts/drawthings-smoke.js [url] [model]

   e.g.  node scripts/drawthings-smoke.js http://localhost:7860 sd_v1.5_f16.ckpt

   It (1) lists installed models to confirm connectivity, then
   (2) generates one small image and writes it to scripts/_dt-smoke.png.
   This is the one round-trip that can only be verified against a live server. */
const fs = require("fs");
const path = require("path");
const { dtEcho, dtGenerate } = require("../src/media/drawthings");

const url = process.argv[2] || process.env.DRAWTHINGS_URL || "http://localhost:7860";
let model = process.argv[3] || process.env.DRAWTHINGS_MODEL || "";

(async () => {
  console.log(`→ Echo ${url} …`);
  const echo = await dtEcho({ url });
  console.log(`  ok. serverId=${echo.serverIdentifier} sharedSecretMissing=${echo.sharedSecretMissing}`);
  const models = (echo.files || []).filter(f => /\.(ckpt|safetensors|pt|gguf)$/i.test(f));
  console.log(`  files reported: ${(echo.files || []).length} — model-like: ${models.length ? models.join(", ") : "(none)"}`);
  if (echo.sharedSecretMissing) { console.error("  ✗ server needs a shared secret; re-run with one wired in."); process.exit(2); }

  if (!model) model = models[0];
  if (!model) { console.error("  ✗ no model to test with — install one in Draw Things or pass it as arg 2."); process.exit(2); }

  console.log(`→ Generate with "${model}" (384×384, 8 steps) …`);
  const t0 = Date.now();
  const { images } = await dtGenerate({
    url, model, prompt: "a red apple on a wooden table, studio light",
    width: 384, height: 384, steps: 8,
    onProgress: ({ step }) => process.stdout.write(`\r  step ${step}   `),
  });
  const out = path.join(__dirname, "_dt-smoke.png");
  fs.writeFileSync(out, images[0].png);
  console.log(`\n  ✓ ${images.length} image(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${out} (${images[0].width}×${images[0].height})`);
})().catch(e => { console.error("\n✗ FAILED:", e.message); process.exit(1); });
