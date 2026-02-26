import { useState, useEffect } from 'react';
import { useSystemStore } from '../store/system-store';

export function Settings() {
    const { config, setConfig } = useSystemStore();
    const [formData, setFormData] = useState({
        OPENROUTER_API_KEY: '',
        GEMINI_API_KEY: '',
        DEFAULT_MODEL: '',
        BRAVE_SEARCH_API_KEY: '',
        AGENTHQ_API_KEY: '',
        VAULT_PATH: ''
    });
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        if (config) {
            setFormData({
                OPENROUTER_API_KEY: config.OPENROUTER_API_KEY || '',
                GEMINI_API_KEY: config.GEMINI_API_KEY || '',
                DEFAULT_MODEL: config.DEFAULT_MODEL || '',
                BRAVE_SEARCH_API_KEY: config.BRAVE_SEARCH_API_KEY || '',
                AGENTHQ_API_KEY: config.AGENTHQ_API_KEY || '',
                VAULT_PATH: config.VAULT_PATH || '',
            });
        }
    }, [config]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setFormData({ ...formData, [e.target.name]: e.target.value });
        setSaved(false);
    };

    const handleSave = async () => {
        const success = await window.electronAPI.saveEnvConfig(formData);
        if (success) {
            setSaved(true);
            const newConfig = await window.electronAPI.getEnvConfig();
            setConfig(newConfig);
        }
    };

    return (
        <div className="flex flex-col items-center p-8 bg-dark h-full text-main overflow-y-auto">
            <div className="w-full max-w-2xl bg-gray-900 border border-gray-700 rounded-xl p-8 shadow-2xl">
                <h2 className="text-2xl font-bold mb-2 text-white">System Settings</h2>
                <p className="text-gray-400 mb-6 text-sm">Manage your Agent HQ configuration and API keys. Changes require daemon restart.</p>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium mb-1">OpenRouter API Key (Required)</label>
                        <input
                            type="password"
                            name="OPENROUTER_API_KEY"
                            value={formData.OPENROUTER_API_KEY}
                            onChange={handleChange}
                            className="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition-colors"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Gemini API Key (Optional)</label>
                        <input
                            type="password"
                            name="GEMINI_API_KEY"
                            value={formData.GEMINI_API_KEY}
                            onChange={handleChange}
                            className="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition-colors"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Brave Search API Key (Optional)</label>
                        <input
                            type="password"
                            name="BRAVE_SEARCH_API_KEY"
                            value={formData.BRAVE_SEARCH_API_KEY}
                            onChange={handleChange}
                            className="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition-colors"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Agent HQ Relay API Key</label>
                        <input
                            type="password"
                            name="AGENTHQ_API_KEY"
                            value={formData.AGENTHQ_API_KEY}
                            onChange={handleChange}
                            className="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition-colors"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Default Model Override</label>
                        <input
                            type="text"
                            name="DEFAULT_MODEL"
                            value={formData.DEFAULT_MODEL}
                            onChange={handleChange}
                            placeholder="e.g. anthropic/claude-3.5-sonnet"
                            className="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition-colors"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Local Vault Path</label>
                        <input
                            type="text"
                            name="VAULT_PATH"
                            value={formData.VAULT_PATH}
                            onChange={handleChange}
                            placeholder="/absolute/path/to/vault"
                            className="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition-colors"
                        />
                    </div>
                </div>

                <div className="mt-8 flex justify-end items-center gap-4">
                    {saved && <span className="text-green-500 text-sm">Settings saved!</span>}
                    <button
                        onClick={handleSave}
                        className="bg-blue-600 hover:bg-blue-700 px-6 py-2 rounded font-semibold transition-colors shadow-lg text-black"
                    >
                        Save Configuration
                    </button>
                </div>
            </div>
        </div>
    );
}
