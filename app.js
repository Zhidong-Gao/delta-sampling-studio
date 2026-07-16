/* ============================================================
 *  Delta Sampling Studio — frontend logic
 *
 *  Constraints (user-driven):
 *   - Base   → SD 1.5  (locked, single dropdown option)
 *   - Target → SD 2.1  (locked, single dropdown option)
 *   - Adapted → SD 1.5 or one of its fine-tunes (user pick)
 *   - Adapters stack on the Adapted side: LoRA · LyCORIS · ControlNet
 *   - ControlNet supports preset thumbnails OR custom upload
 * ============================================================ */

const CONFIG = {
  COMFY_URL: "https://ceramic-revolutionary-specially-energy.trycloudflare.com",
  hasBackend: false,
};

const state = {
  loras: [{ name: "MoXinV1.safetensors", weight: 0.8 }],
  lycos: [],                // [{ name, weight }]
  cnetImage: null,          // { name, dataUrl, isPreset } | null — pre-selected in bootstrap
  clientId: crypto.randomUUID(),
  inflight: false,
};

const $ = (id) => document.getElementById(id);

const showToast = (msg, kind = "") => {
  const t = $("toast");
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove("show"), 3200);
};

// --------------------------- backend probe ---------------------------
async function checkBackend() {
  const pill = $("status");
  try {
    const res = await fetch(`${CONFIG.COMFY_URL}/system_stats`, { method: "GET" });
    if (!res.ok) throw new Error("not ok");
    CONFIG.hasBackend = true;
    pill.className = "status ok";
    pill.querySelector(".status-text").textContent = "ComfyUI online";
    populateModelDropdowns();
  } catch {
    CONFIG.hasBackend = false;
    pill.className = "status";
    pill.querySelector(".status-text").textContent = "preview mode";
  }
}

function prettyLabel(name) {
  return name.replace(/\.(safetensors|ckpt|pt|pth)$/i, "").replace(/_/g, " ");
}

function fillSelect(id, items, opts = {}) {
  const sel = $(id);
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = "";
  if (opts.placeholder) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = opts.placeholder;
    sel.appendChild(o);
  }
  items.forEach((name) => {
    const o = document.createElement("option");
    o.value = name;
    o.textContent = prettyLabel(name);
    if (name === (opts.defaultValue || current)) o.selected = true;
    sel.appendChild(o);
  });
}

async function populateModelDropdowns() {
  try {
    const res = await fetch(`${CONFIG.COMFY_URL}/object_info/CheckpointLoaderSimple`);
    const data = await res.json();
    const ckpts = data.CheckpointLoaderSimple.input.required.ckpt_name[0];
    const isSd21 = (n) => /v2[-_.]?1|sd[-_]?2/i.test(n);
    const sd15  = ckpts.filter((n) => !isSd21(n));
    const sd21  = ckpts.filter(isSd21);
    fillSelect("baseModel",    sd15.filter((n) => /^v1-5/i.test(n)),
               { defaultValue: "v1-5-pruned-emaonly.safetensors" });
    fillSelect("targetModel",  sd21,
               { defaultValue: "v2-1_768-ema-pruned.safetensors" });
    fillSelect("adaptedModel", sd15,
               { defaultValue: "chilloutmix_NiPrunedFp16Fix.safetensors" });
  } catch (e) { console.warn("ckpt dropdown populate:", e); }

  try {
    const res = await fetch(`${CONFIG.COMFY_URL}/object_info/LoraLoader`);
    const data = await res.json();
    const loras = data.LoraLoader.input.required.lora_name[0];
    fillSelect("loraPick", loras, { placeholder: "— pick LoRA —" });
  } catch (e) { console.warn("lora dropdown populate:", e); }
}

// --------------------------- λ slider ---------------------------
function bindLambda() {
  // value is read on demand via getLambda() at generate time
}
const getLambda = () => parseFloat($("lambdaSlider").value);

// --------------------------- adapter chips (LoRA / LyCORIS) ---------------------------
const shorten = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function renderAdapter(kind) {
  const arr = kind === "lora" ? state.loras : state.lycos;
  const host = $(kind === "lora" ? "loraList" : "lycoList");
  const label = kind === "lora" ? "LoRA" : "LyCORIS";
  if (arr.length === 0) {
    host.innerHTML = `<div class="adapter-empty">no ${label} loaded</div>`;
    return;
  }
  host.innerHTML = "";
  arr.forEach((a, i) => {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.innerHTML = `
      <span class="nm" title="${a.name}">${shorten(a.name, 28)}</span>
      <input class="w" type="number" step="0.05" min="-2" max="2" value="${a.weight.toFixed(2)}" />
      <span class="x" title="remove">×</span>
    `;
    chip.querySelector(".w").addEventListener("input", (e) => {
      arr[i].weight = parseFloat(e.target.value || "0");
    });
    chip.querySelector(".x").addEventListener("click", () => {
      arr.splice(i, 1);
      renderAdapter(kind);
    });
    host.appendChild(chip);
  });
}

