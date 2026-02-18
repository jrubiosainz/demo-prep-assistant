/* ============================================================
   Copilot SDK client — singleton wrapper.
   Uses @github/copilot-sdk for GitHub Copilot-authenticated
   model inference. No manual tokens needed.
   ============================================================ */

const path = require("path");
const os = require("os");
const fs = require("fs");
const { execSync } = require("child_process");

let CopilotClient = null; // resolved lazily (ESM module)
let client = null;
let starting = null; // shared promise while starting

function getCopilotCliPath() {
  if (process.platform === "win32") {
    const candidates = [
      path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@github", "copilot", "npm-loader.js"),
      path.join(os.homedir(), "AppData", "Roaming", "npm", "copilot.cmd"),
      path.join(
        os.homedir(),
        "AppData",
        "Roaming",
        "Code - Insiders",
        "User",
        "globalStorage",
        "github.copilot-chat",
        "copilotCli",
        "copilot.bat"
      ),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  }

  // macOS/Linux or fallback if PATH resolution is supported by runtime
  return "copilot";
}

function getNodeExePath() {
  try {
    if (process.platform === "win32") {
      const out = execSync("where node", { encoding: "utf8", windowsHide: true, timeout: 5000 })
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const found = out.find((p) => fs.existsSync(p));
      return found || null;
    }
    return process.execPath;
  } catch {
    return null;
  }
}

/**
 * Lazily import the ESM-only SDK from CommonJS.
 */
async function loadSDK() {
  if (!CopilotClient) {
    const sdk = await import("@github/copilot-sdk");
    CopilotClient = sdk.CopilotClient;
  }
}

/**
 * Get (or create) the singleton CopilotClient.
 * Reuses the same client across all requests.
 */
async function getClient() {
  if (client) return client;

  if (starting) return starting; // another caller already booting

  starting = (async () => {
    await loadSDK();
    console.log("[Copilot] Starting CopilotClient…");
    const cliEntry = getCopilotCliPath();
    const nodeExe = getNodeExePath();

    // In Electron main process, process.execPath points to electron (older embedded Node).
    // Launching the Copilot CLI through external node.exe avoids runtime mismatches.
    const useNodeWrapper =
      process.platform === "win32" &&
      nodeExe &&
      cliEntry.toLowerCase().endsWith(".js");

    const cliPath = useNodeWrapper ? nodeExe : cliEntry;
    const cliArgs = useNodeWrapper ? [cliEntry, "--allow-all"] : ["--allow-all"];

    console.log("[Copilot] CLI entry:", cliEntry);
    console.log("[Copilot] CLI path:", cliPath);
    console.log("[Copilot] CLI args:", cliArgs);

    client = new CopilotClient({
      // Use installed GitHub Copilot CLI (logged-in user context).
      // On Windows + Electron, force external node.exe wrapper.
      cliPath,
      cliArgs,
      logLevel: "info",
    });
    await client.start();
    console.log("[Copilot] Client ready ✓");
    return client;
  })();

  try {
    const c = await starting;
    return c;
  } finally {
    starting = null;
  }
}

/**
 * Generate a streaming response via the Copilot SDK.
 *
 * @param {object} opts
 * @param {string} opts.model          — model id (e.g. "gpt-4.1")
 * @param {string} opts.systemMessage  — system prompt
 * @param {string} opts.userMessage    — user prompt
 * @param {(delta: string) => void}  opts.onDelta  — called for each text chunk
 * @param {(full: string) => void}   opts.onDone   — called when generation finishes
 * @param {(err: string) => void}    opts.onError  — called on error
 * @returns {Promise<{ abort: () => void }>}
 */
async function generateStreaming({ model, systemMessage, userMessage, onDelta, onDone, onError }) {
  const c = await getClient();

  console.log(`[Copilot] createSession model=${model}`);

  const session = await c.createSession({
    model,
    streaming: true,
    systemMessage: { content: systemMessage },
  });

  let fullContent = "";
  let finished = false;

  const finish = (fn, arg) => {
    if (finished) return;
    finished = true;
    fn(arg);
    session.destroy().catch(() => {});
  };

  const unsubscribe = session.on((event) => {
    try {
      // Useful diagnostics for plan generation issues
      if (event?.type) {
        console.log(`[Copilot] event=${event.type}`);
      }

      if (event.type === "assistant.message_delta") {
        const delta = event.data?.deltaContent;
        if (delta) {
          fullContent += delta;
          onDelta(delta);
        }
      } else if (event.type === "assistant.message") {
        // Some models/sessions may emit final message without deltas
        const content = event.data?.content || "";
        if (content && !fullContent) {
          fullContent = content;
          onDelta(content);
        }
      } else if (event.type === "session.idle") {
        unsubscribe();
        finish(onDone, fullContent);
      } else if (event.type === "session.error") {
        console.error("[Copilot] Session error:", event.data);
        unsubscribe();
        finish(onError, event.data?.message || "Copilot session error");
      }
    } catch (e) {
      console.error("[Copilot] Event handler error:", e);
    }
  });

  await session.send({ prompt: userMessage });

  return {
    abort: () => {
      unsubscribe();
      finished = true;
      session.destroy().catch(() => {});
    },
  };
}

/**
 * List models available for the currently authenticated Copilot account.
 */
async function listModels() {
  const c = await getClient();
  const models = await c.listModels();

  const enabled = (models || []).filter((m) => m?.policy?.state !== "disabled");

  return enabled.map((m) => ({
    id: m.id,
    name: m.name || m.id,
    provider: inferProvider(m.id),
    description: buildModelDescription(m),
  }));
}

function inferProvider(modelId = "") {
  const id = modelId.toLowerCase();
  if (id.startsWith("gpt") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4") || id.startsWith("o5")) return "OpenAI";
  if (id.includes("claude")) return "Anthropic";
  if (id.includes("gemini")) return "Google";
  if (id.includes("llama")) return "Meta";
  if (id.includes("mistral")) return "Mistral";
  if (id.includes("deepseek")) return "DeepSeek";
  return "Other";
}

function buildModelDescription(model) {
  const tags = [];
  if (model?.capabilities?.supports?.vision) tags.push("vision");
  if (model?.capabilities?.supports?.reasoningEffort) tags.push("reasoning");
  if (Array.isArray(model?.supportedReasoningEfforts) && model.supportedReasoningEfforts.length) {
    tags.push(`effort:${model.supportedReasoningEfforts.join("/")}`);
  }
  return tags.join(" • ");
}

/**
 * Gracefully shut down the Copilot client (call on app exit).
 */
async function stopClient() {
  if (client) {
    try {
      await client.stop();
    } catch (_) {
      /* ignore */
    }
    client = null;
  }
}

module.exports = { getClient, generateStreaming, listModels, stopClient };
