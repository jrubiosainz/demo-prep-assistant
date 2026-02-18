/* ============================================================
   Meetings routes — powered by Work IQ MCP protocol.
   No direct Graph API calls or token management needed.
   ============================================================ */

const express = require("express");
const router = express.Router();
const { isAuthenticated } = require("../auth/msalConfig");
const { queryWorkIQ } = require("../lib/workiq");
const { generateStreaming, listModels: listCopilotModels } = require("../lib/copilot");

// Middleware — require Azure CLI auth
function requireAuth(_req, res, next) {
  if (!isAuthenticated()) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  next();
}

// --------------- GET /api/meetings ---------------
// Asks Work IQ for recent online meetings (Teams)
// and applies a best-effort transcript availability filter.
router.get("/meetings", requireAuth, async (_req, res) => {
  try {
    const unfilteredAnswer = await queryWorkIQ(
      "List my online Teams meetings from the last 7 days. " +
      "For each meeting, show subject/title, start date/time, end date/time, and organizer. " +
      "For dates, use whatever format is available — relative times like 'today at 10:00 AM' or 'yesterday at 3:00 PM' are fine, " +
      "or ISO 8601 (e.g. 2026-02-17T09:00:00) if available. Do NOT write 'Unknown' for dates — always provide the best available time, even if relative. " +
      "Return them as a markdown table ordered from newest to oldest."
    );

    // Best effort: if Work IQ provided transcript availability metadata,
    // keep only rows marked as transcript-available.
    const filteredAnswer = filterMeetingsTableByTranscriptAvailability(unfilteredAnswer);
    const answer = filteredAnswer || unfilteredAnswer;

    console.log("[Meetings] Work IQ response length:", unfilteredAnswer.length);
    console.log("[Meetings] First 500 chars:", unfilteredAnswer.substring(0, 500));
    if (filteredAnswer) {
      console.log("[Meetings] Applied transcript filter from metadata.");
    } else {
      console.log("[Meetings] Transcript metadata unavailable; returning unfiltered meetings to avoid empty list.");
    }

    res.json({ text: answer, source: "workiq" });
  } catch (err) {
    console.error("GET /api/meetings error:", err.message);
    res.status(500).json({
      error: "Failed to fetch meetings",
      details: err.message,
    });
  }
});

/**
 * Best-effort filter for markdown meeting tables.
 * If a transcript availability column exists, keep only rows marked as available.
 * If metadata is missing/ambiguous, return null so caller can safely use original table.
 */
function filterMeetingsTableByTranscriptAvailability(text) {
  if (!text) return null;

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  let headerIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (/\|/.test(lines[i]) && /subject|title/i.test(lines[i]) && /start/i.test(lines[i])) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) return null;

  const headerCells = splitTableRow(lines[headerIdx]);
  const transcriptColIdx = headerCells.findIndex((c) =>
    /(transcript|transcribed|ismeetingtranscribed|has\s*transcript)/i.test(c)
  );

  // No transcript metadata column => cannot filter safely
  if (transcriptColIdx === -1) return null;

  const separator = lines[headerIdx + 1] && lines[headerIdx + 1].includes("|")
    ? lines[headerIdx + 1]
    : `| ${headerCells.map(() => "---").join(" | ")} |`;

  const filteredRows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("|")) continue;
    if (/^\|?[\s\-:]+\|/.test(line) && !/[a-zA-Z0-9]/.test(line.replace(/[|\-:\s]/g, ""))) continue;

    const cells = splitTableRow(line);
    const marker = (cells[transcriptColIdx] || "").toLowerCase().trim();

    // Treat these as transcript-available
    if (/^(yes|true|available|exists|1)$/i.test(marker)) {
      filteredRows.push(line);
    }
  }

  // If no rows survive, do not force empty list (prevents regression)
  if (!filteredRows.length) return null;

  return [lines[headerIdx], separator, ...filteredRows].join("\n");
}

