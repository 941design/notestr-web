function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export function normalizeBasePath(value: string | undefined) {
  const trimmed = value?.trim() ?? "";

  if (!trimmed || trimmed === "/") {
    return "";
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return trimTrailingSlash(withLeadingSlash);
}

export function getBasePath() {
  return normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH);
}

