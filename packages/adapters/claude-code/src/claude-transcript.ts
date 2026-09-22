import os from "node:os";
import path from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";

export function projectDirectoryName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/gu, "-");
}

export function configDirectory(environment: NodeJS.ProcessEnv): string {
  return environment.CLAUDE_CONFIG_DIR
    ? path.resolve(environment.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), ".claude");
}

/** Claude Code's auto-memory directory for `cwd`: one Markdown file per saved lesson. */
export function claudeProjectMemoryDirectory(cwd: string, environment: NodeJS.ProcessEnv): string {
  return path.join(
    configDirectory(environment),
    "projects",
    projectDirectoryName(path.resolve(cwd)),
    "memory",
  );
}

async function existingFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function findSubagentTranscript(
  directory: string,
  nativeSubagentId: string,
): Promise<string | null> {
  const expected = path.join(directory, `agent-${nativeSubagentId}.jsonl`);
  if (await existingFile(expected)) return expected;

  // Claude can store nested agents under additional directories within subagents/.
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findSubagentTranscript(path.join(directory, entry.name), nativeSubagentId);
    if (found) return found;
  }
  return null;
}

async function findTranscript(input: {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  sessionId: string;
  nativeSubagentId?: string;
}): Promise<string | null> {
  const projectsDirectory = path.join(configDirectory(input.environment), "projects");
  const nativeSubagentId = input.nativeSubagentId;
  if (nativeSubagentId !== undefined && !/^[A-Za-z0-9_-]+$/u.test(nativeSubagentId)) return null;
  const findInProject = async (project: string): Promise<string | null> => {
    const directory = path.join(projectsDirectory, project);
    if (nativeSubagentId !== undefined) {
      return findSubagentTranscript(
        path.join(directory, input.sessionId, "subagents"),
        nativeSubagentId,
      );
    }
    const candidate = path.join(directory, `${input.sessionId}.jsonl`);
    return (await existingFile(candidate)) ? candidate : null;
  };
  const expectedProject = projectDirectoryName(input.cwd);
  const expected = await findInProject(expectedProject);
  if (expected) return expected;

  let projects: string[];
  try {
    projects = await readdir(projectsDirectory);
  } catch {
    return null;
  }
  for (const project of projects) {
    if (project === expectedProject) continue;
    const candidate = await findInProject(project);
    if (candidate) return candidate;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the complete append-only Claude Code main-session or subagent transcript.
 *
 * The Agent SDK's getSessionMessages() intentionally follows one parentUuid
 * branch. Claude can attach a later prompt to a system record before the prior
 * assistant terminal, which makes that otherwise valid branch omit prior
 * assistant messages. History recovery needs every persisted main-session
 * message in transcript order instead.
 * getSubagentMessages() also drops attachment records before following parentUuid,
 * so a message whose parent is an attachment truncates the entire earlier history.
 * Both transcript types must be read in append order without traversing that chain.
 */
export async function readClaudeTranscript(input: {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  sessionId: string;
  nativeSubagentId?: string;
}): Promise<unknown[] | null> {
  const transcript = await findTranscript(input);
  if (!transcript) return null;
  const contents = await readFile(transcript, "utf8");
  const messages: unknown[] = [];
  for (const line of contents.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      !isRecord(entry) ||
      (entry.type !== "user" && entry.type !== "assistant") ||
      typeof entry.uuid !== "string" ||
      !isRecord(entry.message)
    ) {
      continue;
    }
    messages.push({ ...entry, session_id: input.sessionId });
  }
  return messages;
}
