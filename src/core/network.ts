/** Browser-free contracts for M3 network/environment capabilities. */
export interface RouteRule {
  url: string;
  method?: string;
  action: 'fulfill' | 'abort' | 'continue' | 'modify' | 'redirect';
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  redirectUrl?: string;
  delayMs?: number;
}
export interface RouteOptions { action: 'add' | 'clear'; rules: RouteRule[]; backend: 'auto' | 'cdp' | 'dnr' }
export interface RouteResult { rules: number; backend: 'cdp' | 'dnr' }
export interface ConsoleEntry { level: string; text: string; timestamp: number; url?: string }
export interface HarLog { log: { version: string; creator: { name: string; version: string }; entries: Record<string, unknown>[] } }
export interface HarResult { recording: boolean; har?: HarLog; truncated?: boolean }
export interface EmulateOptions {
  device: '' | 'iphone' | 'pixel' | 'ipad' | 'desktop';
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  userAgent?: string;
  locale?: string;
  timezone?: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  colorScheme?: '' | 'light' | 'dark';
  reducedMotion?: '' | 'reduce' | 'no-preference';
  offline?: boolean;
  action: 'set' | 'clear';
}
export interface ClearSiteDataOptions { origins: string[] }
