import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { randomUUID } from "crypto";

const N8N_URL = process.env.N8N_URL;
const N8N_API_KEY = process.env.N8N_API_KEY;
const PORT = process.env.PORT || 3000;

if (!N8N_URL || !N8N_API_KEY) {
  console.error("Missing N8N_URL or N8N_API_KEY environment variables");
  process.exit(1);
}

// ── n8n API helper ─────────────────────────────────────────────────────────
async function n8n(method, path, body = null) {
  const res = await fetch(`${N8N_URL}/api/v1${path}`, {
    method,
    headers: {
      "X-N8N-API-KEY": N8N_API_KEY,
      "Content-Type": "application/json",
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`n8n API error ${res.status}: ${text}`);
  }
  return res.json();
}

// ── MCP server factory ─────────────────────────────────────────────────────
function createMcpServer() {
  const server = new McpServer({ name: "n8n-builder", version: "1.0.0" });

  server.tool("list_workflows", "List all workflows in n8n", {}, async () => {
    const data = await n8n("GET", "/workflows");
    const workflows = data.data.map((w) => ({ id: w.id, name: w.name, active: w.active }));
    return { content: [{ type: "text", text: JSON.stringify(workflows, null, 2) }] };
  });

  server.tool("get_workflow", "Get full details of a specific workflow", { id: z.string() }, async ({ id }) => {
    const data = await n8n("GET", `/workflows/${id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  server.tool("create_workflow", "Create a new workflow in n8n", {
    name: z.string().describe("Name of the new workflow"),
    nodes: z.array(z.any()).describe("Array of n8n node objects"),
    connections: z.record(z.any()).optional().describe("Node connections object"),
  }, async ({ name, nodes, connections = {} }) => {
    const data = await n8n("POST", "/workflows", { name, nodes, connections, settings: {} });
    return { content: [{ type: "text", text: `Workflow created! ID: ${data.id}, Name: ${data.name}` }] };
  });

  server.tool("update_workflow", "Update an existing workflow", {
    id: z.string(),
    name: z.string().optional(),
    nodes: z.array(z.any()).optional(),
    connections: z.record(z.any()).optional(),
  }, async ({ id, name, nodes, connections }) => {
    const existing = await n8n("GET", `/workflows/${id}`);
    await n8n("PUT", `/workflows/${id}`, {
      ...existing,
      ...(name && { name }),
      ...(nodes && { nodes }),
      ...(connections && { connections }),
    });
    return { content: [{ type: "text", text: `Workflow ${id} updated successfully.` }] };
  });

  server.tool("activate_workflow", "Activate a workflow", { id: z.string() }, async ({ id }) => {
    await n8n("POST", `/workflows/${id}/activate`);
    return { content: [{ type: "text", text: `Workflow ${id} is now active.` }] };
  });

  server.tool("deactivate_workflow", "Deactivate a workflow", { id: z.string() }, async ({ id }) => {
    await n8n("POST", `/workflows/${id}/deactivate`);
    return { content: [{ type: "text", text: `Workflow ${id} has been deactivated.` }] };
  });

  server.tool("delete_workflow", "Delete a workflow permanently", { id: z.string() }, async ({ id }) => {
    await n8n("DELETE", `/workflows/${id}`);
    return { content: [{ type: "text", text: `Workflow ${id} deleted.` }] };
  });

  server.tool("execute_workflow", "Manually trigger a workflow execution", {
    id: z.string(),
    data: z.record(z.any()).optional(),
  }, async ({ id, data = {} }) => {
    const result = await n8n("POST", `/workflows/${id}/run`, { startNodes: [], destinationNode: "", data });
    return { content: [{ type: "text", text: `Execution started. ID: ${result.data?.executionId}` }] };
  });

  server.tool("list_executions", "List recent executions for a workflow", {
    workflow_id: z.string().optional(),
    limit: z.number().optional(),
  }, async ({ workflow_id, limit = 10 }) => {
    const query = new URLSearchParams({ limit });
    if (workflow_id) query.set("workflowId", workflow_id);
    const data = await n8n("GET", `/executions?${query}`);
    return { content: [{ type: "text", text: JSON.stringify(data.data, null, 2) }] };
  });

  return server;
}

// ── Express app ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Session store
const transports = new Map();

// Streamable HTTP endpoint (new MCP standard)
app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] || randomUUID();
  let transport = transports.get(sessionId);

  if (!transport) {
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId });
    const server = createMcpServer();
    await server.connect(transport);
    transports.set(sessionId, transport);
  }

  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = transports.get(sessionId);
  if (transport) {
    await transport.handleRequest(req, res);
  } else {
    res.status(400).json({ error: "No session found. Start with POST /mcp" });
  }
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = transports.get(sessionId);
  if (transport) {
    await transport.close();
    transports.delete(sessionId);
    res.status(200).json({ ok: true });
  } else {
    res.status(404).json({ error: "Session not found" });
  }
});

app.get("/health", (_, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`n8n MCP server running on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});
