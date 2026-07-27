"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/auth-context";
import {
  Users,
  MessageSquare,
  Shield,
  ArrowLeft,
  Plus,
  Trash2,
  Eye,
  RefreshCw,
  Bot,
} from "lucide-react";
import { API_BASE } from "@/lib/api";

interface UserProfile {
  uid: string;
  email: string;
  display_name: string;
  photo_url: string;
  is_disabled: number;
  last_sign_in: number | null;
  created_at: number;
}

interface ConversationSummary {
  id: string;
  title: string;
  model: string;
  created_at: number;
  updated_at: number;
  message_count: number;
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

const PROVIDERS = ["groq", "gemini", "agentrouter", "openrouter", "workers-ai"];

const PROVIDER_COLORS: Record<string, string> = {
  groq: "bg-emerald-500/10 text-emerald-400",
  gemini: "bg-blue-500/10 text-blue-400",
  agentrouter: "bg-purple-500/10 text-purple-400",
  openrouter: "bg-amber-500/10 text-amber-400",
  "workers-ai": "bg-cyan-500/10 text-cyan-400",
};

type Tab = "users" | "models" | "admins";

async function adminApi(path: string, token: string, options?: RequestInit) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${res.status}`);
  }
  return res.json();
}

export default function AdminPage() {
  const { user, token, loading, logout } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>("users");

  // User management
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [userConversations, setUserConversations] = useState<{
    user: UserProfile;
    conversations: ConversationSummary[];
  } | null>(null);
  const [loadingData, setLoadingData] = useState(true);
  const [error, setError] = useState("");

  // Model management
  const [allModels, setAllModels] = useState<ModelInfo[]>([]);
  const [adminModels, setAdminModels] = useState<AdminModel[]>([]);
  const [newModelId, setNewModelId] = useState("");
  const [newModelLabel, setNewModelLabel] = useState("");
  const [newModelProvider, setNewModelProvider] = useState("openrouter");
  const [newModelVision, setNewModelVision] = useState(false);
  const [addingModel, setAddingModel] = useState(false);

  // Admin email management (future: add/remove from DB via API)
  // Currently managed through database CLI

  const loadUsers = useCallback(async () => {
    if (!token) return;
    setLoadingData(true);
    setError("");
    try {
      const data = await adminApi("/api/admin/users", token);
      setUsers(data.users ?? []);
    } catch (e: any) {
      setError(e.message || "Failed to load users");
    } finally {
      setLoadingData(false);
    }
  }, [token]);

  const loadModels = useCallback(async () => {
    if (!token) return;
    try {
      const [modelsRes, adminRes] = await Promise.all([
        fetch(`${API_BASE}/api/models`).then((r) => r.json()),
        adminApi("/api/admin/models", token),
      ]);
      setAllModels(modelsRes.models ?? []);
      setAdminModels(adminRes.models ?? []);
    } catch (e: any) {
      console.error("Failed to load models", e);
    }
  }, [token]);

  useEffect(() => {
    if (activeTab === "users") loadUsers();
    if (activeTab === "models") loadModels();
    if (activeTab === "admins") loadUsers(); // re-use loadUsers for admin tab reference
  }, [activeTab, loadUsers, loadModels]);

  const viewUser = async (uid: string) => {
    if (!token) return;
    setSelectedUser(uid);
    try {
      const data = await adminApi(`/api/admin/users/${uid}`, token);
      setUserConversations(data);
    } catch (e: any) {
      setError(e.message || "Failed to load user details");
    }
  };

  const handleAddModel = async () => {
    if (!newModelId.trim() || !newModelLabel.trim() || !token) return;
    setAddingModel(true);
    try {
      await adminApi("/api/admin/models", token, {
        method: "POST",
        body: JSON.stringify({
          model_id: newModelId.trim(),
          label: newModelLabel.trim(),
          provider: newModelProvider,
          supports_vision: newModelVision,
          supports_streaming: true,
        }),
      });
      setNewModelId("");
      setNewModelLabel("");
      setNewModelVision(false);
      await loadModels();
    } catch (e: any) {
      setError(e.message || "Failed to add model");
    } finally {
      setAddingModel(false);
    }
  };

  const handleDeleteModel = async (modelId: string) => {
    if (!token) return;
    try {
      await adminApi("/api/admin/models", token, {
        method: "DELETE",
        body: JSON.stringify({ model_id: modelId }),
      });
      await loadModels();
    } catch (e: any) {
      setError(e.message || "Failed to delete model");
    }
  };

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-black/95">
        <div className="text-white/50 text-sm">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="h-screen flex items-center justify-center bg-black/95">
        <div className="text-center">
          <div className="text-red-400 text-sm mb-2">Not authenticated</div>
          <a href="/login" className="text-emerald-400 hover:underline text-sm">Sign in</a>
        </div>
      </div>
    );
  }

  if (!user.isAdmin) {
    return (
      <div className="h-screen flex items-center justify-center bg-black/95">
        <div className="text-center">
          <Shield className="h-12 w-12 text-red-400/50 mx-auto mb-3" />
          <div className="text-red-400 text-sm mb-2">Admin access required</div>
          <a href="/" className="text-emerald-400 hover:underline text-sm">Back to Chat</a>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen overflow-hidden flex flex-col bg-black/95 text-white">
      {/* Header */}
      <header className="flex items-center justify-between px-6 h-14 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-3">
          <a href="/" className="text-sm text-white/50 hover:text-white transition-colors">← Back to Chat</a>
          <div className="w-px h-5 bg-white/10" />
          <h1 className="text-lg font-semibold">Admin Dashboard</h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-white/40">{user.email}</span>
          <button onClick={logout} className="text-xs text-white/40 hover:text-red-400 transition-colors">Sign out</button>
        </div>
      </header>

      {/* Tabs */}
      <div className="flex items-center gap-1 px-6 pt-4 pb-2 border-b border-white/5">
        {[
          { id: "users" as Tab, label: "Users", icon: Users },
          { id: "models" as Tab, label: "Models", icon: Bot },
          { id: "admins" as Tab, label: "Admins", icon: Shield },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => { setActiveTab(tab.id); setSelectedUser(null); setUserConversations(null); }}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === tab.id
                ? "bg-white/10 text-white"
                : "text-white/40 hover:text-white/70 hover:bg-white/5"
            }`}
          >
            <tab.icon className="h-4 w-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="max-w-5xl mx-auto">
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{error}</div>
          )}

          {/* ==================== USERS TAB ==================== */}
          {activeTab === "users" && (
            <>
              {/* Stats */}
              <div className="grid grid-cols-3 gap-4 mb-6">
                <div className="p-4 rounded-lg bg-white/5 border border-white/10">
                  <div className="flex items-center gap-2 mb-1">
                    <Users className="h-4 w-4 text-emerald-400" />
                    <span className="text-xs text-white/40">Total Users</span>
                  </div>
                  <div className="text-2xl font-semibold">{users.length}</div>
                </div>
                <div className="p-4 rounded-lg bg-white/5 border border-white/10">
                  <div className="flex items-center gap-2 mb-1">
                    <MessageSquare className="h-4 w-4 text-blue-400" />
                    <span className="text-xs text-white/40">Active (24h)</span>
                  </div>
                  <div className="text-2xl font-semibold">
                    {users.filter((u) => u.last_sign_in && u.last_sign_in > Date.now() / 1000 - 86400).length}
                  </div>
                </div>
                <div className="p-4 rounded-lg bg-white/5 border border-white/10">
                  <div className="flex items-center gap-2 mb-1">
                    <Shield className="h-4 w-4 text-amber-400" />
                    <span className="text-xs text-white/40">Total Conversations</span>
                  </div>
                  <div className="text-2xl font-semibold">
                    {users.reduce((sum, u) => sum + (u.last_sign_in ? 1 : 0), 0)}
                  </div>
                </div>
              </div>

              {/* User list or detail view */}
              {selectedUser && userConversations ? (
                <div>
                  <button
                    onClick={() => { setSelectedUser(null); setUserConversations(null); }}
                    className="flex items-center gap-1.5 text-sm text-white/50 hover:text-white mb-4 transition-colors"
                  >
                    <ArrowLeft className="h-4 w-4" /> Back to all users
                  </button>
                  <div className="p-4 rounded-lg bg-white/5 border border-white/10 mb-4">
                    <div className="flex items-center gap-3">
                      {userConversations.user.photo_url ? (
                        <img src={userConversations.user.photo_url} alt="" className="h-10 w-10 rounded-full" />
                      ) : (
                        <div className="h-10 w-10 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-400 font-semibold">
                          {userConversations.user.email.charAt(0).toUpperCase()}
                        </div>
                      )}
                      <div>
                        <div className="font-medium">{userConversations.user.display_name || "Unknown"}</div>
                        <div className="text-sm text-white/50">{userConversations.user.email}</div>
                      </div>
                      <div className="ml-auto text-xs text-white/30">
                        Joined {new Date(userConversations.user.created_at * 1000).toLocaleDateString()}
                      </div>
                    </div>
                  </div>
                  <h3 className="text-sm font-medium text-white/50 mb-3">
                    Conversations ({userConversations.conversations.length})
                  </h3>
                  <div className="space-y-2">
                    {userConversations.conversations.map((conv) => (
                      <div key={conv.id} className="p-3 rounded-lg bg-white/[0.02] border border-white/5 hover:bg-white/[0.04] transition-colors">
                        <div className="flex items-center justify-between">
                          <div className="font-medium text-sm truncate max-w-[400px]">{conv.title}</div>
                          <div className="text-xs text-white/30">{conv.message_count} messages</div>
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-xs text-white/30">
                          <span>Model: {conv.model}</span>
                          <span>Updated: {new Date(conv.updated_at * 1000).toLocaleDateString()}</span>
                        </div>
                      </div>
                    ))}
                    {userConversations.conversations.length === 0 && (
                      <div className="text-center py-8 text-white/30 text-sm">No conversations</div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="border border-white/10 rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/10 bg-white/5">
                        <th className="text-left px-4 py-3 font-medium text-white/40 text-xs uppercase">User</th>
                        <th className="text-left px-4 py-3 font-medium text-white/40 text-xs uppercase">Email</th>
                        <th className="text-left px-4 py-3 font-medium text-white/40 text-xs uppercase">Last Sign In</th>
                        <th className="text-left px-4 py-3 font-medium text-white/40 text-xs uppercase">Joined</th>
                        <th className="w-12" />
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((u) => (
                        <tr key={u.uid} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors cursor-pointer" onClick={() => viewUser(u.uid)}>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              {u.photo_url ? (
                                <img src={u.photo_url} alt="" className="h-7 w-7 rounded-full" />
                              ) : (
                                <div className="h-7 w-7 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-400 text-xs font-semibold">
                                  {(u.display_name || u.email).charAt(0).toUpperCase()}
                                </div>
                              )}
                              <span className="font-medium">{u.display_name || "Unknown"}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-white/60">{u.email}</td>
                          <td className="px-4 py-3 text-white/40">
                            {u.last_sign_in ? new Date(u.last_sign_in * 1000).toLocaleDateString() : "Never"}
                          </td>
                          <td className="px-4 py-3 text-white/40">
                            {new Date(u.created_at * 1000).toLocaleDateString()}
                          </td>
                          <td className="px-4 py-3">
                            <MessageSquare className="h-4 w-4 text-white/20" />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {loadingData && <div className="text-center py-8 text-white/30 text-sm">Loading users...</div>}
                  {!loadingData && users.length === 0 && <div className="text-center py-8 text-white/30 text-sm">No users yet</div>}
                </div>
              )}
            </>
          )}

          {/* ==================== MODELS TAB ==================== */}
          {activeTab === "models" && (
            <div>
              {/* Add model form */}
              <div className="flex flex-wrap gap-3 items-center p-4 bg-white/5 rounded-lg mb-5">
                <input
                  className="flex-1 min-w-[200px] px-3 py-2 bg-white/5 border border-white/10 rounded-md text-sm font-mono outline-none focus:border-emerald-500/50 transition-colors"
                  placeholder="Model ID (e.g. openrouter:new/model:free)"
                  value={newModelId}
                  onChange={(e) => setNewModelId(e.target.value)}
                />
                <input
                  className="w-32 px-3 py-2 bg-white/5 border border-white/10 rounded-md text-sm outline-none focus:border-emerald-500/50"
                  placeholder="Display name"
                  value={newModelLabel}
                  onChange={(e) => setNewModelLabel(e.target.value)}
                />
                <select
                  className="px-3 py-2 bg-white/5 border border-white/10 rounded-md text-sm outline-none focus:border-emerald-500/50"
                  value={newModelProvider}
                  onChange={(e) => setNewModelProvider(e.target.value)}
                >
                  {PROVIDERS.map((p) => (
                    <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
                  ))}
                </select>
                <label className="flex items-center gap-1.5 text-xs text-white/50 cursor-pointer">
                  <input type="checkbox" checked={newModelVision} onChange={(e) => setNewModelVision(e.target.checked)} className="accent-emerald-500" />
                  <Eye size={14} /> Vision
                </label>
                <button
                  onClick={handleAddModel}
                  disabled={addingModel || !newModelId.trim() || !newModelLabel.trim()}
                  className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded-md text-sm font-medium transition-colors"
                >
                  <Plus size={16} />
                  {addingModel ? "Adding..." : "Add Model"}
                </button>
              </div>

              {/* Controls */}
              <div className="flex items-center gap-3 mb-3">
                <button onClick={loadModels} className="flex items-center gap-1.5 px-3 py-1.5 border border-white/10 rounded-md text-xs text-white/60 hover:text-white hover:border-white/30 transition-all">
                  <RefreshCw size={14} /> Refresh
                </button>
                <span className="text-xs text-white/40">
                  {allModels.length} models total ({adminModels.length} custom)
                </span>
              </div>

              {/* Models table */}
              <div className="overflow-x-auto border border-white/10 rounded-lg">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 bg-white/5">
                      <th className="text-left px-4 py-3 font-medium text-white/40 text-xs uppercase">Model ID</th>
                      <th className="text-left px-4 py-3 font-medium text-white/40 text-xs uppercase">Label</th>
                      <th className="text-left px-4 py-3 font-medium text-white/40 text-xs uppercase">Provider</th>
                      <th className="text-center px-4 py-3 font-medium text-white/40 text-xs uppercase">Vision</th>
                      <th className="text-center px-4 py-3 font-medium text-white/40 text-xs uppercase">Streaming</th>
                      <th className="text-center px-4 py-3 font-medium text-white/40 text-xs uppercase">Source</th>
                      <th className="w-16" />
                    </tr>
                  </thead>
                  <tbody>
                    {adminModels.map((m) => (
                      <tr key={m.row_id} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
                        <td className="px-4 py-3 font-mono text-xs text-white/70">{m.model_id}</td>
                        <td className="px-4 py-3 font-medium">{m.label}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${PROVIDER_COLORS[m.provider] || "bg-white/5 text-white/60"}`}>
                            {m.provider}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center text-xs text-white/40">{m.supports_vision ? "✅" : "—"}</td>
                        <td className="px-4 py-3 text-center text-xs text-white/40">{m.supports_streaming ? "✅" : "—"}</td>
                        <td className="px-4 py-3 text-center">
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400">Custom</span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <button onClick={() => handleDeleteModel(m.model_id)} className="p-1 rounded text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-all" title="Delete model">
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                    {allModels.filter((m) => !adminModels.some((a) => a.model_id === m.id)).map((m) => (
                      <tr key={m.id} className="border-b border-white/5 text-white/60">
                        <td className="px-4 py-3 font-mono text-xs">{m.id}</td>
                        <td className="px-4 py-3">{m.label}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${PROVIDER_COLORS[m.provider] || "bg-white/5 text-white/60"}`}>
                            {m.provider}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center text-xs">{m.supportsVision ? "✅" : "—"}</td>
                        <td className="px-4 py-3 text-center text-xs">{m.supportsStreaming ? "✅" : "—"}</td>
                        <td className="px-4 py-3 text-center">
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-white/30">Default</span>
                        </td>
                        <td className="px-4 py-3" />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ==================== ADMINS TAB ==================== */}
          {activeTab === "admins" && (
            <div>
              <p className="text-sm text-white/50 mb-6 leading-relaxed">
                Manage administrator emails. Only users with emails in this list can access the admin panel.
                Admin management must be done via the database CLI for security reasons.
              </p>

              {/* Current admin users */}
              <div className="border border-white/10 rounded-lg overflow-hidden mb-6">
                <div className="px-4 py-3 bg-white/5 border-b border-white/10">
                  <h3 className="text-sm font-medium">Current Administrators</h3>
                </div>
                <div className="p-6 text-center text-white/40 text-sm">
                  <p>Admin emails are managed through the database.</p>
                  <p className="mt-2 text-xs text-white/30">
                    To add an admin, run: <code className="px-1.5 py-0.5 rounded bg-white/5 font-mono">npx wrangler d1 execute prototype-chatbot-db --remote --command="INSERT OR IGNORE INTO admin_emails (email, added_by) VALUES ('email@example.com', 'admin');"</code>
                  </p>
                </div>
              </div>

              {/* Recent user list for reference */}
              <div className="border border-white/10 rounded-lg overflow-hidden">
                <div className="px-4 py-3 bg-white/5 border-b border-white/10">
                  <h3 className="text-sm font-medium">Registered Users (for reference)</h3>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 bg-white/5">
                      <th className="text-left px-4 py-3 font-medium text-white/40 text-xs uppercase">Email</th>
                      <th className="text-left px-4 py-3 font-medium text-white/40 text-xs uppercase">Name</th>
                      <th className="text-left px-4 py-3 font-medium text-white/40 text-xs uppercase">Last Sign In</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.uid} className="border-b border-white/5 text-white/60">
                        <td className="px-4 py-3">{u.email}</td>
                        <td className="px-4 py-3">{u.display_name || "—"}</td>
                        <td className="px-4 py-3 text-white/40">
                          {u.last_sign_in ? new Date(u.last_sign_in * 1000).toLocaleDateString() : "Never"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {users.length === 0 && <div className="text-center py-6 text-white/30 text-sm">No users registered yet</div>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
