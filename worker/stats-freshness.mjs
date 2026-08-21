const MAX_DATE_MILLISECONDS = 8.64e15;
const EPOCH_SECONDS_THRESHOLD = 1e11;

function normalizeEpoch(value) {
  if (!Number.isFinite(value)) return null;

  const milliseconds = Math.abs(value) < EPOCH_SECONDS_THRESHOLD ? value * 1000 : value;
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > MAX_DATE_MILLISECONDS) return null;

  return Math.trunc(milliseconds);
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value instanceof Date) return new Date(value.getTime());
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
  }
  return value;
}

function hasValue(value) {
  return value !== null && value !== undefined;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeEqualRevisionData(current, incoming) {
  if (!isRecord(current) || !isRecord(incoming)) {
    return hasValue(current) ? cloneValue(current) : cloneValue(incoming);
  }

  const merged = cloneValue(current);
  for (const [key, incomingValue] of Object.entries(incoming)) {
    if (!hasValue(incomingValue)) continue;

    const currentValue = merged[key];
    if (!hasValue(currentValue)) {
      merged[key] = cloneValue(incomingValue);
    } else if (isRecord(currentValue) && isRecord(incomingValue)) {
      merged[key] = mergeEqualRevisionData(currentValue, incomingValue);
    }
  }
  return merged;
}

function cloneSnapshot(snapshot) {
  return snapshot && typeof snapshot === "object" ? cloneValue(snapshot) : {};
}

/**
 * Convert a source-owned timestamp to a millisecond epoch.
 *
 * Numeric values below the usual millisecond epoch range are treated as
 * epoch seconds. Invalid or missing values remain unversioned; this function
 * never consults the current clock.
 */
export function normalizeSourceRevision(value) {
  if (value instanceof Date) return normalizeEpoch(value.getTime());
  if (typeof value === "number") return normalizeEpoch(value);
  if (typeof value !== "string") return null;

  const text = value.trim();
  if (!text) return null;

  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text)) {
    return normalizeEpoch(Number(text));
  }

  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : normalizeEpoch(parsed);
}

/**
 * Compare source revisions without using observedAt or any local clock.
 */
export function compareSourceRevision(currentRevision, incomingRevision) {
  const current = normalizeSourceRevision(currentRevision);
  const incoming = normalizeSourceRevision(incomingRevision);

  if (current === null || incoming === null) return "unversioned";
  if (incoming > current) return "newer";
  if (incoming < current) return "older";
  return "equal";
}

/**
 * Apply one source-owned snapshot while keeping source revisions monotonic.
 *
 * The returned object contains the decision and a detached snapshot. A
 * rejected snapshot is a deep-preserved copy of current, so callers cannot
 * accidentally mutate the accepted state through the result.
 */
export function applyMonotonicSourceSnapshot(current, incoming) {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    throw new TypeError("incoming snapshot must be an object");
  }

  const hasCurrent = current !== null && current !== undefined;
  const currentRevision = normalizeSourceRevision(current?.revisionAt);
  const incomingRevision = normalizeSourceRevision(incoming.revisionAt);

  if (!hasCurrent || currentRevision === null) {
    const snapshot = cloneSnapshot(incoming);
    snapshot.revisionAt = incomingRevision;
    return {
      accepted: true,
      action: "applied",
      comparison: "unversioned",
      snapshot,
    };
  }

  if (incomingRevision === null) {
    return {
      accepted: false,
      action: "rejected",
      comparison: "unversioned",
      snapshot: cloneSnapshot(current),
    };
  }

  const comparison = compareSourceRevision(currentRevision, incomingRevision);
  if (comparison === "older") {
    return {
      accepted: false,
      action: "rejected",
      comparison,
      snapshot: cloneSnapshot(current),
    };
  }

  if (comparison === "newer") {
    const snapshot = cloneSnapshot(incoming);
    snapshot.revisionAt = incomingRevision;
    return {
      accepted: true,
      action: "applied",
      comparison,
      snapshot,
    };
  }

  const snapshot = cloneSnapshot(current);
  snapshot.data = mergeEqualRevisionData(current.data, incoming.data);
  if (hasValue(incoming.observedAt)) snapshot.observedAt = cloneValue(incoming.observedAt);

  return {
    accepted: true,
    action: "merged",
    comparison: "equal",
    snapshot,
  };
}
