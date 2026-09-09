export interface HermesProvider {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  models: string[];
  hasKey: boolean;
  revision: string;
  connected: boolean;
  testedAt: number | null;
  isDefault: boolean;
  editable: boolean;
}
export interface ProviderSetupRequest {
  action: 'list' | 'discover' | 'save' | 'remove';
  id?: string;
  revision?: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  models?: string[];
}
export type ProviderSetupResponse = { providers: HermesProvider[] } | { models: string[] };
