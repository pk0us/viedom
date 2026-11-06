import type { PublicConfig } from '@viedom/contracts';
export interface AppConfig {
  mode: 'development' | 'test' | 'production';
  ports: {
    web: number;
    api: number;
    mongo: number;
    smtp: number;
    mailUi: number;
    s3: number;
    garageAdmin: number;
  };
  webOrigin: string;
  ssrApiBaseUrl: string;
  mongo: { uri: string; testUri: string; dbName: string; testDbName: string };
  storage: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
    deliveryBaseUrl: string;
  };
  public: PublicConfig;
  mail: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    from: string;
  };
  auth: {
    accessSecret: string;
    accessTtl: number;
    refreshTtl: number;
    cookieName: string;
    secure: boolean;
    googleClientId: string;
    googleClientSecret: string;
    googleCallbackUrl: string;
  };
}
export const root: string;
export const envPath: string;
export function readEnvironment(env?: NodeJS.ProcessEnv, file?: string): Record<string, string>;
export function validateConfig(env: Record<string, string | undefined>): AppConfig;
export function loadConfig(): AppConfig;
