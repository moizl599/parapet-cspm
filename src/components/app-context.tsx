"use client";

/**
 * App-wide client state shared by the header switcher, dashboard, and the
 * environments page: the environment list, the selected environment (persisted
 * in localStorage), and Ollama health.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  getOllamaHealth,
  listEnvironments,
  type EnvironmentDto,
  type HealthResponse,
} from "@/lib/api-client";

const SELECTED_KEY = "cspm:selectedEnvironment";

interface AppState {
  environments: EnvironmentDto[] | null; // null = loading
  envError: string | null;
  selectedId: string | null;
  selected: EnvironmentDto | null;
  selectEnvironment: (id: string) => void;
  refreshEnvironments: () => Promise<EnvironmentDto[]>;
  health: HealthResponse | null;
  healthRetrying: boolean;
  retryHealth: () => Promise<void>;
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [environments, setEnvironments] = useState<EnvironmentDto[] | null>(null);
  const [envError, setEnvError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthRetrying, setHealthRetrying] = useState(false);
  const initialized = useRef(false);

  const refreshEnvironments = useCallback(async () => {
    try {
      const list = await listEnvironments();
      setEnvironments(list);
      setEnvError(null);
      // Keep selection valid: fall back to the first environment.
      setSelectedId((current) => {
        if (current && list.some((e) => e.id === current)) return current;
        return list[0]?.id ?? null;
      });
      return list;
    } catch (err) {
      setEnvError(err instanceof Error ? err.message : "Failed to load environments.");
      setEnvironments([]);
      return [];
    }
  }, []);

  const checkHealth = useCallback(async () => {
    try {
      setHealth(await getOllamaHealth());
    } catch {
      setHealth({
        ok: false,
        status: "unreachable",
        message: "Could not reach the health endpoint.",
        baseUrl: "",
        model: "",
      });
    }
  }, []);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    /* eslint-disable react-hooks/set-state-in-effect */
    const stored =
      typeof window !== "undefined" ? localStorage.getItem(SELECTED_KEY) : null;
    if (stored) setSelectedId(stored);
    /* eslint-enable react-hooks/set-state-in-effect */
    void refreshEnvironments();
    void checkHealth();
  }, [refreshEnvironments, checkHealth]);

  const selectEnvironment = useCallback((id: string) => {
    setSelectedId(id);
    if (typeof window !== "undefined") localStorage.setItem(SELECTED_KEY, id);
  }, []);

  const retryHealth = useCallback(async () => {
    setHealthRetrying(true);
    await checkHealth();
    setHealthRetrying(false);
  }, [checkHealth]);

  const selected = useMemo(
    () => environments?.find((e) => e.id === selectedId) ?? null,
    [environments, selectedId],
  );

  const value = useMemo<AppState>(
    () => ({
      environments,
      envError,
      selectedId,
      selected,
      selectEnvironment,
      refreshEnvironments,
      health,
      healthRetrying,
      retryHealth,
    }),
    [
      environments,
      envError,
      selectedId,
      selected,
      selectEnvironment,
      refreshEnvironments,
      health,
      healthRetrying,
      retryHealth,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within <AppProvider>");
  return ctx;
}
