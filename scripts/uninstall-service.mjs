import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const LABEL = "com.ccusage.dashboard";
const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const uid = execFileSync("id", ["-u"], { encoding: "utf8" }).trim();
const domain = `gui/${uid}`;

try {
  execFileSync("launchctl", ["bootout", domain, plistPath], { stdio: "ignore" });
  console.log(`Removed ${LABEL} from launchd`);
} catch {
  console.log(`Service ${LABEL} was not running`);
}
