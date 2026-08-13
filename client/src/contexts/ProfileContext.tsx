import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import {
  Link,
  Navigate as RouterNavigate,
  useLocation,
  useNavigate,
  type NavigateFunction,
  type NavigateOptions,
  type To,
} from 'react-router';
import { DEFAULT_PROFILE_NAME, type HermesProfile } from '@shared/types';
import { fetchHermesProfiles } from '../lib/api';
import {
  profileIdFromSearch,
  searchWithProfile,
  toWithProfile,
} from '../lib/profileQuery';

interface ProfileContextValue {
  profiles: HermesProfile[];
  activeProfile: HermesProfile | null;
  activeProfileId: string;
  isLoading: boolean;
  error: string | null;
  setActiveProfileId: (profileId: string) => void;
  refreshProfiles: () => Promise<void>;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

export function ProfileProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [profiles, setProfiles] = useState<HermesProfile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestedProfileId = profileIdFromSearch(location.search);
  const fallbackProfileId = profiles.find((profile) => profile.isDefault)?.id ?? DEFAULT_PROFILE_NAME;
  const activeProfileId = requestedProfileId ?? fallbackProfileId;
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? null;

  const refreshProfiles = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await fetchHermesProfiles();
      setProfiles(result.profiles);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load Hermes profiles.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshProfiles();
  }, [refreshProfiles]);

  useEffect(() => {
    if (isLoading) return;
    const validProfileId = profiles.some((profile) => profile.id === requestedProfileId)
      ? requestedProfileId!
      : fallbackProfileId;
    if (requestedProfileId === validProfileId) return;
    navigate({
      pathname: location.pathname,
      search: searchWithProfile(location.search, validProfileId),
      hash: location.hash,
    }, { replace: true });
  }, [fallbackProfileId, isLoading, location.hash, location.pathname, location.search, navigate, profiles, requestedProfileId]);

  const setActiveProfileId = useCallback((profileId: string) => {
    if (!profiles.some((profile) => profile.id === profileId)) return;

    // Task IDs (and their messages) are profile-scoped. Retaining a task-detail
    // URL after a profile switch asks the new profile for an ID it cannot own and
    // leaves the board looking empty until the user navigates manually.
    const isTaskDetail = /^\/tasks\/[^/]+$/.test(location.pathname)
      || /^\/projects\/[^/]+\/tasks\/[^/]+$/.test(location.pathname);
    navigate({
      pathname: isTaskDetail ? '/' : location.pathname,
      search: searchWithProfile(location.search, profileId),
      hash: location.hash,
    });
  }, [location.hash, location.pathname, location.search, navigate, profiles]);

  const value = useMemo<ProfileContextValue>(() => ({
    profiles,
    activeProfile,
    activeProfileId,
    isLoading,
    error,
    setActiveProfileId,
    refreshProfiles,
  }), [activeProfile, activeProfileId, error, isLoading, profiles, refreshProfiles, setActiveProfileId]);

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfile(): ProfileContextValue {
  const value = useContext(ProfileContext);
  if (!value) throw new Error('useProfile must be used within ProfileProvider');
  return value;
}

export function useProfileNavigate(): NavigateFunction {
  const navigate = useNavigate();
  const { activeProfileId } = useProfile();
  return useCallback(((to: To | number, options?: NavigateOptions) => {
    if (typeof to === 'number') return navigate(to);
    return navigate(toWithProfile(to, activeProfileId), options);
  }) as NavigateFunction, [activeProfileId, navigate]);
}

export function ProfileLink({ to, ...props }: ComponentProps<typeof Link>) {
  const { activeProfileId } = useProfile();
  return <Link {...props} to={toWithProfile(to, activeProfileId)} />;
}

export function ProfileNavigate({ to, ...props }: ComponentProps<typeof RouterNavigate>) {
  const { activeProfileId } = useProfile();
  return <RouterNavigate {...props} to={toWithProfile(to, activeProfileId)} />;
}