function bindAdapterAdd() {
  $("addLora").addEventListener("click", () => {
    const name = $("loraPick").value;
    if (!name) { showToast("pick a LoRA from the dropdown first", "err"); return; }
    if (state.loras.some(l => l.name === name)) { showToast("already added", ""); return; }
    state.loras.push({ name, weight: 0.8 });
    renderAdapter("lora");
    $("loraPick").value = "";
  });
}

// --------------------------- ControlNet presets ---------------------------
/* All 20 preset buttons are pre-rendered in index.html as
 *   <button class="preset-thumb" data-cnet="canny" data-name="canny_1.png" hidden>...</button>
 * renderPresets just toggles the [hidden] attribute by data-cnet.
 * Click handlers are wired once at init by bindPresetClicks. */
function renderPresets(type) {
  document.querySelectorAll(".preset-thumb").forEach(btn => {
    btn.hidden = btn.dataset.cnet !== type;
    if (btn.dataset.cnet !== type) btn.classList.remove("active");
  });
  if (!type) state.cnetImage = null;
}

function bindPresetClicks() {
  document.querySelectorAll(".preset-thumb").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".preset-thumb").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.cnetImage = {
        name: btn.dataset.name,
        dataUrl: `presets/${btn.dataset.name}?v=2`,
        isPreset: true,
      };
      const drop = $("cnetDrop");
      drop.innerHTML = `<input type="file" id="cnetFile" accept="image/*" hidden /><span id="cnetDropInner">drop control image, or click to upload</span>`;
      $("cnetFile").addEventListener("change", () => {
        const f = $("cnetFile").files?.[0];
        if (f) handleCustomFile(f);
      });
    });
  });
}

// Promote custom-file handling so the rebound listener above can reuse it.
function handleCustomFile(f) {
  const r = new FileReader();
  r.onload = () => {
    state.cnetImage = { name: f.name, dataUrl: r.result, isPreset: false };
    document.querySelectorAll(".preset-thumb").forEach(b => b.classList.remove("active"));
    const drop = $("cnetDrop");
    drop.innerHTML = "";
    const img = document.createElement("img");
    img.src = r.result;
    img.alt = "control";
    drop.appendChild(img);
    const inp = document.createElement("input");
    inp.type = "file"; inp.id = "cnetFile"; inp.accept = "image/*"; inp.hidden = true;
    inp.addEventListener("change", () => {
      const ff = inp.files?.[0]; if (ff) handleCustomFile(ff);
    });
    drop.appendChild(inp);
  };
  r.readAsDataURL(f);
}

// --------------------------- ControlNet custom upload ---------------------------
function bindCnet() {
  const drop = $("cnetDrop");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drag"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("drag");
    const f = e.dataTransfer.files?.[0];
    if (f) handleCustomFile(f);
  });
  $("cnetFile").addEventListener("change", () => {
    const f = $("cnetFile").files?.[0];
    if (f) handleCustomFile(f);
  });
  const onCnetTypeChange = (e) => renderPresets(e.target.value);
  $("cnetType").addEventListener("change", onCnetTypeChange);
  $("cnetType").addEventListener("input",  onCnetTypeChange);
}

function bindSeed() {
  $("randomSeed").addEventListener("click", (e) => {
    e.preventDefault();
    $("seed").value = Math.floor(Math.random() * 2 ** 31);
  });
}

// --------------------------- workflow build ---------------------------
const cnetMap = {
  canny:  "control_v11p_sd15_canny.pth",
  depth:  "control_v11f1p_sd15_depth.pth",
  normal: "control_v11p_sd15_normalbae.pth",
  pose:   "control_v11p_sd15_openpose.pth",
  seg:    "control_v11p_sd15_seg.pth",
};

async function loadTemplate() {
  const res = await fetch("workflow_template.json");
  return await res.json();
}

