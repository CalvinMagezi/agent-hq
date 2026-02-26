import { useState } from 'react';
import { useSystemStore } from '../store/system-store';

export function SetupWizard() {
    const { config } = useSystemStore();
    const [formData, setFormData] = useState({
        OPENROUTER_API_KEY: config?.OPENROUTER_API_KEY || '',
        GEMINI_API_KEY: config?.GEMINI_API_KEY || '',
        DEFAULT_MODEL: config?.DEFAULT_MODEL || 'gemini-2.5-flash',
        BRAVE_SEARCH_API_KEY: config?.BRAVE_SEARCH_API_KEY || ''
    });

    const [saving, setSaving] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        await window.electronAPI.saveEnvConfig(formData);
        // After save, reload config from disk
        const newConfig = await window.electronAPI.getEnvConfig();
        useSystemStore.getState().setConfig(newConfig);
        setSaving(false);
    };

    return (
        <div className="setup-wizard max-w-2xl mx-auto p-8 mt-10 bg-dark rounded-xl shadow-2xl border border-gray-700 text-main">
            <h2 className="text-3xl font-bold mb-2 text-white">Welcome to Agent HQ</h2>
            <p className="text-gray-400 mb-8">Let's configure your environment to get started.</p>

            <form onSubmit={handleSubmit} className="space-y-6">
                <div>
                    <label className="block text-sm font-medium mb-1">OpenRouter API Key (Required for most models)</label>
                    <input
                        type="password"
                        value={formData.OPENROUTER_API_KEY}
                        onChange={e => setFormData({ ...formData, OPENROUTER_API_KEY: e.target.value })}
                        className="w-full bg-gray-950 border border-gray-700 rounded p-2 focus:border-blue-500 focus:outline-none"
                        placeholder="sk-or-v1-..."
                    />
                </div>

                <div>
                    <label className="block text-sm font-medium mb-1">Gemini API Key (Optional)</label>
                    <input
                        type="password"
                        value={formData.GEMINI_API_KEY}
                        onChange={e => setFormData({ ...formData, GEMINI_API_KEY: e.target.value })}
                        className="w-full bg-gray-950 border border-gray-700 rounded p-2 focus:border-blue-500 focus:outline-none"
                        placeholder="AIza..."
                    />
                </div>

                <div>
                    <label className="block text-sm font-medium mb-1">Default Model</label>
                    <input
                        type="text"
                        value={formData.DEFAULT_MODEL}
                        onChange={e => setFormData({ ...formData, DEFAULT_MODEL: e.target.value })}
                        className="w-full bg-gray-950 border border-gray-700 rounded p-2 focus:border-blue-500 focus:outline-none"
                        placeholder="e.g. gemini-2.5-flash"
                    />
                </div>

                <div>
                    <label className="block text-sm font-medium mb-1">Brave Search API Key (Required for web-digest workflow)</label>
                    <input
                        type="password"
                        value={formData.BRAVE_SEARCH_API_KEY}
                        onChange={e => setFormData({ ...formData, BRAVE_SEARCH_API_KEY: e.target.value })}
                        className="w-full bg-gray-950 border border-gray-700 rounded p-2 focus:border-blue-500 focus:outline-none"
                        placeholder="BSAj..."
                    />
                </div>

                <button
                    type="submit"
                    disabled={saving}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-black font-bold py-3 px-4 rounded transition-colors disabled:opacity-50"
                >
                    {saving ? 'Saving...' : 'Save & Boot HQ'}
                </button>
            </form>
        </div>
    );
}
