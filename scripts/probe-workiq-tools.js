const { spawn } = require("child_process");
const path = require("path");
const os = require("os");

const workiqPath = process.platform === "win32"
  ? path.join(os.homedir(), "AppData", "Roaming", "npm", "workiq.cmd")
  : "workiq";

const proc = spawn(workiqPath, ["mcp"], {
  stdio: ["pipe", "pipe", "pipe"],
  shell: true,
  windowsHide: true,
});

let buffer = "";

proc.stdout.on("data", (data) => {
  buffer += data.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const msg = JSON.parse(line);

      if (msg.result?.serverInfo) {
        proc.stdin.write(JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }) + "\n");
      }

      if (msg.id === 2 && msg.result?.tools) {
        console.log("TOOLS:");
        for (const t of msg.result.tools) {
          console.log(`- ${t.name} :: ${t.description || ""}`);
          if (t.inputSchema) {
            console.log(`  schema: ${JSON.stringify(t.inputSchema)}`);
          }
        }
        proc.kill();
        process.exit(0);
      }

      if (msg.error) {
        console.error("MCP error:", msg.error);
        proc.kill();
        process.exit(1);
      }
    } catch {
      // ignore non-json lines
    }
  }
});

proc.stderr.on("data", (d) => process.stderr.write(d.toString()));
proc.on("error", (e) => {
  console.error("Failed to start:", e.message);
  process.exit(1);
});

proc.stdin.write(JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "probe", version: "1.0.0" },
  },
}) + "\n");

setTimeout(() => {
  console.error("Timed out waiting for Work IQ MCP response.");
  proc.kill();
  process.exit(1);
}, 30000);
