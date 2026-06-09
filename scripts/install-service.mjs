import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const LABEL = "com.ccusage.dashboard";
const PORT = process.env.PORT || "3847";
const nodeBin = process.execPath;
const logsDir = join(ROOT, "logs");
const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

mkdirSync(logsDir, { recursive: true });

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${join(ROOT, "server.mjs")}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>${PORT}</string>
    <key>PATH</key>
    <string>${process.env.PATH || ""}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(logsDir, "out.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(logsDir, "err.log")}</string>
</dict>
</plist>
`;

writeFileSync(plistPath, plist, "utf8");

const uid = execFileSync("id", ["-u"], { encoding: "utf8" }).trim();
const domain = `gui/${uid}`;

try {
  execFileSync("launchctl", ["bootout", domain, plistPath], { stdio: "ignore" });
} catch {
  /* not loaded */
}

execFileSync("launchctl", ["bootstrap", domain, plistPath]);
console.log(`Installed ${LABEL} on port ${PORT}`);
console.log(`Plist: ${plistPath}`);
console.log(`Open: http://127.0.0.1:${PORT}`);
