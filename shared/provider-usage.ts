export interface ProviderUsage {
  provider: string;
  label: string;
  isDefault: boolean;
  available: boolean;
  plan: string | null;
  windows: Array<{ label: string; remainingPercent: number | null; resetAt: number | null; detail: string | null }>;
  details: string[];
  unavailableReason: string | null;
  dashboardUrl: string | null;
  fetchedAt: number;
}
export interface ProviderUsageResponse { providers: ProviderUsage[] }
