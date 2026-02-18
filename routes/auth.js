const express = require("express");
const router = express.Router();
const { isAuthenticated, getUserName, logout } = require("../auth/msalConfig");

// Auth status — the device code flow happens at startup in the terminal.
// These routes let the frontend check status and log out.

router.get("/status", (_req, res) => {
  res.json({
    authenticated: isAuthenticated(),
    name: getUserName(),
  });
});

router.get("/logout", (_req, res) => {
  logout();
  res.json({ ok: true, message: "Logged out. Restart the server to sign in again." });
});

module.exports = router;
