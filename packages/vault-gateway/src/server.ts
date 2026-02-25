import { serve } from "bun";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { bearerAuth } from "hono/bearer-auth";

type Variables = {
    agent: { role: "admin" | "relay" | "readonly"; id: string };
};

const app = new Hono<{ Variables: Variables }>();

// Configuration
const OBSIDIAN_PORT = process.env.OBSIDIAN_REST_PORT || 27124;
const OBSIDIAN_HOST = process.env.OBSIDIAN_REST_HOST || "127.0.0.1";
const OBSIDIAN_API_KEY = process.env.OBSIDIAN_API_KEY || "";
const GATEWAY_PORT = process.env.GATEWAY_PORT || 3001;

// Agent Identity & ACL mapping — loaded from AGENT_TOKENS env var.
// Format: comma-separated list of `token:role:id` triples.
// Example: AGENT_TOKENS="tok1:admin:hq-admin,tok2:relay:discord-relay"
type AgentRole = "admin" | "relay" | "readonly";
const VALID_ROLES = new Set<AgentRole>(["admin", "relay", "readonly"]);

const AGENT_TOKENS: Record<string, { role: AgentRole; id: string }> = Object.fromEntries(
    (process.env.AGENT_TOKENS ?? "")
        .split(",")
        .map(entry => entry.trim())
        .filter(Boolean)
        .map(entry => {
            const [token, role, id] = entry.split(":");
            if (!token || !role || !id) {
                throw new Error(`Invalid AGENT_TOKENS entry "${entry}" — expected "token:role:id"`);
            }
            if (!VALID_ROLES.has(role as AgentRole)) {
                throw new Error(`Invalid role "${role}" in AGENT_TOKENS — must be admin|relay|readonly`);
            }
            return [token, { role: role as AgentRole, id }];
        })
);

if (Object.keys(AGENT_TOKENS).length === 0 && process.env.MOCK_OBSIDIAN !== "true") {
    console.error("❌ No agent tokens configured. Set the AGENT_TOKENS environment variable.");
    console.error("   Format: AGENT_TOKENS=\"tok1:admin:hq-admin,tok2:relay:discord-relay\"");
    process.exit(1);
}

app.use("*", logger());

// 1. Authentication Middleware
app.use("*", async (c, next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return c.json({ error: "Missing or invalid Authorization header" }, 401);
    }
    const token = authHeader.replace("Bearer ", "");
    const agent = AGENT_TOKENS[token];

    if (!agent) {
        return c.json({ error: "Invalid agent token" }, 403);
    }

    c.set("agent", agent);
    await next();
});

// 2. ACL Middleware
app.use("/vault/*", async (c, next) => {
    const agent = c.get("agent");
    const path = c.req.path.replace("/vault/", "");
    const method = c.req.method;

    if (agent.role === "admin") {
        return await next();
    }

    if (agent.role === "readonly" && method !== "GET") {
        return c.json({ error: "Read-only access" }, 403);
    }

    // Relays can only touch specific directories
    if (agent.role === "relay") {
        const allowedPrefixes = ["_delegation/", "_locks/", "_events/"];
        const isAllowed = allowedPrefixes.some(prefix => path.startsWith(prefix));
        if (!isAllowed && method !== "GET") {
            return c.json({ error: `Agent ${agent.id} cannot modify ${path}` }, 403);
        }
    }

    await next();
});

// 3. Proxy Handler to Obsidian Local REST API
app.all("*", async (c) => {
    // We forward the request to the local Obsidian REST API
    // but we strip the gateway's auth and inject the master OBSIDIAN_API_KEY

    const targetUrl = new URL(c.req.url);
    targetUrl.protocol = "https:";
    targetUrl.hostname = OBSIDIAN_HOST;
    targetUrl.port = OBSIDIAN_PORT.toString();

    const headers = new Headers(c.req.header());
    headers.set("Authorization", `Bearer ${OBSIDIAN_API_KEY}`);
    // The host header must match the target or some servers reject it
    headers.set("Host", `${OBSIDIAN_HOST}:${OBSIDIAN_PORT}`);

    try {
        if (process.env.MOCK_OBSIDIAN === "true") {
            return c.json({ mockObsidian: true, proxiedPath: targetUrl.pathname }, 200);
        }

        const proxyRes = await fetch(targetUrl.toString(), {
            method: c.req.method,
            headers,
            body: c.req.raw.body,
            // Need this because the plugin uses a self-signed cert
            tls: {
                rejectUnauthorized: false
            }
        });

        // Create a new response to stream back to the client
        const resHeaders = new Headers(proxyRes.headers);
        return new Response(proxyRes.body, {
            status: proxyRes.status,
            statusText: proxyRes.statusText,
            headers: resHeaders,
        });
    } catch (err: any) {
        console.error("Proxy error:", err);
        return c.json({ error: "Failed to connect to Obsidian REST API", details: err.message }, 502);
    }
});

console.log(`🚀 Vault Gateway running at http://localhost:${GATEWAY_PORT}`);
serve({
    fetch: app.fetch,
    port: Number(GATEWAY_PORT),
});
