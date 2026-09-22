/** Runs in the existing renderer. Calls its query client without patching React. */
export async function refreshDesktopModelCatalogue() {
  const root = document.getElementById("root");
  const containerKey = root && Object.keys(root).find((key) => key.startsWith("__reactContainer$"));
  if (!containerKey) throw new Error("Unsupported Desktop React container");
  const container = root[containerKey];
  const stack = [container.stateNode?.current ?? container];
  const seen = new Set();
  const clients = new Set();
  while (stack.length && seen.size < 30_000) {
    const fiber = stack.pop();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    for (const value of [fiber.memoizedProps?.client, fiber.memoizedProps?.value]) {
      if (
        typeof value?.invalidateQueries === "function" &&
        typeof value?.getQueryCache === "function"
      )
        clients.add(value);
    }
    stack.push(fiber.child, fiber.sibling);
  }
  if (stack.length || clients.size !== 1) throw new Error("Unsupported Desktop query client shape");
  const [client] = clients;
  const queryKey = ["models", "list", "local"];
  const queries = client.getQueryCache().findAll({ queryKey });
  if (!queries.length) throw new Error("Desktop model catalogue is not mounted");
  await client.invalidateQueries({ queryKey });
  return queries.map((query) => ({
    queryKey: query.queryKey,
    ids: query.state.data?.data?.map((model) => model.id) ?? [],
  }));
}
