export const SITE_ORIGIN = "https://kabugenron.com";
export const SITE_HOST = "kabugenron.com";

export const LEGACY_ORIGIN = "https://stock-analysis-self.vercel.app";
export const LEGACY_HOST = "stock-analysis-self.vercel.app";

export const DOMAIN_MIGRATION_PATH = "/domain-migration";

export function siteUrl(path = "/"): string {
  return new URL(path, SITE_ORIGIN).toString();
}