function splitTableRow(row) {
  return row.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

// --------------- GET /api/meetings/:subject/transcript ---------------
// Asks Work IQ for a meeting's transcript by subject + date
router.get("/meetings/transcript", requireAuth, async (req, res) => {
  try {
    const { subject, date } = req.query;

    // Work IQ natural-language retrieval with retries
    const queries = date
      ? [
          `Show me the transcript of the meeting "${subject}" on ${date}. ` +
            `List each speaker turn as "Speaker: what they said". Include all lines from start to finish. Do not summarize, do not omit lines, and do not use ellipsis.`,
          `Get the meeting transcript for "${subject}" on ${date}. Show every line with the speaker name and what they said. Return verbatim text only.`,
          `Retrieve the transcript content of "${subject}" held on ${date}. I need the full conversation with speaker names and no omissions.`,
        ]
      : [
          `Show me the transcript of the most recent meeting called "${subject}". ` +
            `List each speaker turn as "Speaker: what they said". Include all lines from start to finish. Do not summarize, do not omit lines, and do not use ellipsis.`,
          `Get the meeting transcript for the most recent "${subject}" meeting. Show every line with the speaker name and what they said. Return verbatim text only.`,
          `Retrieve the transcript content of the most recent "${subject}" meeting. I need the full conversation with speaker names and no omissions.`,
        ];

    let answer = "";
    for (let i = 0; i < queries.length; i++) {
      answer = await queryWorkIQ(queries[i], 600000); // 10 min timeout for long transcripts

      // Check if Work IQ actually returned transcript content (not a refusal)
      if (answer && !looksLikeRefusal(answer)) break;

      console.log(`[Transcript] Attempt ${i + 1} got refusal/empty, retrying…`);
    }

    // If Work IQ refuses verbatim transcript, try to get a direct transcript URL/path
    // and download the file content from there (best effort).
    if (looksLikeRefusal(answer)) {
      const dl = await tryDownloadTranscriptFromWorkIQLink(subject, date);
      if (dl?.text) {
        return res.json({
          text: dl.text,
          source: "workiq-url-download",
          transcriptUrl: dl.url,
        });
      }

      return res.json({
        text: answer,
        source: "workiq",
        transcriptUrl: dl?.url || null,
      });
    }

    // Clean Work IQ response: extract transcript, strip preamble/footer/markers
    answer = extractTranscriptContent(answer);

    res.json({ text: answer, source: "workiq" });
  } catch (err) {
    console.error("GET transcript error:", err.message);
    res.status(500).json({
      error: "Failed to fetch transcript",
      details: err.message,
    });
  }
});

/**
 * Ask Work IQ for transcript file location and try to download it.
 * Returns { url, text } when successful, otherwise { url } or null.
 */
async function tryDownloadTranscriptFromWorkIQLink(subject, date) {
  try {
    const q = date
      ? `For the meeting "${subject}" on ${date}, provide ONLY the direct transcript file location (single URL or file path). No explanation.`
      : `For the most recent meeting "${subject}", provide ONLY the direct transcript file location (single URL or file path). No explanation.`;

    const locationAnswer = await queryWorkIQ(q, 120000);
    const url = extractFirstUrl(locationAnswer);
    if (!url) return null;

    const text = await downloadTranscriptText(url);
    if (!text) return { url };
    return { url, text };
  } catch (err) {
    console.warn("[Transcript] URL download attempt failed:", err.message);
    return null;
  }
}

function extractFirstUrl(text) {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s)\]>"']+/i);
  return m ? m[0].trim() : null;
}

async function downloadTranscriptText(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "text/vtt,text/plain,text/*,application/octet-stream,*/*",
      },
    });
    clearTimeout(timer);

    if (!res.ok) return null;

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    const body = await res.text();
    if (!body || !body.trim()) return null;

    // Ignore likely HTML login pages / portals.
    if (contentType.includes("text/html") || /^\s*<!doctype html/i.test(body) || /<html/i.test(body.slice(0, 500))) {
      return null;
    }

    return body;
  } catch {
    return null;
  }
}

