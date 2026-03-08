import { Hono } from "hono";
import { handleWsOpen, handleWsMessage, handleWsClose } from "./ws";
import agentsRouter from "./api/agents";
import daemonRouter from "./api/daemon";
import jobsRouter from "./api/jobs";
import notesRouter from "./api/notes";
import searchRouter from "./api/search";
import usageRouter from "./api/usage";
import { join } from "path";

// Resolve the client dist directory relative to this file's location
const CLIENT_DIST = join(import.meta.dir, "../client/dist");

const app = new Hono();

// API Routes
const api = new Hono();
api.route("/agents", agentsRouter);
api.route("/daemon", daemonRouter);
api.route("/jobs", jobsRouter);
api.route("/notes", notesRouter);
api.route("/search", searchRouter);
api.route("/usage", usageRouter);

app.route("/api", api);

const server = Bun.serve({
    port: process.env.PORT || 4747,
    hostname: "0.0.0.0",
    async fetch(req, server) {
        const url = new URL(req.url);

        // WebSocket upgrade
        if (url.pathname === "/ws") {
            if (server.upgrade(req)) return;
            return new Response("Upgrade failed", { status: 400 });
        }

        // API routes through Hono
        if (url.pathname.startsWith("/api")) {
            return app.fetch(req, server);
        }

        // Static file serving — resolve path within client/dist
        let filePath = join(CLIENT_DIST, url.pathname === "/" ? "index.html" : url.pathname);
        let file = Bun.file(filePath);

        // SPA fallback: if file not found, serve index.html
        if (!await file.exists()) {
            file = Bun.file(join(CLIENT_DIST, "index.html"));
        }

        return new Response(file);
    },
    websocket: {
        message(ws, message) { handleWsMessage(ws, message); },
        open(ws) { handleWsOpen(ws); },
        close(ws) { handleWsClose(ws); },
    },
});

console.log(`[hq-control-center] Server listening on http://localhost:${server.port}`);
