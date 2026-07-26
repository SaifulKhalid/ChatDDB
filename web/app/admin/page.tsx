"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/auth-context";
import { Users, MessageSquare, Shield, ArrowLeft } from "lucide-react";

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

async function adminApi(path: string, token: string) {
  const res = await fetch(path, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export default function AdminPage() {
  const { user, token, loading, logout } = useAuth();
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [userConversations, setUserConversations] = useState<{
    user: UserProfile;
    conversations: ConversationSummary[];
  } | null>(null);
  const [loadingData, setLoadingData] = useState(true);
  const [error, setError] = useState("");

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

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

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
          <a href="/login" className="text-emerald-400 hover:underline text-sm">
            Sign in
          </a>
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
          <a href="/" className="text-emerald-400 hover:underline text-sm">
            Back to Chat
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen overflow-hidden flex flex-col bg-black/95 text-white">
      {/* Header */}
      <header className="flex items-center justify-between px-6 h-14 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-3">
          <a href="/" className="text-sm text-white/50 hover:text-white transition-colors">
            ← Back to Chat
          </a>
          <div className="w-px h-5 bg-white/10" />
          <h1 className="text-lg font-semibold">Admin Dashboard</h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-white/40">{user.email}</span>
          <button
            onClick={logout}
            className="text-xs text-white/40 hover:text-red-400 transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="max-w-5xl mx-auto">
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
                <span className="text-xs text-white/40">Admins</span>
              </div>
              <div className="text-2xl font-semibold">
                0 {/* Admin count tracked via admin_emails table */}
              </div>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Main content */}
          {selectedUser && userConversations ? (
            /* User detail view */
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
                    <img
                      src={userConversations.user.photo_url}
                      alt=""
                      className="h-10 w-10 rounded-full"
                    />
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
                  <div
                    key={conv.id}
                    className="p-3 rounded-lg bg-white/[0.02] border border-white/5 hover:bg-white/[0.04] transition-colors"
                  >
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
            /* User list */
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
                    <tr
                      key={u.uid}
                      className="border-b border-white/5 hover:bg-white/[0.02] transition-colors cursor-pointer"
                      onClick={() => viewUser(u.uid)}
                    >
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
                        {u.last_sign_in
                          ? new Date(u.last_sign_in * 1000).toLocaleDateString()
                          : "Never"}
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
              {loadingData && (
                <div className="text-center py-8 text-white/30 text-sm">Loading users...</div>
              )}
              {!loadingData && users.length === 0 && (
                <div className="text-center py-8 text-white/30 text-sm">No users yet</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