/**
 * Check if Work IQ's response is a refusal rather than actual transcript content.
 */
function looksLikeRefusal(text) {
  if (!text || text.length < 100) return true;
  const lower = text.toLowerCase();
  // Short response that says it can't provide the transcript
  if (
    lower.includes("i can't provide") ||
    lower.includes("i cannot provide") ||
    lower.includes("unable to provide") ||
    lower.includes("unable to retrieve") ||
    lower.includes("no transcript available") ||
    lower.includes("transcript is not available") ||
    lower.includes("don't have access to the transcript")
  ) {
    // Only treat as refusal if the response is short (a real transcript would be long)
    return text.length < 1000;
  }
  return false;
}

/**
 * Extract clean transcript content from Work IQ response.
 * Handles: code blocks (```text...```), preamble stripping,
 * {id=N} marker removal, and footer noise.
 */
function extractTranscriptContent(text) {
  if (!text) return text;

  // 1) Extract ALL code blocks (```text ... ``` or ``` ... ```) when present.
  // Some Work IQ answers split long transcripts into multiple blocks.
  const codeBlocks = [...text.matchAll(/```(?:text)?\s*\n([\s\S]*?)```/g)]
    .map((m) => (m[1] || "").trim())
    .filter(Boolean);

  let transcript;
  if (codeBlocks.length > 0) {
    transcript = codeBlocks.join("\n\n");
  } else {
    // 2) No code block — strip preamble (everything before first speaker line)
    transcript = stripWorkIQPreamble(text);
  }

  // 3) Remove {id=N} markers
  transcript = transcript.replace(/\s*\{id=\d+\}/g, "");

  // 4) Remove markdown link references [N](url...)
  transcript = transcript.replace(/\s*\[\d+\]\([^)]*\)/g, "");

  // 5) Strip known assistant footer noise (conservative)
  transcript = stripWorkIQFooter(transcript);

  return transcript.trim();
}

/**
 * Strip Work IQ preamble text that appears before the actual transcript.
 * Looks for the first line that looks like a speaker turn.
 */
function stripWorkIQPreamble(text) {
  if (!text) return text;
  const lines = text.split("\n");

  // Find the first line that looks like a transcript speaker line
  // Patterns: "Name: text", "> Name: text", "- Name: text", "**Name**: text"
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Speaker line patterns (name followed by colon and dialogue)
    if (/^>?\s*(?:\*\*)?[A-ZÀ-ÖØ-Þa-záéíóúñü][a-záéíóúñüA-ZÀ-ÖØ-Þ\s(),\/]+(?:\*\*)?:\s+\S/.test(line)) {
      // Make sure it's not a metadata line
      const label = line.replace(/^>?\s*(?:\*\*)?/, "").split(":")[0].trim().replace(/\*\*/g, "").toLowerCase();
      if (!/^(meeting|time|date|organizer|subject|start|end|note|important|below|here)/.test(label)) {
        return lines.slice(i).join("\n");
      }
    }
  }

  return text; // couldn't find speaker lines, return as-is
}

/**
 * Remove Work IQ footer noise from transcript responses.
 * This includes "Meeting details confirmed", "If you want, I can:",
 * follow-up suggestions, and source/metadata blocks.
 */
function stripWorkIQFooter(text) {
  if (!text) return text;

  const lines = text.split("\n");
  let cutIdx = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim().toLowerCase();

    // Detect footer markers
    if (
      line.includes("meeting details confirmed") ||
      line.includes("if you want, i can") ||
      line.includes("just tell me how") ||
      line.includes("do you want me to") ||
      line.includes("would you like me to") ||
      line.includes("fastest way to get") ||
      line.includes("why i can't") ||
      line.includes("what i can access")
    ) {
      cutIdx = i;
      break;
    }
  }

  return lines.slice(0, cutIdx).join("\n").trimEnd();
}

