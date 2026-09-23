import { createInterface } from "node:readline";
import { HotAttachController, defaultMenuBarEnvironment } from "./controller.js";

/** JSONL control pipe owned by the native MenuBar app. Never publishes an HTTP control port. */
export async function runMenuBarHost(
  environment: NodeJS.ProcessEnv,
  hostRuntimeUrl: string,
): Promise<number> {
  let previous = "";
  let outputAvailable = true;
  const publish = () => {
    const value = JSON.stringify({ type: "status", ...controller.status() });
    if (outputAvailable && value !== previous) {
      previous = value;
      process.stdout.write(`${value}\n`);
    }
  };
  const controller = new HotAttachController({
    appPath: environment.CODEXHOST_DESKTOP_APP ?? "/Applications/ChatGPT.app",
    environment: defaultMenuBarEnvironment(environment),
    hostRuntimeUrl,
    changed: publish,
  });
  let quitting = false;
  let ownerGone = false;
  let finished = false;
  const input = createInterface({ input: process.stdin });
  const done = Promise.withResolvers<void>();
  const finish = () => {
    finished = true;
    input.close();
    done.resolve();
  };
  const quit = async (): Promise<void> => {
    if (quitting) return;
    quitting = true;
    await controller.detach();
    if (!quitting || controller.status().phase !== "detached") return;
    finish();
  };
  input.on("line", (line) => {
    void (async () => {
      const request = JSON.parse(line) as { id?: string; command: string };
      try {
        switch (request.command) {
          case "attach":
            await controller.attach();
            break;
          case "detach":
            await controller.detach();
            break;
          case "stop-and-detach":
            await controller.detach(true);
            break;
          case "cancel-drain":
            controller.cancelDrain();
            quitting = false;
            break;
          case "status":
            await controller.refresh();
            break;
          case "quit":
            await quit();
            break;
          default:
            throw new Error("Unknown menu command");
        }
        if (outputAvailable)
          process.stdout.write(`${JSON.stringify({ type: "reply", id: request.id, ok: true })}\n`);
      } catch (error) {
        if (outputAvailable)
          process.stdout.write(
            `${JSON.stringify({
              type: "reply",
              id: request.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })}\n`,
          );
      }
      publish();
    })().catch(() => process.stderr.write("Invalid menu control frame\n"));
  });
  const ownerLost = () => {
    if (finished || ownerGone) return;
    ownerGone = true;
    quitting = true;
    outputAvailable = false;
    void controller.detach(true).then(finish, done.reject);
  };
  input.once("close", ownerLost);
  const stop = () => {
    void quit().catch(done.reject);
  };
  input.on("error", ownerLost);
  process.stdout.on("error", ownerLost);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  publish();
  void controller.refresh().catch(() => {});
  if (environment.CODEXHOST_AUTO_ATTACH !== "0") void controller.attach().catch(() => {});
  try {
    await done.promise;
    return 0;
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    process.stdout.removeListener("error", ownerLost);
  }
}
