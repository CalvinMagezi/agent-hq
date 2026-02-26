import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { EnvConfig } from './types';

// The monorepo root is two levels up from apps/hq-control-center
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT = path.resolve(__dirname, '../../..');
const ENV_PATH = path.join(MONOREPO_ROOT, '.env.local');

export class EnvManager {
    async getVaultPath(): Promise<string> {
        const config = await this.readEnv();
        if (config.VAULT_PATH) return config.VAULT_PATH;
        return path.join(MONOREPO_ROOT, '.vault');
    }

    async readEnv(): Promise<EnvConfig> {
        try {
            const content = await fs.readFile(ENV_PATH, 'utf-8');
            const lines = content.split('\n');
            const config: EnvConfig = {};

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) continue;

                const eqIdx = trimmed.indexOf('=');
                if (eqIdx !== -1) {
                    const key = trimmed.slice(0, eqIdx).trim();
                    let value = trimmed.slice(eqIdx + 1).trim();
                    // Remove wrapping quotes if present
                    if ((value.startsWith('"') && value.endsWith('"')) ||
                        (value.startsWith("'") && value.endsWith("'"))) {
                        value = value.slice(1, -1);
                    }
                    config[key] = value;
                }
            }
            return config;
        } catch (e: any) {
            if (e.code === 'ENOENT') {
                return {}; // No config file yet
            }
            throw e;
        }
    }

    async writeEnv(config: EnvConfig): Promise<boolean> {
        try {
            let existingContent = '';
            try {
                existingContent = await fs.readFile(ENV_PATH, 'utf-8');
            } catch (e) {
                // Ignore if file doesn't exist
            }

            const lines = existingContent ? existingContent.split('\n') : [];
            const updatedKeys = new Set<string>();

            // Update existing keys
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) {
                    const eqIdx = trimmed.indexOf('=');
                    if (eqIdx !== -1) {
                        const key = trimmed.slice(0, eqIdx).trim();
                        if (config[key] !== undefined) {
                            lines[i] = `${key}="${config[key]}"`;
                            updatedKeys.add(key);
                        }
                    }
                }
            }

            // Add new keys
            let addedAny = false;
            for (const [key, value] of Object.entries(config)) {
                if (!updatedKeys.has(key) && value !== undefined) {
                    if (!addedAny && lines.length > 0 && lines[lines.length - 1] !== '') {
                        lines.push('');
                    }
                    lines.push(`${key}="${value}"`);
                    addedAny = true;
                }
            }

            await fs.writeFile(ENV_PATH, lines.join('\n'), 'utf-8');
            return true;
        } catch (e) {
            console.error('[EnvManager] Error writing env:', e);
            return false;
        }
    }
}

export const envManager = new EnvManager();
