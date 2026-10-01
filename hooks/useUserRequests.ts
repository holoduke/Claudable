import { useState, useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

interface UseUserRequestsOptions {
  projectId: string;
}

interface ActiveRequestsResponse {
  hasActiveRequests: boolean;
  activeCount: number;
}

type ActiveRequestsResult =
  | { kind: 'missing' } // endpoint unavailable (404)
  | { kind: 'ok'; data: ActiveRequestsResponse };

/** Query active request status from DB. null = no-op (other status / network error). */
async function fetchActiveRequests(projectId: string): Promise<ActiveRequestsResult | null> {
  try {
    const apiBase = process.env.NEXT_PUBLIC_API_BASE ?? '';
    const response = await fetch(`${apiBase}/api/chat/${projectId}/requests/active`, {
      cache: 'no-store',
    });
    if (response.status === 404) return { kind: 'missing' };
    // Treat other statuses as no-op without logging noisy errors
    if (!response.ok) return null;
    const data: ActiveRequestsResponse = await response.json();
    return { kind: 'ok', data };
  } catch (error) {
    // KEEP the previous busy state on a transient fetch error. Clearing it on
    // one blip flipped busy→idle mid-turn, which fired the queued-message
    // flusher and let sends bypass the queue → a concurrent second turn (or a
    // 409). The next successful poll corrects the state either way.
    if (process.env.NODE_ENV === 'development') {
      console.warn('[UserRequests] Failed to check active requests (network issue):', error);
    }
    return null;
  }
}

// Tab visibility as an external store. Server snapshot = visible (the old default).
function subscribeVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}
const getTabVisible = () => !document.hidden;
const getServerTabVisible = () => true;

export function useUserRequests({ projectId }: UseUserRequestsOptions) {
  const [hasActiveRequests, setHasActiveRequests] = useState(false);
  const [activeCount, setActiveCount] = useState(0);
  const isTabVisible = useSyncExternalStore(subscribeVisibility, getTabVisible, getServerTabVisible);

  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const previousActiveState = useRef(false);
  const activeRequestIdsRef = useRef<Set<string>>(new Set());

  const setFromActiveSet = useCallback(() => {
    const size = activeRequestIdsRef.current.size;
    setActiveCount(size);
    setHasActiveRequests(size > 0);
  }, []);

  const registerActiveRequest = useCallback((requestId: string | null | undefined) => {
    if (!requestId) return;
    const set = activeRequestIdsRef.current;
    const before = set.size;
    set.add(requestId);
    if (set.size !== before) {
      setFromActiveSet();
    }
  }, [setFromActiveSet]);

  const unregisterActiveRequest = useCallback((requestId: string | null | undefined) => {
    if (!requestId) return;
    const set = activeRequestIdsRef.current;
    if (set.delete(requestId)) {
      setFromActiveSet();
    }
  }, [setFromActiveSet]);

  // Apply a polled active-requests result to state
  const applyActiveRequestsResult = useCallback((result: ActiveRequestsResult | null) => {
    if (!result) return;

    if (result.kind === 'missing') {
      if (previousActiveState.current) {
        console.log('🔄 [UserRequests] Active requests endpoint unavailable; assuming no active requests.');
      }
      if (activeRequestIdsRef.current.size > 0) {
        activeRequestIdsRef.current.clear();
      }
      setHasActiveRequests(false);
      setActiveCount(0);
      previousActiveState.current = false;
      return;
    }

    const { data } = result;
    if (!data.hasActiveRequests && activeRequestIdsRef.current.size > 0) {
      activeRequestIdsRef.current.clear();
    }
    setHasActiveRequests(data.hasActiveRequests);
    setActiveCount(data.activeCount);

    // Log only when active state changes
    if (data.hasActiveRequests !== previousActiveState.current) {
      console.log(`🔄 [UserRequests] Active requests: ${data.hasActiveRequests} (count: ${data.activeCount})`);
      previousActiveState.current = data.hasActiveRequests;
    }
  }, []);

  // Query active request status from DB
  // (Promise chain rather than async/await so state is only set in a callback.)
  const checkActiveRequests = useCallback((options?: { force?: boolean }): Promise<void> => {
    if (!options?.force && !isTabVisible) return Promise.resolve(); // Stop polling if tab is inactive unless forced

    return fetchActiveRequests(projectId).then(applyActiveRequestsResult);
  }, [projectId, isTabVisible, applyActiveRequestsResult]);

  // Adaptive polling configuration
  useEffect(() => {
    // Stop polling if tab is inactive
    if (!isTabVisible) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    // Determine polling interval based on active request status. 500ms was far
    // too aggressive (120 req/min per tab); 2s is responsive enough while
    // cutting request volume ~4x. SSE carries the live message updates.
    const pollInterval = hasActiveRequests ? 2000 : 8000; // 2s active vs 8s idle

    // Clean up existing polling
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }

    // Check immediately once
    checkActiveRequests();

    // Start new polling
    intervalRef.current = setInterval(() => checkActiveRequests(), pollInterval);

    if (process.env.NODE_ENV === 'development') {
      console.log(`⏱️ [UserRequests] Polling interval: ${pollInterval}ms (active: ${hasActiveRequests})`);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [hasActiveRequests, isTabVisible, checkActiveRequests]);

  // Clean up on component unmount
  useEffect(() => {
    // The Set is mutated in place, never replaced, so capturing it is equivalent.
    const activeRequestIds = activeRequestIdsRef.current;
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
      activeRequestIds.clear();
    };
  }, []);

  // Placeholder functions for WebSocket events (maintaining existing interface)
  const createRequest = useCallback((
    requestId: string,
    messageId: string,
    instruction: string,
    type: 'act' | 'chat' = 'act'
  ) => {
    registerActiveRequest(requestId);
    // Check status immediately via polling
    checkActiveRequests({ force: true });
    console.log(`🔄 [UserRequests] Created request: ${requestId}`);
  }, [checkActiveRequests, registerActiveRequest]);

  const startRequest = useCallback((requestId: string) => {
    registerActiveRequest(requestId);
    // Check status immediately via polling
    checkActiveRequests({ force: true });
    console.log(`▶️ [UserRequests] Started request: ${requestId}`);
  }, [checkActiveRequests, registerActiveRequest]);

  const completeRequest = useCallback((
    requestId: string,
    isSuccessful: boolean,
    errorMessage?: string
  ) => {
    unregisterActiveRequest(requestId);
    // Check status immediately via polling with slight delay
    setTimeout(() => checkActiveRequests({ force: true }), 100);
    console.log(`✅ [UserRequests] Completed request: ${requestId} (${isSuccessful ? 'success' : 'failed'})`);
  }, [checkActiveRequests, unregisterActiveRequest]);

  return {
    hasActiveRequests,
    activeCount,
    createRequest,
    startRequest,
    completeRequest,
    // Legacy interface compatibility
    requests: [],
    activeRequests: [],
    getRequest: () => undefined,
    clearCompletedRequests: () => {}
  };
}
