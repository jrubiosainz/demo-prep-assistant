/* ============================================================
   Technical Delivery Architect — Frontend Logic
   Powered by Work IQ — no Graph API permissions needed.
   ============================================================ */

(function () {
  "use strict";

  // Initialize Mermaid.js (prevent auto-rendering on load)
  if (typeof mermaid !== "undefined") {
    mermaid.initialize({ startOnLoad: false, theme: "default" });
  }

  // Initialize marked.js
  if (typeof marked !== "undefined") {
    marked.use({ breaks: true, gfm: true });
  }

  // DOM refs
  const userArea = document.getElementById("userArea");
  const loginOverlay = document.getElementById("loginOverlay");
  const meetingList = document.getElementById("meetingList");
  const meetingsLoading = document.getElementById("meetingsLoading");
  const emptyState = document.getElementById("emptyState");
  const transcriptContent = document.getElementById("transcriptContent");
  const transcriptHeader = document.getElementById("transcriptHeader");
  const transcriptBody = document.getElementById("transcriptBody");
  const transcriptLoading = document.getElementById("transcriptLoading");
  const btnRefresh = document.getElementById("btnRefresh");

  // DOM refs — new: model selector, tabs, plan
  const modelSelector = document.getElementById("modelSelector");
  const btnGeneratePlan = document.getElementById("btnGeneratePlan");
  const tabTranscript = document.getElementById("tabTranscript");
  const tabPlan = document.getElementById("tabPlan");
  const transcriptTab = document.getElementById("transcriptTab");
  const planTab = document.getElementById("planTab");
  const planBody = document.getElementById("planBody");
  const planLoading = document.getElementById("planLoading");
  const planLoadingText = document.getElementById("planLoadingText");
  const themeToggle = document.getElementById("themeToggle");

  // Parsed meetings (extracted from Work IQ text)
  let meetings = [];
  let activeMeetingIdx = null;
  let currentTranscriptText = "";
  let currentMeeting = null;
  let isGeneratingPlan = false;

  // Theme state
  const THEME_KEY = "demo-prep-theme"; // light | dark | system
  let themeMode = "system";

  // DOM refs — login screen
  const btnLogin = document.getElementById("btnLogin");
  const loginStatus = document.getElementById("loginStatus");
  const loginStatusText = document.getElementById("loginStatusText");
  const loginError = document.getElementById("loginError");

  // Detect if running inside Electron
  const isElectron = !!(window.electronAPI);

  // ===================== Boot =====================
  async function init() {
    initTheme();

    if (isElectron) {
      const status = await window.electronAPI.getAuthStatus();
      if (status.authenticated) {
        loginOverlay.classList.add("hidden");
        showUser(status.name);
        loadMeetings();
        loadModels();
        return;
      }
      loginOverlay.classList.remove("hidden");
      return;
    }

    // Browser fallback
    const me = await api("/api/me");
    if (me.authenticated) {
      loginOverlay.classList.add("hidden");
      showUser(me.name);
      loadMeetings();
      loadModels();
    }
  }

  function initTheme() {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === "light" || saved === "dark" || saved === "system") {
        themeMode = saved;
      }
    } catch {}

    applyTheme(themeMode);

    if (themeToggle) {
      themeToggle.addEventListener("click", cycleTheme);
      updateThemeToggleLabel();
    }

    const media = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
    if (media && media.addEventListener) {
      media.addEventListener("change", () => {
        if (themeMode === "system") applyTheme("system");
      });
    }
  }

  function getResolvedTheme(mode) {
    if (mode === "light" || mode === "dark") return mode;
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    return prefersDark ? "dark" : "light";
  }

  function applyTheme(mode) {
    const resolved = getResolvedTheme(mode);
    document.body.setAttribute("data-theme", resolved);
    updateThemeToggleLabel();
    // Sync Mermaid theme
    if (typeof mermaid !== "undefined") {
      mermaid.initialize({
        startOnLoad: false,
        theme: resolved === "dark" ? "dark" : "default",
        securityLevel: "loose",
        fontFamily: '"Segoe UI", sans-serif',
      });
    }
  }

  function cycleTheme() {
    const order = ["system", "light", "dark"];
    const idx = order.indexOf(themeMode);
    themeMode = order[(idx + 1) % order.length];
    try {
      localStorage.setItem(THEME_KEY, themeMode);
    } catch {}
    applyTheme(themeMode);
  }

  function updateThemeToggleLabel() {
    if (!themeToggle) return;
    const labels = {
      system: "🌓 System",
      light: "☀️ Light",
      dark: "🌙 Dark",
    };
    themeToggle.textContent = labels[themeMode] || "🌓 System";
  }

  // ===================== Login button handler =====================
  async function handleLogin() {
    btnLogin.classList.add("hidden");
    loginError.classList.add("hidden");
    loginStatus.classList.remove("hidden");
    loginStatusText.textContent = "Opening browser for sign-in…";

    try {
      const result = await window.electronAPI.login();

      if (result.success) {
        loginStatusText.textContent = `Welcome, ${result.name}!`;
        setTimeout(() => {
          loginOverlay.classList.add("hidden");
          showUser(result.name);
          loadMeetings();
          loadModels();
        }, 600);
      } else {
        loginStatus.classList.add("hidden");
        btnLogin.classList.remove("hidden");
        loginError.textContent = result.error || "Sign-in failed. Please try again.";
        loginError.classList.remove("hidden");
      }
    } catch (err) {
      loginStatus.classList.add("hidden");
      btnLogin.classList.remove("hidden");
      loginError.textContent = err.message || "Sign-in failed. Please try again.";
      loginError.classList.remove("hidden");
    }
  }

  if (btnLogin) {
    btnLogin.addEventListener("click", handleLogin);
  }

  function showUser(name) {
    userArea.innerHTML = `
      <span class="user-name">${escHtml(name)}</span>
      <a href="#" id="logoutLink">Sign out</a>
    `;
    document.getElementById("logoutLink").addEventListener("click", async (e) => {
      e.preventDefault();
      if (isElectron) {
        await window.electronAPI.logout();
      } else {
        await fetch("/auth/logout");
      }
      loginOverlay.classList.remove("hidden");
      btnLogin.classList.remove("hidden");
      loginStatus.classList.add("hidden");
      loginError.classList.add("hidden");
      meetingList.innerHTML = "";
      emptyState.classList.remove("hidden");
      transcriptContent.classList.add("hidden");
      userArea.innerHTML = "";
    });
  }

  // ===================== Load meetings via Work IQ =====================
  async function loadMeetings() {
    meetingList.innerHTML = "";
    meetingsLoading.classList.remove("hidden");

    try {
      const data = await api("/api/meetings");
      const text = data.text || "";

      console.log("[Meetings] Raw Work IQ response:", text);

      // Try to parse meeting entries from Work IQ text
      meetings = parseMeetingsFromText(text);
      console.log("[Meetings] Parsed:", meetings.length, "meetings", meetings);

      if (meetings.length > 0) {
        renderTimeline();
      } else {
        // Show raw text if we couldn't parse structured data
        renderRawMeetings(text);
      }
    } catch (err) {
      meetingList.innerHTML = `<div class="no-meetings">Failed to load meetings.<br>${escHtml(err.message)}</div>`;
    } finally {
      meetingsLoading.classList.add("hidden");
    }
  }

  // ===================== Parse meetings from Work IQ markdown table =====================
  /**
   * Work IQ returns a markdown table like:
   *   | # | Subject | Start | End | Organizer |
   *   |---|---------|-------|-----|-----------|
   *   | 1 | Title   | 2026-01-26T08:00:00 | 2026-01-26T09:00:00 | Name |
   *
   * Or sometimes without #, or with extra columns. We detect the header row
   * and map columns by name.
   */
  function parseMeetingsFromText(text) {
    if (!text) return [];

    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

    // Find the header row (contains "Subject" or "Title" and "Start")
    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/\|/.test(lines[i]) && /subject|title/i.test(lines[i]) && /start/i.test(lines[i])) {
        headerIdx = i;
        break;
      }
    }

    // If no markdown table found, try fallback parsing
    if (headerIdx === -1) return parseMeetingsFallback(text);

    // Parse header to get column indices
    const headerCells = splitTableRow(lines[headerIdx]);
    const colMap = {};
    headerCells.forEach((cell, idx) => {
      const c = cell.toLowerCase();
      if (c.includes("subject") || c.includes("title")) colMap.subject = idx;
      else if (c.includes("start")) colMap.start = idx;
      else if (c.includes("end")) colMap.end = idx;
      else if (c.includes("organizer") || c.includes("organized")) colMap.organizer = idx;
    });

    if (colMap.subject === undefined || colMap.start === undefined) {
      return parseMeetingsFallback(text);
    }

    // Parse data rows (skip header and separator)
    const results = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      // Skip separator rows like |---|---|---|
      if (/^\|?[\s\-:]+\|/.test(line) && !/[a-zA-Z0-9]/.test(line.replace(/[|\-:\s]/g, ""))) continue;
      // Must be a table row
      if (!line.includes("|")) continue;

      const cells = splitTableRow(line);
      const subject = cleanCell(cells[colMap.subject] || "");
      if (!subject) continue;

      const startRaw = cleanCell(cells[colMap.start] || "");
      const endRaw = colMap.end !== undefined ? cleanCell(cells[colMap.end] || "") : "";
      const organizer = colMap.organizer !== undefined ? cleanCell(cells[colMap.organizer] || "") : "";

      // Parse dates
      const startDate = parseFlexDate(startRaw);
      const endDate = parseFlexDate(endRaw);

      results.push({
        subject,
        start: startDate,
        end: endDate,
        organizer,
        startRaw,
        endRaw,
      });
    }

    return results;
  }

  /** Split a markdown table row into cells */
  function splitTableRow(row) {
    // Remove leading/trailing pipes and split
    return row.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  }

  /** Clean a cell: remove bold markers, link syntax, etc. */
  function cleanCell(cell) {
    return cell
      .replace(/\*\*/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) → text
      .replace(/\s*\[\d+\]/g, "")                // [1] footnotes
      .trim();
  }

  /** Parse a date string into a Date object. Handles ISO, relative dates, many formats. */
  function parseFlexDate(str) {
    if (!str) return null;

    // Normalize: replace en-dashes, non-breaking hyphens, em-dashes with regular hyphens
    let s = str
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-")
      .replace(/\*\*/g, "")
      .replace(/\s*\[\d+\]\([^)]*\)/g, "") // remove [1](url) refs
      .replace(/\s*\[\d+\]/g, "")           // remove [1] refs
      .trim();

    if (!s) return null;

    // ---- Relative date parsing ----
    // "yesterday at 3:00 PM", "today at 10:00 AM", "Last Monday at 2:30 PM"
    const relMatch = s.match(/^(today|yesterday|last\s+\w+)(?:\s+at)?\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (relMatch) {
      const baseDate = resolveRelativeDay(relMatch[1]);
      if (baseDate) {
        let hour = parseInt(relMatch[2], 10);
        const min = parseInt(relMatch[3], 10);
        const ampm = (relMatch[4] || "").toUpperCase();
        if (ampm === "PM" && hour < 12) hour += 12;
        if (ampm === "AM" && hour === 12) hour = 0;
        baseDate.setHours(hour, min, 0, 0);
        return baseDate;
      }
    }

    // "yesterday", "today" without time
    const relDayOnly = s.match(/^(today|yesterday|last\s+\w+)$/i);
    if (relDayOnly) {
      const d = resolveRelativeDay(relDayOnly[1]);
      if (d) return d;
    }

    // Try direct parse (works for ISO-8601 and many standard formats)
    let d = new Date(s);
    if (!isNaN(d.getTime())) return d;

    // Try "YYYY-MM-DD HH:MM" without T
    let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (m) {
      d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
      if (!isNaN(d.getTime())) return d;
    }

    // Try "YYYY-MM-DD, HH:MM-HH:MM" (range — take start)
    m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2}),?\s*(\d{1,2}):(\d{2})/);
    if (m) {
      d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
      if (!isNaN(d.getTime())) return d;
    }

    // Try "Mon DD, YYYY HH:MM AM/PM" or "DD Mon YYYY HH:MM"
    m = s.match(/(\w+)\s+(\d{1,2}),?\s*(\d{4}),?\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (m) {
      const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const mon = months[m[1].toLowerCase().slice(0, 3)];
      if (mon !== undefined) {
        let hour = +m[4];
        if (m[6] && m[6].toUpperCase() === "PM" && hour < 12) hour += 12;
        if (m[6] && m[6].toUpperCase() === "AM" && hour === 12) hour = 0;
        d = new Date(+m[3], mon, +m[2], hour, +m[5]);
        if (!isNaN(d.getTime())) return d;
      }
    }

    // Try "DD/MM/YYYY HH:MM" or "MM/DD/YYYY HH:MM"
    m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2})/);
    if (m) {
      d = new Date(+m[3], +m[1] - 1, +m[2], +m[4], +m[5]);
      if (!isNaN(d.getTime())) return d;
    }

    // Try just date "YYYY-MM-DD"
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) {
      d = new Date(+m[1], +m[2] - 1, +m[3]);
      if (!isNaN(d.getTime())) return d;
    }

    // Try "Tue, 17 Feb 2026" or "17 Feb 2026" style
    m = s.match(/(?:\w+,?\s+)?(\d{1,2})\s+(\w+)\s+(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})\s*(AM|PM)?)?/i);
    if (m) {
      const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const mon = months[m[2].toLowerCase().slice(0, 3)];
      if (mon !== undefined) {
        let hour = m[4] ? +m[4] : 0;
        const min = m[5] ? +m[5] : 0;
        if (m[6] && m[6].toUpperCase() === "PM" && hour < 12) hour += 12;
        if (m[6] && m[6].toUpperCase() === "AM" && hour === 12) hour = 0;
        d = new Date(+m[3], mon, +m[1], hour, min);
        if (!isNaN(d.getTime())) return d;
      }
    }

    return null;
  }

  /** Resolve a relative day reference to a Date at midnight */
  function resolveRelativeDay(rel) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const lower = rel.toLowerCase().trim();

    if (lower === "today") return today;
    if (lower === "yesterday") {
      today.setDate(today.getDate() - 1);
      return today;
    }

    // "last monday", "last tuesday", etc.
    const dayMatch = lower.match(/^last\s+(\w+)$/);
    if (dayMatch) {
      const dayNames = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
      const targetDay = dayNames[dayMatch[1].toLowerCase()];
      if (targetDay !== undefined) {
        const currentDay = today.getDay();
        let diff = currentDay - targetDay;
        if (diff <= 0) diff += 7; // "last X" means the previous occurrence
        today.setDate(today.getDate() - diff);
        return today;
      }
    }

    return null;
  }

  /** Fallback parser for non-table Work IQ responses */
  function parseMeetingsFallback(text) {
    // Try to find lines that look like meeting entries
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const results = [];
    for (const line of lines) {
      // Skip noise lines
      if (/^\|?[\s\-:]+\|?$/.test(line)) continue;
      if (/^(here|i found|below|>|online|timezone)/i.test(line)) continue;
      if (/^\| *#/i.test(line)) continue;

      const m = line.match(/^\|?\s*\d+\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/i);
      if (m) {
        const subject = cleanCell(m[1]);
        const startDate = parseFlexDate(cleanCell(m[2]));
        const endDate = parseFlexDate(cleanCell(m[3]));
        results.push({ subject, start: startDate, end: endDate, organizer: "", startRaw: m[2], endRaw: m[3] });
      }
    }
    return results;
  }

  // ===================== Render timeline view =====================
  function renderTimeline() {
    if (!meetings.length) {
      meetingList.innerHTML =
        '<div class="no-meetings">No online meetings found in the last 7 days.</div>';
      return;
    }

    // Group meetings by day (date string key → array of meetings)
    const dayGroups = new Map();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 0; i < meetings.length; i++) {
      const m = meetings[i];
      let dayKey;
      if (m.start) {
        const d = new Date(m.start);
        d.setHours(0, 0, 0, 0);
        dayKey = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); // local YYYY-MM-DD
      } else {
        dayKey = "unknown";
      }
      if (!dayGroups.has(dayKey)) dayGroups.set(dayKey, []);
      dayGroups.get(dayKey).push({ ...m, _idx: i });
    }

    // Sort days newest first
    const sortedDays = [...dayGroups.keys()].sort((a, b) => {
      if (a === "unknown") return 1;
      if (b === "unknown") return -1;
      return b.localeCompare(a);
    });

    let html = "";

    for (const dayKey of sortedDays) {
      const dayMeetings = dayGroups.get(dayKey);
      const label = getDayLabel(dayKey, today);

      html += `<div class="day-group">`;
      html += `<div class="day-header">${escHtml(label)}</div>`;

      // If this is the "unknown" group (dates not parsed), show as simple list
      if (dayKey === "unknown") {
        for (const m of dayMeetings) {
          html += `<div class="slot-meeting" data-idx="${m._idx}" style="margin:4px 0">`;
          html += `<div class="slot-subject">${escHtml(m.subject)}</div>`;
          if (m.startRaw) html += `<div class="slot-time">${escHtml(m.startRaw)}${m.endRaw ? " – " + escHtml(m.endRaw) : ""}</div>`;
          if (m.organizer) html += `<div class="slot-organizer">${escHtml(m.organizer)}</div>`;
          html += `</div>`;
        }
        html += `</div>`; // .day-group
        continue;
      }

      // Determine hour range for this day (from earliest start to latest end)
      let minHour = 24, maxHour = 0;
      for (const m of dayMeetings) {
        if (m.start) {
          const h = new Date(m.start).getHours();
          if (h < minHour) minHour = h;
        }
        if (m.end) {
          const h = new Date(m.end).getHours();
          const min = new Date(m.end).getMinutes();
          const endH = min > 0 ? h + 1 : h;
          if (endH > maxHour) maxHour = endH;
        } else if (m.start) {
          const h = new Date(m.start).getHours() + 1;
          if (h > maxHour) maxHour = h;
        }
      }

      // Clamp to reasonable range
      if (minHour > maxHour) { minHour = 8; maxHour = 18; }
      minHour = Math.max(0, minHour);
      maxHour = Math.min(24, maxHour);

      // Render hourly slots
      for (let hour = minHour; hour < maxHour; hour++) {
        const slotStart = hour;
        const slotEnd = hour + 1;
        const timeLabel = `${pad2(slotStart)}:00 – ${pad2(slotEnd)}:00`;

        // Find meetings overlapping this slot
        const overlapping = dayMeetings.filter((m) => {
          if (!m.start) return false;
          const mStart = new Date(m.start);
          const mEnd = m.end ? new Date(m.end) : new Date(mStart.getTime() + 3600000);
          const slotS = new Date(mStart); slotS.setHours(slotStart, 0, 0, 0);
          const slotE = new Date(mStart); slotE.setHours(slotEnd, 0, 0, 0);
          return mStart < slotE && mEnd > slotS;
        });

        html += `<div class="time-slot">`;
        html += `<div class="time-label">${timeLabel}</div>`;

        if (overlapping.length === 0) {
          html += `<div class="slot-empty">No meetings</div>`;
        } else {
          for (const m of overlapping) {
            const mTime = m.start
              ? `${formatTimeShort(m.start)}${m.end ? " – " + formatTimeShort(m.end) : ""}`
              : "";
            html += `<div class="slot-meeting" data-idx="${m._idx}">`;
            html += `<div class="slot-subject">${escHtml(m.subject)}</div>`;
            if (mTime) html += `<div class="slot-time">${escHtml(mTime)}</div>`;
            if (m.organizer) html += `<div class="slot-organizer">${escHtml(m.organizer)}</div>`;
            html += `</div>`;
          }
        }

        html += `</div>`; // .time-slot
      }

      html += `</div>`; // .day-group
    }

    meetingList.innerHTML = html;

    // Click handlers on meeting pills
    meetingList.querySelectorAll(".slot-meeting").forEach((el) => {
      el.addEventListener("click", () => {
        selectMeeting(parseInt(el.dataset.idx, 10));
      });
    });
  }

  /** Get a friendly label for a day key */
  function getDayLabel(dayKey, today) {
    if (dayKey === "unknown") return "Other";
    const d = new Date(dayKey + "T00:00:00");
    const diff = Math.round((today - d) / 86400000);
    const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
    const dateStr = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    if (diff === 0) return `Today — ${dateStr}`;
    if (diff === 1) return `Yesterday — ${dateStr}`;
    return `${weekday} — ${dateStr}`;
  }

  function pad2(n) { return n.toString().padStart(2, "0"); }

  function formatTimeShort(dateOrStr) {
    const d = dateOrStr instanceof Date ? dateOrStr : new Date(dateOrStr);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  }

  // Fallback: show raw Work IQ text in sidebar
  function renderRawMeetings(text) {
    meetingList.innerHTML = `<div class="workiq-raw">${formatWorkIQText(text)}</div>`;
  }

  // ===================== Select meeting & load transcript =====================
  async function selectMeeting(idx) {
    activeMeetingIdx = idx;
    meetingList.querySelectorAll(".slot-meeting").forEach((c) => {
      c.classList.toggle("active", parseInt(c.dataset.idx, 10) === idx);
    });

    const meeting = meetings[idx];
    if (!meeting) return;

    // Reset transcript cache when changing meeting to avoid stale plan input
    currentTranscriptText = "";
    currentMeeting = meeting;

    emptyState.classList.add("hidden");
    transcriptContent.classList.add("hidden");
    transcriptLoading.classList.remove("hidden");

    // Reset plan tab when selecting a new meeting
    if (planBody) planBody.innerHTML = "";
    switchTab("transcript");

    try {
      const params = new URLSearchParams({ subject: meeting.subject });
      if (meeting.startRaw) params.set("date", meeting.startRaw);
      else if (meeting.start) params.set("date", meeting.start.toISOString());

      const data = await api(`/api/meetings/transcript?${params}`);

      showTranscript(meeting, data.text, data.source, data.transcriptUrl);
    } catch (err) {
      showTranscriptMessage(
        meeting,
        `Error loading transcript: ${err.message}`
      );
    } finally {
      transcriptLoading.classList.add("hidden");
    }
  }

  // ===================== Display transcript =====================
  function showTranscript(meeting, text, source, transcriptUrl) {
    // Store for plan generation
    currentTranscriptText = text;
    currentMeeting = meeting;

    transcriptLoading.classList.add("hidden");
    emptyState.classList.add("hidden");
    transcriptContent.classList.remove("hidden");

    const dateDisp = meeting.start ? meeting.start.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "";
    const timeDisp = meeting.start
      ? `${formatTimeShort(meeting.start)}${meeting.end ? " – " + formatTimeShort(meeting.end) : ""}`
      : "";

    transcriptHeader.innerHTML = `
      <h2>${escHtml(meeting.subject)}</h2>
      <div class="meta">
        ${dateDisp ? `<span><strong>Date:</strong> ${escHtml(dateDisp)}</span>` : ""}
        ${timeDisp ? `<span><strong>Time:</strong> ${escHtml(timeDisp)}</span>` : ""}
        ${meeting.organizer ? `<span><strong>Organizer:</strong> ${escHtml(meeting.organizer)}</span>` : ""}
        ${source ? `<span><strong>Source:</strong> ${escHtml(source)}</span>` : ""}
      </div>
      ${transcriptUrl ? `<div class="meta" style="margin-top:6px;"><span><strong>Transcript Link:</strong> <a href="${escHtml(transcriptUrl)}" target="_blank" rel="noopener noreferrer">${escHtml(transcriptUrl)}</a></span></div>` : ""}
    `;

    // Try VTT parse first (in case Work IQ returns VTT)
    const vttBlocks = parseVTT(text);
    if (vttBlocks.length > 0) {
      transcriptBody.innerHTML = vttBlocks
        .map(
          (b) => `
        <div class="vtt-block">
          ${b.speaker ? `<div class="speaker">${escHtml(b.speaker)}</div>` : ""}
          <div class="timestamp">${escHtml(b.timestamp)}</div>
          <div class="text">${escHtml(b.text)}</div>
        </div>`
        )
        .join("");
      return;
    }

    // Try to extract speaker lines from Work IQ response
    // Work IQ returns blockquotes like: > Speaker: text [1](url)
    // Or plain lines like: Speaker: text
    const speakerLines = parseWorkIQTranscript(text);
    if (speakerLines.length > 0) {
      let html = '';
      // Check if there's a context note (explanation text before transcript)
      const contextNote = extractContextNote(text);
      if (contextNote) {
        html += `<div class="transcript-note">${formatWorkIQText(contextNote)}</div>`;
      }
      html += speakerLines
        .map(
          (entry) => `
        <div class="vtt-block">
          <div class="speaker">${escHtml(entry.speaker)}</div>
          <div class="text">${escHtml(entry.text)}</div>
        </div>`
        )
        .join("");
      transcriptBody.innerHTML = html;
    } else {
      // Show formatted Work IQ text as-is
      transcriptBody.innerHTML = `<div class="workiq-transcript">${formatWorkIQText(text)}</div>`;
    }
  }

  /**
   * Parse speaker lines from Work IQ transcript response.
   * Handles formats:
   *   > Speaker: text [1](url)
   *   Speaker: text
   *   - Speaker: text
   *   **Speaker**: text
   *   Name: dialogue {id=N}
   *   De: Name. {id=N} (Spanish prefix for speaker changes)
   */
  function parseWorkIQTranscript(text) {
    if (!text) return [];

    const lines = text.split("\n");
    const results = [];
    let lastSpeaker = "";

    for (let line of lines) {
      line = line.trim();
      if (!line) continue;

      // Remove {id=N} markers
      line = line.replace(/\s*\{id=\d+\}/g, "");
      // Remove markdown link references [N](url...)
      line = line.replace(/\s*\[\d+\]\([^)]*\)/g, "");
      line = line.trim();
      if (!line) continue;

      // "De:" lines are speaker change markers in Spanish Work IQ transcripts
      // e.g. "De: Nombre Apellido." or "De: Nombre."
      let m = line.match(/^De:\s*(.+?)\.?\s*$/i);
      if (m && m[1].length < 60 && !m[1].includes(",") && !/\b(tipo|que|lo|es|la|el|por|si|se|un|no)\b/i.test(m[1])) {
        lastSpeaker = cleanTranscriptText(m[1]);
        continue;
      }

      // Blockquote format: > Speaker: text
      m = line.match(/^>\s*(?:\*\*)?([^:*]+?)(?:\*\*)?:\s*(.+)/i);
      if (m) {
        lastSpeaker = cleanTranscriptText(m[1]);
        results.push({ speaker: lastSpeaker, text: cleanTranscriptText(m[2]) });
        continue;
      }

      // Bullet format: - Speaker: text or - **Speaker**: text
      m = line.match(/^[-•]\s*(?:\*\*)?([^:*]+?)(?:\*\*)?:\s*(.+)/i);
      if (m && !isMetaLine(m[1])) {
        lastSpeaker = cleanTranscriptText(m[1]);
        results.push({ speaker: lastSpeaker, text: cleanTranscriptText(m[2]) });
        continue;
      }

      // Speaker: dialogue — name with colon
      m = line.match(/^(?:\*\*)?([A-ZÀ-Ö][a-záéíóúñüA-ZÀ-Ö\s()\/,]+?)(?:\*\*)?:\s+(.+)/);
      if (m && !isMetaLine(m[1]) && m[1].length < 60) {
        lastSpeaker = cleanTranscriptText(m[1]);
        results.push({ speaker: lastSpeaker, text: cleanTranscriptText(m[2]) });
        continue;
      }

      // Continuation line (no speaker prefix) — keep it to avoid dropping content
      if (lastSpeaker && results.length > 0) {
        results.push({ speaker: lastSpeaker, text: cleanTranscriptText(line) });
        continue;
      }

      // Fallback: preserve otherwise unmatched lines instead of discarding them
      results.push({ speaker: "Unknown", text: cleanTranscriptText(line) });
    }

    return results;
  }

  /** Check if a label is a metadata heading rather than a speaker */
  function isMetaLine(label) {
    const lower = label.toLowerCase().trim();
    return /^(meeting|time|date|organizer|subject|start|end|transcribed|transcript|what|why|fastest|note|important)/i.test(lower);
  }

  /** Clean transcript text: remove footnote links [1](url), bold markers, etc. */
  function cleanTranscriptText(str) {
    return str
      .replace(/\s*\[\d+\]\([^)]*\)/g, "")     // [1](url) footnotes
      .replace(/\s*\[\d+\]/g, "")               // [1] footnotes
      .replace(/\*\*/g, "")                       // bold markers
      .replace(/\s+$/, "")                        // trailing whitespace
      .trim();
  }

  /** Extract the context/explanation note from before the transcript lines */
  function extractContextNote(text) {
    const lines = text.split("\n");
    const noteLines = [];
    for (const line of lines) {
      const trimmed = line.trim();
      // Stop when we hit the first speaker line or blockquote
      if (/^>/.test(trimmed)) break;
      if (/^[-•]\s*[A-Z]/.test(trimmed) && trimmed.includes(":")) break;
      // Skip empty lines and markdown headers at the start
      if (!trimmed || /^#{1,3}\s/.test(trimmed)) {
        if (noteLines.length > 0) noteLines.push(trimmed);
        continue;
      }
      noteLines.push(trimmed);
    }
    const note = noteLines.join("\n").trim();
    // Only return if there's meaningful text (not just a line or two)
    return note.length > 20 ? note : "";
  }

  function showTranscriptMessage(meeting, message) {
    transcriptLoading.classList.add("hidden");
    emptyState.classList.add("hidden");
    transcriptContent.classList.remove("hidden");

    transcriptHeader.innerHTML = `<h2>${escHtml(meeting?.subject || "Meeting")}</h2>`;
    transcriptBody.innerHTML = `
      <div style="text-align:center;padding:48px;color:#616161;">
        <p>${escHtml(message)}</p>
      </div>
    `;
  }

  // ===================== Format Work IQ text for display =====================
  function formatWorkIQText(text) {
    if (!text) return '<span style="color:#999">No content available.</span>';

    return text
      .split("\n")
      .map((line) => {
        let html = escHtml(line);
        // Bold **text**
        html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
        // Italic *text*
        html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
        // Linkify URLs
        html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
        return html;
      })
      .join("<br>");
  }

  // ===================== VTT Parser =====================
  function parseVTT(raw) {
    if (!raw || typeof raw !== "string") return [];

    const blocks = [];
    const parts = raw.split(/\n\n+/);

    for (const part of parts) {
      const lines = part.trim().split("\n");
      if (lines.length < 2) continue;

      let timestampIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("-->")) {
          timestampIdx = i;
          break;
        }
      }
      if (timestampIdx === -1) continue;

      const timestamp = lines[timestampIdx].trim();
      const textLines = lines.slice(timestampIdx + 1);
      let speaker = "";
      let text = textLines.join(" ").trim();

      const speakerMatch = text.match(/^<v\s+([^>]+)>(.*)/s);
      if (speakerMatch) {
        speaker = speakerMatch[1].trim();
        text = speakerMatch[2].replace(/<\/v>/g, "").trim();
      }

      blocks.push({ timestamp, speaker, text });
    }

    return blocks;
  }

  // ===================== Helpers =====================
  async function api(url) {
    const resp = await fetch(url);
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.details || body.error || resp.statusText);
    }
    return resp.json();
  }

  function escHtml(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ===================== Model selector =====================
  async function loadModels() {
    try {
      const data = await api("/api/models");
      const models = data.models || [];
      console.log("[Models] Received from API:", models.map((m) => m.id));
      modelSelector.innerHTML = '<option value="">— Select AI Model —</option>';

      const providers = {};
      for (const m of models) {
        if (!providers[m.provider]) providers[m.provider] = [];
        providers[m.provider].push(m);
      }

      for (const [provider, providerModels] of Object.entries(providers)) {
        const group = document.createElement("optgroup");
        group.label = provider;
        for (const m of providerModels) {
          const opt = document.createElement("option");
          opt.value = m.id;
          opt.textContent = m.name;
          if (m.description) opt.title = m.description;
          group.appendChild(opt);
        }
        modelSelector.appendChild(group);
      }

      modelSelector.disabled = false;
      if (models.some((m) => m.id === "gpt-4.1")) {
        modelSelector.value = "gpt-4.1";
      } else if (models[0]?.id) {
        modelSelector.value = models[0].id;
      }
    } catch (err) {
      console.error("Failed to load models:", err);
      modelSelector.innerHTML = '<option value="gpt-4.1">GPT-4.1 (default)</option>';
      modelSelector.disabled = false;
    }
  }

  // ===================== Tab switching =====================
  function switchTab(tabName) {
    if (!tabTranscript || !tabPlan) return;
    const isTranscript = tabName === "transcript";
    tabTranscript.classList.toggle("active", isTranscript);
    tabPlan.classList.toggle("active", !isTranscript);
    transcriptTab.classList.toggle("hidden", isTranscript ? false : true);
    planTab.classList.toggle("hidden", isTranscript ? true : false);
  }

  // ===================== Plan generation (SSE streaming) =====================
  async function generatePlan() {
    if (isGeneratingPlan) return;

    if (!currentTranscriptText) {
      switchTab("plan");
      planLoading.classList.add("hidden");
      planBody.innerHTML =
        '<div class="plan-error">' +
        "<h3>No transcript loaded</h3>" +
        "<p>Please open a meeting transcript first. If transcript loading failed, review the error shown in the transcript tab.</p>" +
        "</div>";
      return;
    }

    const model = modelSelector.value;
    if (!model) {
      alert("Please select an AI model from the top bar first.");
      return;
    }

    isGeneratingPlan = true;
    btnGeneratePlan.disabled = true;
    btnGeneratePlan.innerHTML = '<div class="spinner-sm"></div> Generating\u2026';

    switchTab("plan");
    planBody.innerHTML = "";
    planLoading.classList.remove("hidden");
    planLoadingText.textContent =
      "Generating plan with " +
      (modelSelector.selectedOptions[0]?.text || model) +
      "\u2026";

    let fullText = "";

    try {
      console.log("[Plan] Starting generation", {
        model,
        subject: currentMeeting?.subject || "Customer Meeting",
        transcriptLen: currentTranscriptText.length,
      });

      const response = await fetch("/api/generate-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: currentTranscriptText,
          model: model,
          subject: currentMeeting?.subject || "Customer Meeting",
        }),
      });

      if (
        !response.ok &&
        !response.headers.get("content-type")?.includes("text/event-stream")
      ) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || err.details || response.statusText);
      }

      planLoading.classList.add("hidden");

      if (!response.body) {
        throw new Error("Streaming response body is empty.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              console.error("[Plan] Server error chunk:", parsed.error);
              planBody.innerHTML =
                '<div class="plan-error">' + escHtml(parsed.error) + "</div>";
              break;
            }
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              fullText += delta;
              console.log("[Plan] delta len:", delta.length, "total:", fullText.length);
              planBody.innerHTML = renderPlanMarkdown(fullText);
              planBody.scrollTop = planBody.scrollHeight;
            }
          } catch (_e) {
            // incomplete JSON chunk, skip
          }
        }
      }

      if (!fullText.trim()) {
        planBody.innerHTML =
          '<div class="plan-error">' +
          "<h3>No plan content was generated</h3>" +
          "<p>The model returned an empty response. Try again or switch model.</p>" +
          "</div>";
        return;
      }

      // Final render with Mermaid diagrams
      planBody.innerHTML = renderPlanMarkdown(fullText);
      await renderMermaidDiagrams();
    } catch (err) {
      planLoading.classList.add("hidden");
      planBody.innerHTML =
        '<div class="plan-error">' +
        "<h3>Error generating plan</h3>" +
        "<p>" +
        escHtml(err.message) +
        "</p>" +
        '<p style="font-size:12px;margin-top:12px;color:#999;">Make sure you are signed in to GitHub Copilot.</p>' +
        "</div>";
    } finally {
      isGeneratingPlan = false;
      btnGeneratePlan.disabled = false;
      btnGeneratePlan.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none">' +
        '<path d="M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>' +
        "</svg> Generate Plan &amp; Architecture";
    }
  }

  // ===================== Markdown rendering for plan =====================
  function renderPlanMarkdown(text) {
    if (!text) return "";
    if (typeof marked === "undefined") return formatWorkIQText(text);

    // Auto-wrap Mermaid blocks when model outputs raw diagram syntax without fences
    const normalizedText = ensureMermaidFences(normalizeMermaidCodeFences(text));

    // Pre-process: extract mermaid blocks and replace with passthrough HTML divs
    const mermaidStore = [];
    const processed = normalizedText.replace(
      /```mermaid\s*\n([\s\S]*?)```/g,
      function (_, code) {
        var idx = mermaidStore.length;
        mermaidStore.push(code.trim());
        return (
          '\n<div class="mermaid" data-mermaid-idx="' +
          idx +
          '">' +
          escHtml(code.trim()) +
          "</div>\n"
        );
      }
    );

    try {
      return marked.parse(processed);
    } catch (_e) {
      return formatWorkIQText(text);
    }
  }

  /** Convert generic fenced code blocks containing Mermaid syntax to ```mermaid. */
  function normalizeMermaidCodeFences(text) {
    if (!text) return text;
    return text.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (full, lang, code) => {
      const language = (lang || "").trim().toLowerCase();
      const firstLine = (code || "").trim().split("\n")[0] || "";
      const looksMermaid = /^(graph\s+(TD|LR|TB|BT)|flowchart\s+\w+|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie\b)/i.test(firstLine.trim());
      if (language === "mermaid" || looksMermaid) {
        return "```mermaid\n" + code + "```";
      }
      return full;
    });
  }

  // ===================== Mermaid diagram rendering =====================
  async function renderMermaidDiagrams() {
    if (typeof mermaid === "undefined") return;

    promoteMermaidCodeBlocks();

    const isDark = document.body.getAttribute("data-theme") === "dark";
    mermaid.initialize({
      startOnLoad: false,
      theme: isDark ? "dark" : "default",
      securityLevel: "loose",
      fontFamily: '"Segoe UI", sans-serif',
    });

    const divs = planBody.querySelectorAll(".mermaid");
    for (let i = 0; i < divs.length; i++) {
      const div = divs[i];
      const raw = (div.textContent || "").trim();
      if (!raw) continue;

      const attempts = [
        raw,
        normalizeMermaidSyntax(raw),
        sanitizeMermaidCode(normalizeMermaidSyntax(raw)),
      ].filter(Boolean);

      let rendered = false;
      let lastError = null;

      for (let j = 0; j < attempts.length; j++) {
        try {
          const id = "mermaid-" + Date.now() + "-" + i + "-" + j;
          const { svg } = await mermaid.render(id, attempts[j]);
          div.innerHTML = svg;
          div.classList.add("mermaid-rendered");
          rendered = true;
          break;
        } catch (e) {
          lastError = e;
        }
      }

      if (!rendered) {
        console.warn("Mermaid render error for diagram " + i + ":", lastError?.message || lastError);
        div.classList.add("mermaid-error");
      }
    }

    cleanupMermaidArtifacts();
  }

  /** Wrap bare Mermaid diagram text into ```mermaid``` fences when missing. */
  function ensureMermaidFences(text) {
    if (!text) return text;

    const lines = text.split("\n");
    const out = [];
    let i = 0;
    let inFence = false;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      // Preserve existing fenced blocks exactly
      if (/^```/.test(trimmed)) {
        inFence = !inFence;
        out.push(line);
        i++;
        continue;
      }

      if (inFence) {
        out.push(line);
        i++;
        continue;
      }

      const isMermaidStart = /^(graph\s+(TD|LR|TB|BT)|flowchart\s+\w+|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie\b)/i.test(trimmed);

      if (!isMermaidStart) {
        out.push(line);
        i++;
        continue;
      }

      out.push("```mermaid");

      // Capture until next markdown section/list heading that likely starts another block
      while (i < lines.length) {
        const l = lines[i];
        const t = l.trim();

        if (
          i > 0 &&
          (/^#{1,6}\s+/.test(t) || /^\d+\.\s+/.test(t))
        ) {
          break;
        }

        out.push(l);
        i++;
      }

      out.push("```");
    }

    return out.join("\n");
  }

  /** Normalize common single-line Mermaid outputs so renderer can parse them. */
  function normalizeMermaidSyntax(code) {
    if (!code) return "";
    let c = code.replace(/\r/g, "").trim();
    if (!c) return c;

    // Always normalize common compact forms, even on multiline text.
    c = c
      // graph TD subgraph X ... => graph TD \n subgraph X ...
      .replace(/^(\s*graph\s+(?:TD|LR|TB|BT))\s+(subgraph\b)/gim, "$1\n$2")
      // sequenceDiagram participant A participant B ...
      .replace(/\s+(participant\s+)/gi, "\n$1")
      .replace(/\s+(subgraph\s+)/gi, "\n$1")
      .replace(/\s+(alt\s+|else\s+|opt\s+|loop\s+|par\s+|and\s+)/gi, "\n$1")
      .replace(/\s+(end)\b/gi, "\n$1")
      // Flowchart arrows: A --> B, A -- "label" --> B, A ---|label| B, A -->|label| B
      .replace(/\s+([A-Za-z0-9_]+\s*--)/g, "\n$1")
      // Sequence diagram arrows: A->>B: msg
      .replace(/\s+([A-Za-z0-9_]+-+>+>?[A-Za-z0-9_]+:)/g, "\n$1");

    // If it is still one line, split node declarations as a fallback.
    if (!c.includes("\n")) {
      c = c.replace(/\s+([A-Za-z0-9_]+\[[^\]]+\])/g, "\n$1");
    }

    return c.trim();
  }

  /** Remove markdown/noise that can break Mermaid parsing. */
  function sanitizeMermaidCode(code) {
    if (!code) return "";

    const lines = code
      .replace(/```mermaid/gi, "")
      .replace(/```/g, "")
      .split("\n")
      .map((l) => l.replace(/^\s*\d+\.\s+/, "").replace(/^\s*[-*+]\s+/, ""));

    // Keep from the first Mermaid keyword onward
    const startIdx = lines.findIndex((l) =>
      /\b(graph\s+(TD|LR|TB|BT)|flowchart\s+\w+|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie\b)\b/i.test(l.trim())
    );

    const trimmed = (startIdx >= 0 ? lines.slice(startIdx) : lines)
      .join("\n")
      .trim();

    return trimmed;
  }

  /** Remove duplicated raw mermaid text paragraphs after successful render. */
  function cleanupMermaidArtifacts() {
    const hasRendered = !!planBody.querySelector(".mermaid-rendered");
    if (!hasRendered) return;

    const candidates = planBody.querySelectorAll("p, li");
    for (const el of candidates) {
      const txt = (el.textContent || "").trim();
      if (!txt) continue;

      if (
        /^(graph\s+(TD|LR|TB|BT)|flowchart\s+\w+|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie\b|subgraph\s+|participant\s+|alt\s+)/i.test(txt)
      ) {
        el.remove();
      }
    }

  }

  function promoteMermaidCodeBlocks() {
    const pres = planBody.querySelectorAll("pre > code");
    for (const codeEl of pres) {
      const txt = (codeEl.textContent || "").trim();
      if (!/^(graph\s+(TD|LR|TB|BT)|flowchart\s+\w+|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie\b)/i.test(txt)) {
        continue;
      }

      const pre = codeEl.closest("pre");
      if (!pre) continue;

      const div = document.createElement("div");
      div.className = "mermaid";
      div.textContent = txt;
      pre.replaceWith(div);
    }
  }

  // ===================== Events =====================
  btnRefresh.addEventListener("click", loadMeetings);

  if (tabTranscript) {
    tabTranscript.addEventListener("click", function () {
      switchTab("transcript");
    });
  }
  if (tabPlan) {
    tabPlan.addEventListener("click", function () {
      switchTab("plan");
    });
  }
  if (btnGeneratePlan) {
    btnGeneratePlan.addEventListener("click", generatePlan);
  }

  // ===================== Start =====================
  init();
})();
