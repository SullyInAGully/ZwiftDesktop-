import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { CREDENTIAL_STORE, saveCredentials } from "./keychain.mjs";

async function hiddenQuestion(prompt) {
  if (!stdin.isTTY) throw new Error("Credential setup must be run in an interactive terminal");
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  let value = "";
  return await new Promise((resolve, reject) => {
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = char => {
      if (char === "\u0003") {
        cleanup();
        reject(new Error("Cancelled"));
      } else if (char === "\r" || char === "\n") {
        cleanup();
        resolve(value);
      } else if (char === "\u007f" || char === "\b") {
        value = value.slice(0, -1);
      } else if (char >= " ") {
        value += char;
      }
    };
    stdin.on("data", onData);
  });
}

const rl = createInterface({ input: stdin, output: stdout });
try {
  const username = await rl.question("Zwift email: ");
  rl.close();
  const password = await hiddenQuestion(`Zwift password (stored in ${CREDENTIAL_STORE}): `);
  await saveCredentials(username, password);
  console.log(`Credentials saved to ${CREDENTIAL_STORE}.`);
} catch (error) {
  rl.close();
  console.error(error.message);
  process.exitCode = 1;
}
