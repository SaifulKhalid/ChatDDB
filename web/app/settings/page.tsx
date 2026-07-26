"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Plus,
  Trash2,
  RefreshCw,
  Server,
  Eye,
} from "lucide-react";

async function apiJson(path: string) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

interface AdminModel {
  row_id: string;
  model_id: string;
  label: string;
  provider: string;
  supports_vision: number;
  supports_streaming: number;
  created_at: number;
}

interface ModelInfo {
  id: string;
  label: string;
  provider: string;
  supportsVision: boolean;
  supportsStreaming: boolean;
}

const PROVIDERS = ["groq", "gemini", "agentrouter", "openrouter"];

const PROVIDER_COLORS: Record<string, string> = {
  groq: "bg-emerald-500/10 text-emerald-400",
  gemini: "bg-blue-500/10 text-blue-400",
  agentrouter: "bg-purple-500/10 text-purple-400",
  openrouter: "bg-amber-500/10 text-amber-400",
};

export default function SettingsPage() {
  const [allModels, setAllModels] = useState<ModelInfo[]>([]);
  const [adminModels, setAdminModels] = useState<AdminModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Add form state
  const [newId, setNewId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newProvider, setNewProvider] = useState("openrouter");
  const [newVision, setNewVision] = useState(false);
  const [adding, setAdding] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [modelsRes, adminRes] = await Promise.all([
        apiJson("/api/models"),
        apiJson("/api/admin/models"),
      ]);
      setAllModels(modelsRes.models ?? []);
      setAdminModels(adminRes.models ?? []);
    } catch (e: any) {
      setError(e.message || "Failed to load models");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const adminModelIds = new Set(adminModels.map((m) => m.model_id));

  async function handleAdd() {
    if (!newId.trim() || !newLabel.trim()) return;
    setAdding(true);
    try {
      const res = await fetch("/api/admin/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model_id: newId.trim(),
          label: newLabel.trim(),
          provider: newProvider,
          supports_vision: newVision,
          supports_streaming: true,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      setNewId("");
      setNewLabel("");
      setNewVision(false);
      await loadData();
    } catch (e: any) {
      alert("Failed to add: " + e.message);
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(modelId: string) {
    if (!confirm(`Delete model "${modelId}"? This cannot be undone.`)) return;
    try {
      const res = await fetch("/api/admin/models", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model_id: modelId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      await loadData();
    } catch (e: any) {
      alert("Failed to delete: " + e.message);
    }
  }

  return (
    <div className="h-screen overflow-hidden flex flex-col bg-black/95 text-white">
      {/* Header */}
      <header className="flex items-center gap-3 px-6 h-14 border-b border-white/10 shrink-0">
        <a
          href="/"
          className="text-sm text-white/50 hover:text-white transition-colors"
        >
          ← Back to Chat
        </a>
        <div className="w-px h-5 bg-white/10" />
        <h1 className="text-lg font-semibold">Model Management</h1>
      </header>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="max-w-4xl mx-auto">
          <p className="text-sm text-white/50 mb-6 leading-relaxed">
            Manage AI models available in the chat interface. Models added here
            are merged with hardcoded defaults. Use this to add, remove, or
            update models when providers change model IDs — without touching the
            code. Changes take effect immediately.
          </p>

          {/* Add form */}
          <div className="flex flex-wrap gap-3 items-center p-4 bg-white/5 rounded-lg mb-5">
            <input
              className="flex-1 min-w-[200px] px-3 py-2 bg-white/5 border border-white/10 rounded-md text-sm font-mono outline-none focus:border-emerald-500/50 transition-colors"
              placeholder="Model ID (e.g. openrouter:new/model:free)"
              value={newId}
              onChange={(e) => setNewId(e.target.value)}
            />
            <input
              className="w-32 px-3 py-2 bg-white/5 border border-white/10 rounded-md text-sm outline-none focus:border-emerald-500/50"
              placeholder="Display name"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
            />
            <select
              className="px-3 py-2 bg-white/5 border border-white/10 rounded-md text-sm outline-none focus:border-emerald-500/50"
              value={newProvider}
              onChange={(e) => setNewProvider(e.target.value)}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-xs text-white/50 cursor-pointer">
              <input
                type="checkbox"
                checked={newVision}
                onChange={(e) => setNewVision(e.target.checked)}
                className="accent-emerald-500"
              />
              <Eye size={14} />
              Vision
            </label>
            <button
              onClick={handleAdd}
              disabled={adding || !newId.trim() || !newLabel.trim()}
              className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded-md text-sm font-medium transition-colors"
            >
              <Plus size={16} />
              {adding ? "Adding..." : "Add Model"}
            </button>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-3 mb-3">
            <button
              onClick={loadData}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-white/10 rounded-md text-xs text-white/60 hover:text-white hover:border-white/30 transition-all"
            >
              <RefreshCw size={14} />
              Refresh
            </button>
            <span className="text-xs text-white/40">
              {allModels.length} model{allModels.length !== 1 ? "s" : ""} (
              {adminModels.length} custom)
            </span>
          </div>

          {/* Table */}
          {loading ? (
            <div className="text-center py-12 text-white/40 text-sm">
              Loading models...
            </div>
          ) : error ? (
            <div className="text-center py-12 text-red-400 text-sm">{error}</div>
          ) : (
            <div className="overflow-x-auto border border-white/10 rounded-lg">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 bg-white/5">
                    <th className="text-left px-4 py-3 font-medium text-white/40 text-xs uppercase tracking-wider">
                      Model ID
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-white/40 text-xs uppercase tracking-wider">
                      Label
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-white/40 text-xs uppercase tracking-wider">
                      Provider
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-white/40 text-xs uppercase tracking-wider">
                      Vision
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-white/40 text-xs uppercase tracking-wider">
                      Source
                    </th>
                    <th className="w-12" />
                  </tr>
                </thead>
                <tbody>
                  {allModels.map((m) => {
                    const isCustom = adminModelIds.has(m.id);
                    return (
                      <tr
                        key={m.id}
                        className={`border-b border-white/5 hover:bg-white/[0.02] transition-colors ${
                          isCustom ? "bg-emerald-500/[0.03]" : ""
                        }`}
                      >
                        <td
                          className="px-4 py-3 font-mono text-xs text-white/70 max-w-[280px] truncate"
                          title={m.id}
                        >
                          {m.id}
                        </td>
                        <td className="px-4 py-3">{m.label}</td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                              PROVIDER_COLORS[m.provider] ||
                              "bg-white/5 text-white/50"
                            }`}
                          >
                            <Server size={12} />
                            {m.provider}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {m.supportsVision ? (
                            <span className="text-emerald-400 font-medium">
                              ✓
                            </span>
                          ) : (
                            <span className="text-white/30">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {isCustom ? (
                            <span className="text-emerald-400 text-xs">
                              Custom
                            </span>
                          ) : (
                            <span className="text-white/30 text-xs bg-white/5 px-1.5 py-0.5 rounded">
                              Default
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {isCustom && (
                            <button
                              onClick={() => handleDelete(m.id)}
                              className="p-1.5 rounded text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-all"
                              title="Delete"
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
