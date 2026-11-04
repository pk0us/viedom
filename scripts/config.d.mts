import type { PublicConfig } from '@viedom/contracts';
export interface AppConfig {
  mode: 'development' | 'test' | 'production';
  ports: { web: number; api: number; mongo: number };
  webOrigin: string;
  ssrApiBaseUrl: string;
  mongo: { uri: string; testUri: string; dbName: string; testDbName: string };
  public: PublicConfig;
}
export const root: string;
export const envPath: string;
export function readEnvironment(env?: NodeJS.ProcessEnv, file?: string): Record<string, string>;
export function validateConfig(env: Record<string, string | undefined>): AppConfig;
export function loadConfig(): AppConfig;