function buildWorkflow(template) {
  const wf = JSON.parse(JSON.stringify(template));
  const get = (id) => wf[id]?.inputs;

  if (get("source"))  get("source").ckpt_name  = $("baseModel").value;
  if (get("adapted")) get("adapted").ckpt_name = $("adaptedModel").value;
  if (get("target"))  get("target").ckpt_name  = $("targetModel").value;

  let adaptedM = ["adapted", 0];
  let adaptedC = ["adapted", 1];
  state.loras.forEach((l, i) => {
    const nid = `lora_${i}`;
    wf[nid] = {
      class_type: "LoraLoader",
      inputs: {
        model: adaptedM,
        clip: adaptedC,
        lora_name: l.name,
        strength_model: l.weight,
        strength_clip: l.weight,
      },
    };
    adaptedM = [nid, 0];
    adaptedC = [nid, 1];
  });
  if (get("adapted_pos_text")) get("adapted_pos_text").clip = adaptedC;
  if (get("adapted_neg_text")) get("adapted_neg_text").clip = adaptedC;
  if (get("sampler"))          get("sampler").adapted_model = adaptedM;

  const posText = $("prompt").value || "a photo";
  for (const id of ["source_pos_text", "adapted_pos_text", "target_pos_text"]) {
    if (get(id)) get(id).text = posText;
  }
  // Negative prompt is baked into workflow_template.json and not user-editable.

  if (get("sampler")) {
    Object.assign(get("sampler"), {
      seed:           parseInt($("seed").value, 10),
      steps:          parseInt($("steps").value, 10),
      cfg:            parseFloat($("cfg").value),
      sampler_name:   $("sampler").value,
      scheduler:      $("scheduler").value,
      delta_strength: getLambda(),
      denoise:        1.0,
    });
  }

  if (get("latent")) {
    Object.assign(get("latent"), {
      width:  parseInt($("width").value, 10),
      height: parseInt($("height").value, 10),
      batch_size: 1,
    });
  }

  const cnetType = $("cnetType").value;
  if (cnetType && state.cnetImage) {
    if (get("cnet_load"))    get("cnet_load").control_net_name = cnetMap[cnetType];
    if (get("cnet_image"))   get("cnet_image").image           = state.cnetImage.name;
    if (get("adapted_cnet")) get("adapted_cnet").strength      = parseFloat($("cnetStrength").value);
  } else if (get("sampler")) {
    get("sampler").adapted_positive = ["adapted_pos_text", 0];
    get("sampler").adapted_negative = ["adapted_neg_text", 0];
    delete wf.cnet_load;
    delete wf.cnet_image;
    delete wf.adapted_cnet;
  }

  const clean = {};
  for (const k in wf) if (!k.startsWith("_")) clean[k] = wf[k];
  return clean;
}

// --------------------------- ComfyUI API ---------------------------
async function uploadControlImage() {
  if (!state.cnetImage) return null;
  // Preset images already live on the backend at full resolution; don't
  // re-upload the shrunk picker thumbnail and overwrite the original.
  if (state.cnetImage.isPreset) return null;
  const blob = await (await fetch(state.cnetImage.dataUrl)).blob();
  const fd = new FormData();
  fd.append("image", blob, state.cnetImage.name);
  fd.append("type", "input");
  const res = await fetch(`${CONFIG.COMFY_URL}/upload/image`, { method: "POST", body: fd });
  if (!res.ok) throw new Error("upload failed");
  return await res.json();
}

