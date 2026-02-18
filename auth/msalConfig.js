/* ============================================================
   Auth module — Azure CLI based authentication.
   Work IQ handles Graph auth internally; we just manage the
   Azure CLI session for the user identity.
   ============================================================ */

const { execSync } = require("child_process");

let cachedUserName = null;
let authenticated = false;

/**
 * Check if the user is already signed in to Azure CLI.
 */
function checkAzLogin() {
  try {
    const out = execSync(
      'az account show --query "user.name" -o tsv',
      { encoding: "utf8", windowsHide: true, timeout: 15000 }
    ).trim();

    if (out) {
      cachedUserName = out;
      authenticated = true;
      return true;
    }
  } catch {
    /* not logged in */
  }
  authenticated = false;
  cachedUserName = null;
  return false;
}

/**
 * Interactive login — runs `az login` which opens the system browser.
 * Returns the signed-in user name.
 */
async function login() {
  const { execFile } = require("child_process");
  const { promisify } = require("util");
  const execFileP = promisify(execFile);

  try {
    await execFileP("az", ["login", "--allow-no-subscriptions"], {
      windowsHide: true,
      timeout: 120000,
      shell: true,
    });

    // Verify
    checkAzLogin();
    if (!authenticated) throw new Error("az login succeeded but couldn't read account");

    console.log(`  Signed in as: ${cachedUserName}`);
    return { name: cachedUserName };
  } catch (err) {
    throw new Error(`Azure CLI login failed: ${err.message}`);
  }
}

function isAuthenticated() {
  return authenticated;
}

function getUserName() {
  return cachedUserName;
}

function logout() {
  try {
    execSync("az logout", { windowsHide: true, timeout: 10000 });
  } catch { /* ignore */ }
  authenticated = false;
  cachedUserName = null;
}

// Check on module load
checkAzLogin();

module.exports = {
  login,
  checkAzLogin,
  isAuthenticated,
  getUserName,
  logout,
};
