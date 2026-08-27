/**
 * A platform MCP server, faked (TASKS:Y8.1, Y8.2).
 *
 * The debt this pays off is named in the ledger: Delivery, the capability probe and the
 * preflight marker scan were all driven with SCRIPTED tool results, so nothing proved they
 * work through a server — an actual child process, an actual stdio transport, an actual
 * `tools/list`. This is that server, and it is deliberately dependency-free: MCP over stdio
 * is newline-delimited JSON-RPC, so implementing it by hand costs forty lines and keeps a
 * test fixture from depending on a package Yama does not declare.
 *
 * It serves the synthetic pull request in `synthetic-pr/`: the same comments, through a
 * real connection.
 *
 *   node fake-mcp-server.mjs [--tools list_comments,read_pr] [--body "<pr description>"]
 */
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] !== undefined
    ? process.argv[at + 1]
    : fallback;
};

const TOOL_NAMES = flag("tools", "list_comments,read_pr").split(",");
const BODY = flag("body", "## Why\n\nMobile needs a token endpoint.");

const COMMENTS = JSON.parse(
  readFileSync(path.join(HERE, "synthetic-pr", "comments.json"), "utf8"),
);

const TOOLS = {
  list_comments: {
    description: "Every comment on a pull request",
    result: () => COMMENTS,
  },
  read_pr: {
    description: "One pull request, including its description",
    result: () => ({ number: 7, title: "Add a token endpoint", body: BODY }),
  },
  set_body: {
    description: "Replace a pull request's description",
    result: (args) => ({ number: 7, body: String(args.body ?? "") }),
  },
  create_inline: {
    description: "Comment on one line of a pull request",
    result: (args) => ({ id: 4242, body: String(args.body ?? "") }),
  },
  begin_review: {
    description: "Open a pending review to attach inline comments to",
    result: () => ({ id: 9001, state: "PENDING" }),
  },
  submit_review: {
    description: "Submit the pending review, making its comments visible",
    result: () => ({ id: 9001, state: "COMMENTED" }),
  },
};

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const reply = (id, result) => send({ jsonrpc: "2.0", id, result });

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") {
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  // A notification has no id and takes no answer.
  if (message.id === undefined) {
    return;
  }
  switch (message.method) {
    case "initialize":
      reply(message.id, {
        protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-forge", version: "1.0.0" },
      });
      return;
    case "tools/list":
      reply(message.id, {
        tools: TOOL_NAMES.filter((name) => TOOLS[name] !== undefined).map(
          (name) => ({
            name,
            description: TOOLS[name].description,
            inputSchema: { type: "object", properties: {} },
          }),
        ),
      });
      return;
    case "tools/call": {
      const tool = TOOLS[message.params?.name];
      if (tool === undefined) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `no such tool: ${message.params?.name}` },
        });
        return;
      }
      reply(message.id, {
        content: [
          {
            type: "text",
            text: JSON.stringify(tool.result(message.params?.arguments ?? {})),
          },
        ],
      });
      return;
    }
    default:
      reply(message.id, {});
  }
});