// --------------- GET /api/meetings/insights ---------------
// Asks Work IQ for AI insights / summary of a meeting
router.get("/meetings/insights", requireAuth, async (req, res) => {
  try {
    const { subject, date } = req.query;

    const question = date
      ? `Give me a summary and key action items from the meeting "${subject}" on ${date}.`
      : `Give me a summary and key action items from the most recent meeting called "${subject}".`;

    const answer = await queryWorkIQ(question);

    res.json({ text: answer, source: "workiq" });
  } catch (err) {
    console.error("GET insights error:", err.message);
    res.status(500).json({
      error: "Failed to fetch meeting insights",
      details: err.message,
    });
  }
});

// --------------- POST /api/ask ---------------
// Generic Work IQ question endpoint
router.post("/ask", requireAuth, async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) {
      return res.status(400).json({ error: "Missing 'question' in request body" });
    }

    const answer = await queryWorkIQ(question);

    res.json({ text: answer, source: "workiq" });
  } catch (err) {
    console.error("POST /api/ask error:", err.message);
    res.status(500).json({
      error: "Failed to query Work IQ",
      details: err.message,
    });
  }
});

// ======================== AI Plan Generation ========================

const PLAN_SYSTEM_PROMPT = `You are a Senior Microsoft Technical Solutions Architect specialized in pre-sales consulting and technical architecture design. You work with Microsoft's Customer Success team, helping sales engineers create compelling follow-up documents after customer meetings.

Analyze the meeting transcript provided and produce a comprehensive, visually rich technical plan and architecture document.

## OUTPUT STRUCTURE

### 1. \ud83d\udccb Executive Summary
Concise 3-5 sentence overview: customer challenge, proposed solution direction, and expected business impact.

### 2. \ud83c\udfd7\ufe0f Solution Architecture
Create a detailed architecture diagram using Mermaid syntax in a \`\`\`mermaid code block. Show:
- All Microsoft Azure services involved
- Microsoft 365 / Power Platform components
- Data flows between services (with labeled arrows)
- External integrations
- Security boundaries and layers
- User touchpoints

Use a graph TD (top-down) or graph LR (left-right) layout. Use subgraphs for logical groupings.
IMPORTANT: Each Mermaid statement MUST be on its own line. Never put multiple statements on one line.
Example of CORRECT multiline format:
\`\`\`mermaid
graph TD
  subgraph Frontend
    A[Web App]
    B[Mobile App]
  end
  A --> C[API Gateway]
  B --> C
\`\`\`

### 3. \ud83d\udd04 Logical Flow Diagram
Create a second Mermaid diagram showing the end-to-end logical sequence/workflow of how the solution operates. Use a sequenceDiagram or flowchart as appropriate.
IMPORTANT: Keep Mermaid statements on separate lines and ensure arrows/messages are valid Mermaid syntax.

### 4. \ud83d\udee0\ufe0f Microsoft Technology Stack
For each Microsoft product/service recommended, provide a detailed table:
| Service | Purpose | SKU/Tier | Est. Monthly Cost | Priority |
|---------|---------|----------|-------------------|----------|
Include licensing notes and prerequisites.

### 5. \ud83d\udcc5 Implementation Roadmap
Create a Gantt chart using Mermaid syntax (\`\`\`mermaid ... \`\`\`) with realistic phases:
- Phase 1: Discovery & Design (2-3 weeks)
- Phase 2: Foundation & Infrastructure Setup (3-4 weeks)
- Phase 3: Core Development & Configuration (4-8 weeks)
- Phase 4: Integration & Testing (2-3 weeks)
- Phase 5: Deployment & Go-Live (1-2 weeks)
Use VALID Mermaid Gantt syntax with at least these lines:
- gantt
- title ...
- dateFormat YYYY-MM-DD
- section ...
- Task A :a1, 2026-01-01, 14d
If a valid gantt cannot be produced, output a valid Mermaid flowchart roadmap instead (never output empty/partial diagram code).

### 6. \u26a0\ufe0f Risk Assessment & Technical Blockers
Risk matrix table:
| # | Risk | Probability | Impact | Mitigation Strategy |
|---|------|-------------|--------|---------------------|
Use indicators: \ud83d\udd34 High, \ud83d\udfe1 Medium, \ud83d\udfe2 Low

### 7. \ud83d\udca1 Recommendations & Next Steps
Numbered, prioritized list of immediate actions with ownership suggestions.

### 8. \ud83d\udcb0 Cost Estimation Summary
High-level cost breakdown organized by category (compute, storage, licensing, professional services). Include a Mermaid pie chart if applicable.

## CRITICAL RULES
1. Write in the SAME LANGUAGE as the meeting transcript
2. Be specific \u2014 use actual Microsoft product names, SKUs, and Azure service tiers
3. Every Mermaid diagram MUST be syntactically correct and renderable
3b. Never output Mermaid one-liners; always use multiline Mermaid syntax with one statement per line.
4. Base ALL recommendations on what was actually discussed in the transcript
5. If something wasn\u2019t discussed but is technically necessary, flag it as an assumption
6. Include realistic timelines and cost ranges based on typical Microsoft enterprise projects
7. Make the document suitable for sharing with C-level executives and technical leads
8. Use professional formatting with headers, tables, bold text, and emoji indicators throughout`;

