// Drive the independent debug Desktop through CDP for acceptance checks.
// Usage: node tools/acceptance/cdp.mjs <eval-js | click <css> | clickText <css> <text> | key <Key> | text <s> | screenshot <file> [css] | reload>
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { CdpClient, listCdpTargets } from "../../packages/desktop-control/dist/cdp-client.js";

const repository = path.resolve(import.meta.dirname, "../..");
const instance = path.join(repository, ".codexhost/debug-instance");
const out = path.join(repository, ".codexhost/acceptance");

function endpoint() {
  const lines = execFileSync("ps", ["-axo", "command="], { encoding: "utf8" }).split("\n");
  const line = lines.find((entry) =>
    entry.startsWith(path.join(instance, "app/ChatGPT.app/Contents/MacOS/ChatGPT ")),
  );
  const port = line?.match(/remote-debugging-port=(\d+)/u)?.[1];
  if (!port) throw new Error("Debug Desktop of this repository is not running");
  return `http://127.0.0.1:${port}`;
}

const [command, ...args] = process.argv.slice(2);
const targets = await listCdpTargets(endpoint());
const target = targets.find((t) => t.type === "page" && t.url === "app://-/index.html");
if (!target) {
  console.log(JSON.stringify(targets.map((t) => ({ type: t.type, url: t.url.split("?")[0] }))));
  process.exit(1);
}
const client = await CdpClient.connect(target.webSocketDebuggerUrl);
const center = (expression) =>
  client.evaluate(
    `(()=>{const e=${expression};if(!e)throw Error('Element missing');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
  );
async function click(point) {
  await client.command("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  for (const type of ["mousePressed", "mouseReleased"])
    await client.command("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "left",
      clickCount: 1,
    });
}
try {
  if (command === "click") {
    await click(await center(`document.querySelector(${JSON.stringify(args[0])})`));
    console.log("clicked");
  } else if (command === "clickText") {
    await click(
      await center(
        `[...document.querySelectorAll(${JSON.stringify(args[0])})].find(e=>e.textContent.trim().includes(${JSON.stringify(args[1])}))`,
      ),
    );
    console.log("clicked");
  } else if (command === "key") {
    const keyCode = { Escape: 27, Enter: 13, ArrowRight: 39, ArrowLeft: 37, ArrowDown: 40, Tab: 9 }[
      args[0]
    ];
    for (const type of ["keyDown", "keyUp"])
      await client.command("Input.dispatchKeyEvent", {
        type,
        key: args[0],
        code: args[0],
        windowsVirtualKeyCode: keyCode,
        ...(type === "keyDown" && args[0] === "Enter" ? { text: "\r" } : {}),
      });
    console.log("key sent");
  } else if (command === "text") {
    await client.command("Input.insertText", { text: args[0] });
    console.log("inserted");
  } else if (command === "reload") {
    await client.command("Page.reload", { ignoreCache: true });
    console.log("reloaded");
  } else if (command === "screenshot") {
    await fs.mkdir(out, { recursive: true });
    const clip = args[1]
      ? await client.evaluate(
          `(()=>{const r=document.querySelector(${JSON.stringify(args[1])}).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`,
        )
      : undefined;
    const shot = await client.command("Page.captureScreenshot", {
      format: "png",
      ...(clip ? { clip } : {}),
    });
    const file = path.join(out, args[0] ?? "screen.png");
    await fs.writeFile(file, Buffer.from(shot.data, "base64"));
    console.log(file);
  } else {
    console.log(JSON.stringify(await client.evaluate(command), null, 2));
  }
} finally {
  client.close();
}
