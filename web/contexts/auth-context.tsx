"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import {
  onAuthStateChanged,
  signInWithPopup,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  getIdToken,
  type User,
} from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebase";
import { setAuthToken as setApiToken } from "@/lib/api";

export interface AuthUser {
  uid: string;
  email: string;
  name: string;
  picture: string;
  isAdmin: boolean;
}

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  token: string | null;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  token: null,
  signInWithGoogle: async () => {},
  signInWithEmail: async () => {},
  signUpWithEmail: async () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState<string | null>(null);

  const refreshToken = useCallback(async (u: User) => {
    try {
      const t = await getIdToken(u, true);
      setToken(t);
      setApiToken(t);
    } catch {
      setToken(null);
      setApiToken(null);
    }
  }, []);

  useEffect(() => {
    const auth = getFirebaseAuth();
    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      setFirebaseUser(fbUser);
      if (fbUser) {
        setLoading(true);
        await refreshToken(fbUser);
        // Fetch user profile from backend (admin status, etc.)
        try {
          const t = await getIdToken(fbUser);
          const res = await fetch("/api/auth/me", {
            headers: { Authorization: `Bearer ${t}` },
          });
          if (res.ok) {
            const data = await res.json();
            setUser(data.user);
          } else {
            setUser({
              uid: fbUser.uid,
              email: fbUser.email || "",
              name: fbUser.displayName || "",
              picture: fbUser.photoURL || "",
              isAdmin: false,
            });
          }
        } catch {
          setUser({
            uid: fbUser.uid,
            email: fbUser.email || "",
            name: fbUser.displayName || "",
            picture: fbUser.photoURL || "",
            isAdmin: false,
          });
        }
      } else {
        setUser(null);
        setToken(null);
        // Clear any stored conversations
        localStorage.removeItem("chatddb-conversation");
      }
      setLoading(false);
    });
    return unsubscribe;
  }, [refreshToken]);

  // Refresh token periodically (every 10 minutes)
  useEffect(() => {
    if (!firebaseUser) return;
    const interval = setInterval(() => refreshToken(firebaseUser), 10 * 60 * 1000);
    return () => clearInterval(interval);
  }, [firebaseUser, refreshToken]);

  const signInWithGoogle = async () => {
    const auth = getFirebaseAuth();
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
  };

  const signInWithEmail = async (email: string, password: string) => {
    const auth = getFirebaseAuth();
    await signInWithEmailAndPassword(auth, email, password);
  };

  const signUpWithEmail = async (email: string, password: string) => {
    const auth = getFirebaseAuth();
    await createUserWithEmailAndPassword(auth, email, password);
  };

  const logout = async () => {
    const auth = getFirebaseAuth();
    await signOut(auth);
  };

  return (
    <AuthContext.Provider
      value={{ user, loading, token, signInWithGoogle, signInWithEmail, signUpWithEmail, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