// --------------- GET /api/models ---------------
// Returns available AI models from GitHub
router.get("/models", requireAuth, async (_req, res) => {
  try {
    const models = await listCopilotModels();
    res.json({ models });
  } catch (err) {
    console.error("GET /api/models error:", err.message);
    res.status(500).json({ error: "Failed to fetch models", details: err.message });
  }
});

// --------------- POST /api/generate-plan ---------------
// Generate technical plan from transcript using GitHub Copilot SDK (SSE streaming)
router.post("/generate-plan", requireAuth, async (req, res) => {
  try {
    const { transcript, model, subject } = req.body;

    if (!transcript) {
      return res.status(400).json({ error: "Missing transcript in request body" });
    }

    const selectedModel = model || "gpt-4.1";
    const requestId = `plan-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    console.log(`[Plan:${requestId}] Request received. model=${selectedModel}, subject=${subject || "Customer Meeting"}, transcriptLen=${transcript.length}`);

    // Set up SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const userMessage =
      `Meeting Subject: "${subject || "Customer Meeting"}"\n\nFull Meeting Transcript:\n\n${transcript}`;

    let abortHandle = null;

    // Abort on client disconnect
    req.on("close", () => {
      if (abortHandle) abortHandle.abort();
    });

    abortHandle = await generateStreaming({
      model: selectedModel,
      systemMessage: PLAN_SYSTEM_PROMPT,
      userMessage,
      onDelta(delta) {
        if (delta && delta.trim()) {
          // lightweight streaming diagnostics
          console.log(`[Plan:${requestId}] delta(${delta.length})`);
        }
        // Wrap in OpenAI-compatible SSE format so the frontend parser works unchanged
        const payload = JSON.stringify({
          choices: [{ delta: { content: delta } }],
        });
        res.write(`data: ${payload}\n\n`);
      },
      onDone(_fullText) {
        console.log(`[Plan:${requestId}] done. fullLen=${(_fullText || "").length}`);
        res.write("data: [DONE]\n\n");
        res.end();
      },
      onError(errMsg) {
        console.error(`[Plan:${requestId}] error:`, errMsg);
        res.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      },
    });
  } catch (err) {
    console.error("POST /api/generate-plan error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to generate plan", details: err.message });
    } else {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }
});

module.exports = router;
