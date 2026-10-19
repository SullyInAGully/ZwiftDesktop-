// npm run firewall:win: runs windows-firewall.ps1 elevated (Windows shows an administrator prompt).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

if (process.platform !== "win32") {
  console.log("Only needed on Windows. On macOS, allow incoming connections for node when the firewall asks.");
  process.exit(0);
}
const script = fileURLToPath(new URL("./windows-firewall.ps1", import.meta.url));
const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `"${script}"`, "-Node", `"${process.execPath}"`];
const command = `$p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList '${args.join("','")}'; exit $p.ExitCode`;
const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { stdio: "inherit" });
if (result.status === 0) console.log("Firewall rules added: phones on private networks can reach the Wi-Fi stream.");
else console.error("Firewall rules were not added (cancelled or failed). Run tools/windows-firewall.ps1 from an administrator PowerShell.");
process.exit(result.status ?? 1);
