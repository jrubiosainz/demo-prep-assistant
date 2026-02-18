/* ============================================================
   Work IQ — MCP protocol helper
   Spawns `workiq mcp` and communicates via JSON-RPC.
   Auth is handled internally by Work IQ (Azure CLI / Entra ID).
   ============================================================ */

const { spawn } = require("child_process");
const path = require("path");
const os = require("os");

/** Full path to the globally-installed workiq CLI */
function getWorkiqPath() {
  if (process.platform === "win32") {
    return path.join(os.homedir(), "AppData", "Roaming", "npm", "workiq.cmd");
  }
  return "workiq"; // macOS / Linux — rely on PATH
}

const WORKIQ_PATH = getWorkiqPath();

/**
 * Send a natural-language question to Work IQ via its MCP server.
 * Returns the text answer.
 * @param {string} question
 * @param {number} [timeoutMs=300000] — 5 min default
 * @returns {Promise<string>}
 */
function queryWorkIQ(question, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    console.log(`[WorkIQ] query: "${question}"`);

    const proc = spawn(WORKIQ_PATH, ["mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: true,
    });

    let stdout = "";
    let stderr = "";
    let requestSent = false;

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("WorkIQ query timed out"));
    }, timeoutMs);

    proc.stdout.on("data", (data) => {
      const chunk = data.toString();
      stdout += chunk;

      const lines = stdout.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line.trim());

          // 1. Server initialized → discover tools
          if (json.result && json.result.serverInfo && !requestSent) {
            requestSent = true;
            proc.stdin.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "tools/list",
                params: {},
              }) + "\n"
            );
          }

          // 2. tools/list response → call workiq_ask
          if (json.result && json.result.tools && json.id === 2) {
            const askTool = json.result.tools.find(
              (t) =>
                t.name === "workiq_ask" ||
                t.name === "ask" ||
                t.name.includes("ask")
            );

            if (askTool) {
              proc.stdin.write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 3,
                  method: "tools/call",
                  params: {
                    name: askTool.name,
                    arguments: { question },
                  },
                }) + "\n"
              );
            } else {
              clearTimeout(timer);
              proc.kill();
              resolve(
                "WorkIQ ask tool not found. Available: " +
                  json.result.tools.map((t) => t.name).join(", ")
              );
            }
          }

          // 3. tools/call response → extract text
          if (json.result && json.id === 3) {
            clearTimeout(timer);
            proc.kill();

            const content = json.result.content || json.result;
            if (Array.isArray(content)) {
              const text = content
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n");
              resolve(text || JSON.stringify(content));
            } else if (typeof content === "string") {
              resolve(content);
            } else {
              resolve(JSON.stringify(content, null, 2));
            }
          }

          // 4. Error
          if (json.error) {
            clearTimeout(timer);
            proc.kill();
            reject(
              new Error(json.error.message || JSON.stringify(json.error))
            );
          }
        } catch {
          // Not valid JSON yet — keep accumulating
        }
      }
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (stdout.trim()) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`workiq exited with code ${code}: ${stderr}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start workiq: ${err.message}`));
    });

    // Send MCP initialize
    proc.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "demo-prep-assistant", version: "1.0.0" },
        },
      }) + "\n"
    );
  });
}

module.exports = { queryWorkIQ };
