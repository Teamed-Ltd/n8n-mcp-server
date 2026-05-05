import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

const N8N_URL = process.env.N8N_URL;
const N8N_API_KEY = process.env.N8N_API_KEY;
const PORT = process.env.PORT || 3000;

if (!N8N_URL || !N8N_API_KEY) {
  console.error("Missing N8N_URL or N8N_API_KEY environment variables");
  process.exit(1);
}

// ── n8n API helper ────────────────────────────────────────────────────────────
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

// ── MCP server factory (one per SSE connection) ───────────────────────────────
function createMcpServer() {
  const server = new McpServer({ name: "n8n-builder", version: "1.0.0" });

  // LIST WORKFLOWS
  server.tool("list_workflows", "List all workflows in n8n", {}, async () => {
    const data = await n8n("GET", "/workflows");
    const workflows = data.data.map((w) => ({
      id: w.id,
      name: w.name,
      active: w.active,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(workflows, null, 2) }],
    };
  });

  // GET WORKFLOW
  server.tool(
    "get_workflow",
    "Get full details of a specific workflow",
    { id: z.string().describe("The workflow ID") },
    async ({ id }) => {
      const data = await n8n("GET", `/workflows/${id}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // CREATE WORKFLOW
  server.tool(
    "create_workflow",
    "Create a new workflow in n8n",
    {
      name: z.string().describe("Name of the new workflow"),
      nodes: z.array(z.any()).describe("Array of n8n node objects"),
      connections: z
        .record(z.any())
        .optional()
        .describe("Node connections object"),
    },
    async ({ name, nodes, connections = {} }) => {
      const data = await n8n("POST", "/workflows", { name, nodes, connections, settings: {} });
      return {
        content: [
          {
            type: "text",
            text: `Workflow created! ID: ${data.id}, Name: ${data.name}`,
          },
        ],
      };
    }
  );

  // UPDATE WORKFLOW
  server.tool(
    "update_workflow",
    "Update an existing workflow",
    {
      id: z.string().describe("The workflow ID to update"),
      name: z.string().optional().describe("New name for the workflow"),
      nodes: z.array(z.any()).optional().describe("Updated nodes array"),
      connections: z.record(z.any()).optional().describe("Updated connections"),
    },
    async ({ id, name, nodes, connections }) => {
      const existing = await n8n("GET", `/workflows/${id}`);
      const updated = await n8n("PUT", `/workflows/${id}`, {
        ...existing,
        ...(name && { name }),
        ...(nodes && { nodes }),
        ...(connections && { connections }),
      });
      return {
        content: [
          { type: "text", text: `Workflow ${id} updated successfully.` },
        ],
      };
    }
  );

  // ACTIVATE WORKFLOW
  server.tool(
    "activate_workflow",
    "Activate a workflow so it runs on its trigger",
    { id: z.string().describe("The workflow ID to activate") },
    async ({ id }) => {
      await n8n("POST", `/workflows/${id}/activate`);
      return {
        content: [{ type: "text", text: `Workflow ${id} is now active.` }],
      };
    }
  );

  // DEACTIVATE WORKFLOW
  server.tool(
    "deactivate_workflow",
    "Deactivate a workflow",
    { id: z.string().describe("The workflow ID to deactivate") },
    async ({ id }) => {
      await n8n("POST", `/workflows/${id}/deactivate`);
      return {
        content: [{ type: "text", text: `Workflow ${id} has been deactivated.` }],
      };
    }
  );

  // DELETE WORKFLOW
  server.tool(
    "delete_workflow",
    "Delete a workflow permanently",
    { id: z.string().describe("The workflow ID to delete") },
    async ({ id }) => {
      await n8n("DELETE", `/workflows/${id}`);
      return {
        content: [{ type: "text", text: `Workflow ${id} deleted.` }],
      };
    }
  );

  // EXECUTE WORKFLOW
  server.tool(
    "execute_workflow",
    "Manually trigger a workflow execution",
    {
      id: z.string().describe("The workflow ID to execute"),
      data: z.record(z.any()).optional().describe("Input data to pass to the workflow"),
    },
    async ({ id, data = {} }) => {
      const result = await n8n("POST", `/workflows/${id}/run`, { startNodes: [], destinationNode: "", data });
      return {
        content: [
          {
            type: "text",
            text: `Execution started. Execution ID: ${result.data?.executionId}`,
          },
        ],
      };
    }
  );

  // LIST EXECUTIONS
  server.tool(
    "list_executions",
    "List recent executions for a workflow",
    {
      workflow_id: z.string().optional().describe("Filter by workflow ID"),
      limit: z.number().optional().describe("Max results (default 10)"),
    },
    async ({ workflow_id, limit = 10 }) => {
      const query = new URLSearchParams({ limit });
      if (workflow_id) query.set("workflowId", workflow_id);
      const data = await n8n("GET", `/executions?${query}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data.data, null, 2) }],
      };
    }
  );

  return server;
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

const transports = {};

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;

  res.on("close", () => {
    delete transports[transport.sessionId];
  });

  const server = createMcpServer();
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) {
    return res.status(404).json({ error: "Session not found" });
  }
  await transport.handlePostMessage(req, res);
});

app.get("/health", (_, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`n8n MCP server running on port ${PORT}`);
  console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
});