async function queuePrompt(wf) {
  const res = await fetch(`${CONFIG.COMFY_URL}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: wf, client_id: state.clientId }),
  });
  if (!res.ok) throw new Error("prompt rejected: " + await res.text());
  return await res.json();
}

function listenProgress(promptId, totalSteps) {
  return new Promise((resolve, reject) => {
    const wsBase = (CONFIG.COMFY_URL || location.origin).replace(/^http/, "ws");
    const ws = new WebSocket(`${wsBase}/ws?clientId=${state.clientId}`);
    let done = false;
    const finish = () => { if (!done) { done = true; try { ws.close(); } catch {} resolve(); } };
    const fail = (e) => { if (!done) { done = true; try { ws.close(); } catch {} reject(e); } };
    ws.onopen = async () => {
      // Cache-hit safety net: if the prompt finished in 0.00s (everything cached),
      // ComfyUI's "executing node=null" event fired before this WS attached and
      // was lost. Poll /history once on open to recover.
      try {
        const h = await fetch(`${CONFIG.COMFY_URL}/history/${promptId}`).then((r) => r.json());
        if (h && h[promptId]) finish();
      } catch {}
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      const msg = JSON.parse(ev.data);
      if (msg.type === "progress") {
        const v = msg.data.value, m = msg.data.max;
        setProgress(v / m, "denoising", v, m);
      } else if (msg.type === "executing") {
        if (msg.data.node === null && msg.data.prompt_id === promptId) finish();
      } else if (msg.type === "execution_error") {
        fail(new Error(msg.data?.exception_message || "execution failed"));
      }
    };
    ws.onerror = () => fail(new Error("ws connection lost"));
  });
}

async function fetchResultImage(promptId) {
  const h = await fetch(`${CONFIG.COMFY_URL}/history/${promptId}`).then((r) => r.json());
  const entry = h[promptId];
  if (!entry) throw new Error("history entry missing");
  for (const node of Object.values(entry.outputs || {})) {
    if (node.images && node.images.length) {
      const im = node.images[0];
      return `${CONFIG.COMFY_URL}/view?filename=${encodeURIComponent(im.filename)}&subfolder=${encodeURIComponent(im.subfolder || "")}&type=${encodeURIComponent(im.type || "output")}`;
    }
  }
  throw new Error("no image in history");
}

// --------------------------- UI state machine ---------------------------
function setProgress(frac, label, cur, max) {
  $("progressFill").style.right = `${Math.max(0, (1 - frac) * 100)}%`;
  if (label) $("loadingLabel").textContent = label;
  if (cur != null) $("progressStep").textContent = `${cur} / ${max}`;
}
function showState(which) {
  $("canvasEmpty").classList.toggle("hidden",   which !== "empty");
  $("canvasLoading").classList.toggle("hidden", which !== "loading");
  $("resultImg").classList.toggle("hidden",     which !== "result");
}

// --------------------------- mock generation (preview) ---------------------------
async function mockGenerate(steps) {
  showState("loading");
  setProgress(0, "queued", 0, steps);
  await new Promise((r) => setTimeout(r, 300));
  for (let i = 1; i <= steps; i++) {
    setProgress(i / steps, "denoising", i, steps);
    await new Promise((r) => setTimeout(r, 60));
  }
  $("resultImg").src = mockImage();
  showState("result");
}
function mockImage() {
  const p = ($("prompt").value || "delta sampling").slice(0, 48);
  const lam = getLambda().toFixed(2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 768 768">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#d5e8f7"/>
        <stop offset=".5" stop-color="#ffe3ec"/>
        <stop offset="1" stop-color="#fff4e6"/>
      </linearGradient>
      <radialGradient id="glow" cx="50%" cy="50%" r="50%">
        <stop offset="0" stop-color="#4d9de0" stop-opacity="0.30"/>
        <stop offset="1" stop-color="transparent"/>
      </radialGradient>
      <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2"/>
        <feColorMatrix values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 .08 0"/></filter>
    </defs>
    <rect width="768" height="768" fill="url(#g)"/>
    <rect width="768" height="768" fill="url(#glow)"/>
    <rect width="768" height="768" filter="url(#grain)" opacity="0.4"/>
    <text x="50%" y="46%" text-anchor="middle" font-family="-apple-system, sans-serif" font-weight="600" font-size="34" fill="#1d3557">${p}</text>
    <text x="50%" y="56%" text-anchor="middle" font-family="ui-monospace, monospace" font-size="13" fill="#4a6688" letter-spacing="2">PREVIEW · λ ${lam}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// --------------------------- generate ---------------------------
async function onGenerate() {
  if (state.inflight) return;
  state.inflight = true;
  $("generateBtn").disabled = true;
  const t0 = performance.now();

  try {
    if (!CONFIG.hasBackend) {
      await mockGenerate(parseInt($("steps").value, 10) || 20);
      showToast("Preview mode (no checkpoint models on Space)", "");
      return;
    }

    showState("loading");
    setProgress(0, "preparing workflow", 0, parseInt($("steps").value, 10));

    if (state.cnetImage) await uploadControlImage();
    const wf = buildWorkflow(await loadTemplate());
    const { prompt_id } = await queuePrompt(wf);

    await listenProgress(prompt_id, parseInt($("steps").value, 10));
    const url = await fetchResultImage(prompt_id);
    $("resultImg").src = url;
    showState("result");
    showToast("Generation complete", "ok");
  } catch (err) {
    console.error(err);
    showToast(err.message || "generation failed", "err");
    showState("empty");
  } finally {
    state.inflight = false;
    $("generateBtn").disabled = false;
  }
}

function bindShortcuts() {
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      onGenerate();
    }
  });
}

// --------------------------- bootstrap ---------------------------
window.addEventListener("DOMContentLoaded", () => {
  bindLambda();
  bindAdapterAdd();
  bindCnet();
  bindSeed();
  bindShortcuts();
  renderAdapter("lora");
  renderAdapter("lyco");
  bindPresetClicks();
  renderPresets($("cnetType").value);    // initial hide/show based on dropdown
  // Pre-select the bird depth preset to match the default prompt.
  document.querySelector('.preset-thumb[data-name="depth_1.png"]')?.click();

  $("generateBtn").addEventListener("click", onGenerate);
  checkBackend();
});
