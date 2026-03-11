#!/usr/bin/env bun
import { startHQMcpServer } from "./mcpServer.js";
import { SearchClient } from "@repo/vault-client/search";
import * as path from "path";

const VAULT_PATH = process.env.VAULT_PATH || path.resolve(process.cwd(), ".vault");
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SECURITY_PROFILE = (process.env.SECURITY_PROFILE as any) || "standard";

// Initialize SearchClient so vault_search works out of the box
const searchClient = new SearchClient(VAULT_PATH);

startHQMcpServer({
  vaultPath: VAULT_PATH,
  openrouterApiKey: OPENROUTER_API_KEY,
  geminiApiKey: GEMINI_API_KEY,
  securityProfile: SECURITY_PROFILE,
  searchClient,
}).catch((err) => {
  console.error("Failed to start HQ MCP Server:", err);
  process.exit(1);
});
