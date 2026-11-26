export * from "@t3tools/shared/advertisedEndpoint";

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  const basePath = url.pathname.replace(/\/+$/u, "");
  const suffix = pathname.startsWith("/") ? pathname : `/${pathname}`;
  url.pathname = `${basePath}${suffix}`;
  url.search = "";
  url.hash = "";
  return url.toString();
};

export const joinEnvironmentRelativeUrl = (httpBaseUrl: string, relativeUrl: string): string => {
  if (/^https?:\/\//iu.test(relativeUrl)) {
    return new URL(relativeUrl).toString();
  }
  const base = new URL(httpBaseUrl);
  const basePath = base.pathname.replace(/\/+$/u, "");
  if (!basePath) {
    return new URL(relativeUrl, base).toString();
  }
  if (relativeUrl.startsWith("/")) {
    return new URL(`${basePath}${relativeUrl}`, base.origin).toString();
  }
  return new URL(relativeUrl, `${base.origin}${basePath}/`).toString();
};
