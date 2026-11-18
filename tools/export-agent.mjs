// Saves the forge-coder agent definition from your running TrueForge into agent/forge-coder.json,
// so judges can import exactly the agent used in the video.
// Run from the extension folder (TrueForge must be running):  node tools/export-agent.mjs
import { TrueForge } from "@truefoundry/trueforge-sdk";
import { mkdirSync, writeFileSync } from "node:fs";

const baseUrl = process.argv[2] ?? "http://localhost:8790";
const name = process.argv[3] ?? "forge-coder";
const client = new TrueForge({ baseUrl });
const page = await client.agents.list();
const agents = page.data ?? page;
const agent = agents.find((a) => a.name === name);
if (!agent) {
  console.error(`No agent called "${name}". Found: ${agents.map((a) => a.name).join(", ")}`);
  process.exit(1);
}
const text = JSON.stringify(agent.manifest, null, 2);
// Safety net: refuse to save anything that looks like an API key.
if (/AIza[0-9A-Za-z_-]{20}|gsk_[0-9A-Za-z]{20}|sk-[0-9A-Za-z]{20}/.test(text)) {
  console.error("This agent definition seems to contain an API key. Not saved.");
  process.exit(1);
}
mkdirSync("agent", { recursive: true });
writeFileSync(`agent/${name}.json`, text + "\n");
console.log(`Saved agent/${name}.json`);
