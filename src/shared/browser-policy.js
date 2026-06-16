export function normalizeNavigationUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Navigation needs a URL.");
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value.trim())
    ? value.trim()
    : `https://${value.trim()}`;
  const url = new URL(withScheme);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS navigation is allowed.");
  }

  return url.href;
}

export function normalizeMaxSteps(value, fallback, minimum = 1, maximum = 12) {
  const parsed = Number(value);
  const candidate = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(candidate)));
}
