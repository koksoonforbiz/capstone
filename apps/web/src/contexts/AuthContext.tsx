import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import { api } from '../lib/api';
import { joinStudentRoom, disconnectSocket } from '../lib/socket';
import { initActivitySession, clearActivitySession } from '../lib/activity-log';
import { clearEpisodeId } from '../lib/learning-episode';
import { mediaStreamRegistry } from '../lib/biometrics/mediaStreamRegistry';
import type { UserRole } from '@ats/shared';

interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

interface AuthResponse {
  accessToken: string;
  user: User;
  sessionId?: string;
}

interface PasswordChangeResponse {
  requirePasswordChange: true;
  passwordChangeToken: string;
  message: string;
}

interface AuthContextValue {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string, role: UserRole) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Synchronous guard so React 18 StrictMode's double-invocation of mount
  // effects can't race a duplicate `/activity-log/session/open` POST. Both
  // invocations would see `sessionStorage` empty before either response
  // lands, so without this we'd create two StudentSession rows for the
  // same login. The dual-session bug then trickles down: the second
  // session's PATCH /session/course writes courseId onto whichever
  // session's open-response won the race, leaving the other naked → the
  // recording-initiate guard rejects with "courseId does not match the
  // session's course" and no video is recorded. (PR-#19 cross-student
  // hotfix is doing its job; the bug is here.)
  const sessionOpenInFlightRef = useRef(false);

  // Load user from token on mount
  useEffect(() => {
    const token = localStorage.getItem('token');
    const savedUser = localStorage.getItem('user');

    if (token && savedUser) {
      try {
        const parsedUser = JSON.parse(savedUser) as User;
        setUser(parsedUser);

        // Join socket room for students and ensure activity session exists
        if (parsedUser.role === 'student') {
          joinStudentRoom(parsedUser.id);

          // If no activity session exists in sessionStorage, open a new one
          if (!sessionStorage.getItem('ats_session_id') && !sessionOpenInFlightRef.current) {
            sessionOpenInFlightRef.current = true;
            api
              .post<{ sessionId: string }>('/activity-log/session/open')
              .then((res) => {
                if (res.sessionId) {
                  initActivitySession(res.sessionId);
                }
              })
              .catch(() => {
                // Non-critical — activity logging will be skipped
              })
              .finally(() => {
                // Don't reset the ref. If we resolved, sessionStorage is
                // populated; if we failed, retrying on another mount
                // invocation would be the same race. The ref persists
                // for the lifetime of this provider, which is fine —
                // logout()/clearActivitySession clears sessionStorage
                // and the next genuine mount (after re-render or HMR)
                // gets a fresh ref.
              });
          }
        }

        // Validate token by fetching current user
        api
          .get<User>('/auth/me')
          .then((freshUser) => {
            setUser(freshUser);
            localStorage.setItem('user', JSON.stringify(freshUser));
          })
          .catch(() => {
            // Token invalid, clear storage
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            setUser(null);
          })
          .finally(() => {
            setIsLoading(false);
          });
      } catch {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        setIsLoading(false);
      }
    } else {
      setIsLoading(false);
    }
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    // Drop any stale learning-episode ID before we know which course this
    // login will land in. The course-entry route's useLearningEpisode hook
    // will mint a fresh one (or attach to a still-valid stored one if the
    // user reloaded straight back into the same course within 30 min).
    clearEpisodeId();

    const response = await api.post<AuthResponse | PasswordChangeResponse>('/auth/login', {
      email,
      password,
    });

    // Check if password change is required
    if ('requirePasswordChange' in response && response.requirePasswordChange) {
      localStorage.setItem('passwordChangeToken', response.passwordChangeToken);
      window.location.href = '/change-password';
      return;
    }

    const authResponse = response as AuthResponse;
    localStorage.setItem('token', authResponse.accessToken);
    localStorage.setItem('user', JSON.stringify(authResponse.user));
    setUser(authResponse.user);

    if (authResponse.user.role === 'student') {
      if (authResponse.sessionId) {
        initActivitySession(authResponse.sessionId);
      }
      joinStudentRoom(authResponse.user.id);
    } else {
      // Clear any stale activity session for non-student roles
      clearActivitySession();
    }
  }, []);

  const register = useCallback(
    async (email: string, password: string, name: string, role: UserRole) => {
      const response = await api.post<AuthResponse>('/auth/register', {
        email,
        password,
        name,
        role,
      });

      localStorage.setItem('token', response.accessToken);
      localStorage.setItem('user', JSON.stringify(response.user));
      setUser(response.user);

      if (response.user.role === 'student') {
        joinStudentRoom(response.user.id);
      }
    },
    [],
  );

  const logout = useCallback(() => {
    // Close activity session on the backend (fire-and-forget)
    const sid = sessionStorage.getItem('ats_session_id');
    const token = localStorage.getItem('token');
    if (sid && token) {
      fetch('/api/activity-log/session/close', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Session-Id': sid,
        },
        keepalive: true,
      }).catch(() => {});
    }
    clearActivitySession();
    clearEpisodeId();

    // Stop all active webcam/media streams before clearing auth
    // NOTE: keep token in localStorage during cleanup so that async
    // handlers (recorder.onstop → uploadSegment → api.patch) can still
    // read it. Remove it after a short delay.
    mediaStreamRegistry.stopAll();
    // Signal biometric hooks (e.g. WebGazer) to clean up
    window.dispatchEvent(new CustomEvent('ats:logout'));

    // Delay token removal so in-flight biometric flushes can still authenticate
    setTimeout(() => {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
    }, 2000);
    disconnectSocket();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, isLoading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
