"use client";

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { User } from "@/types";
import { api, ApiError } from "@/lib/api";

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  connectionError: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string, confirm: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const router = useRouter();
  const generation = useRef(0);

  const refreshUser = useCallback(async () => {
    const current = generation.current;
    try {
      const u = await api.getMe();
      if (current !== generation.current) return;
      setUser(u);
      setConnectionError(null);
    } catch (error) {
      if (current !== generation.current) return;
      if (error instanceof ApiError && error.status === 401) {
        setUser(null);
        setConnectionError(null);
      } else {
        const cached = await api.getCachedUser().catch(() => null);
        if (current !== generation.current) return;
        setUser((previous) => previous || cached);
        setConnectionError(error instanceof Error ? error.message : "Unable to connect.");
      }
    } finally {
      if (current === generation.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    const initialGeneration = generation.current;
    const expired = () => { generation.current += 1; setUser(null); setConnectionError(null); setIsLoading(false); };
    const reconnect = () => { void refreshUser(); };
    window.addEventListener("cv_session_expired", expired);
    window.addEventListener("online", reconnect);
    void api.initialize().then(async () => {
      const cached = await api.getCachedUser().catch(() => null);
      if (disposed || initialGeneration !== generation.current) return;
      if (cached) { setUser(cached); setIsLoading(false); }
      await refreshUser();
    }).catch(() => setIsLoading(false));
    return () => {
      disposed = true;
      window.removeEventListener("cv_session_expired", expired);
      window.removeEventListener("online", reconnect);
    };
  }, [refreshUser]);

  const login = async (email: string, password: string) => {
    const current = ++generation.current;
    await api.login({ email, password });
    if (current !== generation.current) return;
    const profile = await api.getMe();
    if (current !== generation.current) return;
    setUser(profile);
    setConnectionError(null);
    router.push("/dashboard");
  };

  const register = async (name: string, email: string, password: string, confirm: string) => {
    await api.register({
      full_name: name,
      email,
      password,
      confirm_password: confirm,
    });
    await login(email, password);
  };

  const logout = async () => {
    generation.current += 1;
    setUser(null);
    setConnectionError(null);
    try {
      await api.logout();
    } finally {
      setUser(null);
      router.replace("/login");
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        connectionError,
        login,
        register,
        logout,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
