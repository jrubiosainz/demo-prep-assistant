require("dotenv").config();

const express = require("express");
const path = require("path");
const {
  isAuthenticated,
  getUserName,
  logout,
} = require("./auth/msalConfig");
const meetingsRoutes = require("./routes/meetings");

const app = express();

// --------------- Middleware ---------------
app.use(express.json({ limit: "10mb" }));

// Static files
app.use(express.static(path.join(__dirname, "public")));

// API to check auth status
app.get("/api/me", (_req, res) => {
  if (isAuthenticated()) {
    return res.json({ authenticated: true, name: getUserName() });
  }
  res.json({ authenticated: false });
});

// Logout — clears in-memory tokens
app.get("/auth/logout", (_req, res) => {
  logout();
  res.json({ ok: true });
});

// Routes
app.use("/api", meetingsRoutes);

// SPA fallback
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/**
 * Start the Express server on the given port.
 * @param {number} port — use 0 to let the OS pick an available port
 * @returns {Promise<number>} the actual port the server is listening on
 */
function startServer(port) {
  const listenPort = port ?? process.env.PORT ?? 3000;
  return new Promise((resolve, reject) => {
    const server = app.listen(listenPort, () => {
      const actualPort = server.address().port;
      console.log(`  Express API running on port ${actualPort}`);
      resolve(actualPort);
    });
    server.on("error", reject);
  });
}

module.exports = { app, startServer };
