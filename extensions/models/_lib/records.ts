// extensions/models/_lib/records.ts
// Pure record-set logic. Namecheap's setHosts replaces every host record on a
// domain, so each change is computed here as a complete new set from the
// current one, and nothing that was not named may change.

/** One host record as Namecheap stores it. */
export type HostRecord = {
  host: string;
  type: string;
  address: string;
  ttl: number;
  mxPref?: number;
};

/** A record to ensure exists. `ttl` defaults to `DEFAULT_TTL`. */
export type RecordInput = {
  host: string;
  type: string;
  address: string;
  ttl?: number;
  mxPref?: number;
};

/** A record to remove. No `address` removes every value of host + type. */
export type RemoveInput = { host: string; type: string; address?: string };

export type Plan = {
  before: HostRecord[];
  after: HostRecord[];
  added: HostRecord[];
  updated: { from: HostRecord; to: HostRecord }[];
  removed: HostRecord[];
  unchanged: HostRecord[];
};

export const DEFAULT_TTL = 1800;

/**
 * Types this model can write back unchanged. A domain holding any other type
 * (CAA, for one, needs Flag/Tag fields this model does not round-trip) is
 * refused rather than risk rewriting it.
 */
export const WRITABLE_TYPES = [
  "A",
  "AAAA",
  "ALIAS",
  "CNAME",
  "MX",
  "MXE",
  "NS",
  "TXT",
  "URL",
  "URL301",
  "FRAME",
] as const;

/** Types that hold one value per host: an upsert replaces the value. */
const SINGLE_VALUED = new Set(["CNAME", "ALIAS", "URL", "URL301", "FRAME"]);

/** Redirect types: Namecheap serves them from its own A record. */
const REDIRECT = new Set(["URL", "URL301", "FRAME"]);

/** Types whose address is a hostname or IP, so compared case-insensitively. */
const NAME_VALUED = new Set(["A", "AAAA", "ALIAS", "CNAME", "MX", "NS"]);

const IPV4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOST =
  /^(@|\*|(\*\.)?[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*)$/;

export function normHost(host: string): string {
  const h = host.trim().toLowerCase();
  return h === "" ? "@" : h;
}

export function normAddress(type: string, address: string): string {
  const a = address.trim();
  return NAME_VALUED.has(type) ? a.toLowerCase().replace(/\.$/, "") : a;
}

function key(r: { host: string; type: string; address: string }): string {
  return `${normHost(r.host)}\u0000${r.type}\u0000${
    normAddress(r.type, r.address)
  }`;
}

function same(a: HostRecord, b: HostRecord): boolean {
  return key(a) === key(b) && a.ttl === b.ttl &&
    (a.mxPref ?? 10) === (b.mxPref ?? 10);
}

/** Validate and normalise one input record; throws naming the record. */
export function toRecord(r: RecordInput): HostRecord {
  const type = r.type.trim().toUpperCase();
  const host = normHost(r.host);
  const what = `${host} ${type} ${JSON.stringify(r.address)}`;
  if (!(WRITABLE_TYPES as readonly string[]).includes(type)) {
    throw new Error(`${what}: type ${type} is not supported`);
  }
  if (!HOST.test(host)) throw new Error(`${what}: invalid host name`);
  const address = r.address.trim();
  if (address === "") throw new Error(`${what}: empty address`);
  if (type === "A" && !IPV4.test(address)) {
    throw new Error(`${what}: not an IPv4 address`);
  }
  if (
    type === "AAAA" &&
    (!address.includes(":") || !/^[0-9a-f:.]+$/i.test(address))
  ) {
    throw new Error(`${what}: not an IPv6 address`);
  }
  const ttl = r.ttl ?? DEFAULT_TTL;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 60000) {
    throw new Error(`${what}: ttl must be an integer from 60 to 60000`);
  }
  const out: HostRecord = { host, type, address, ttl };
  if (type === "MX") out.mxPref = r.mxPref ?? 10;
  return out;
}

/** Refuse a domain holding a record type this model cannot write back. */
export function assertWritable(current: HostRecord[]): void {
  const bad = [...new Set(current.map((r) => r.type))].filter(
    (t) => !(WRITABLE_TYPES as readonly string[]).includes(t),
  );
  if (bad.length) {
    throw new Error(
      `the domain has ${bad.join(", ")} records, which this model cannot ` +
        `write back unchanged; refusing to rewrite the record set`,
    );
  }
}

/**
 * Refuse a set that mixes a CNAME with any other record at the same host, or
 * a redirect with an address record (Namecheap serves the redirect from its
 * own A record, so both would answer).
 */
export function assertConsistent(records: HostRecord[]): void {
  const byHost = new Map<string, Set<string>>();
  for (const r of records) {
    const types = byHost.get(r.host) ?? new Set();
    types.add(r.type);
    byHost.set(r.host, types);
  }
  for (const [host, types] of byHost) {
    if (types.has("CNAME") && types.size > 1) {
      throw new Error(
        `${host}: a CNAME cannot share a host with ${
          [...types].filter((t) => t !== "CNAME").join(", ")
        }; remove one first`,
      );
    }
    const redirects = [...types].filter((t) => REDIRECT.has(t));
    const addresses = [...types].filter((t) =>
      ["A", "AAAA", "ALIAS"].includes(t)
    );
    if (redirects.length && addresses.length) {
      throw new Error(
        `${host}: ${redirects.join(", ")} redirect conflicts with ${
          addresses.join(", ")
        }; remove the redirect first`,
      );
    }
  }
}

function diff(before: HostRecord[], after: HostRecord[]): Plan {
  const left = new Map(before.map((r) => [key(r), r]));
  const added: HostRecord[] = [];
  const updated: Plan["updated"] = [];
  const unchanged: HostRecord[] = [];
  for (const r of after) {
    const old = left.get(key(r));
    if (!old) added.push(r);
    else if (same(old, r)) unchanged.push(r);
    else updated.push({ from: old, to: r });
    left.delete(key(r));
  }
  return {
    before,
    after,
    added,
    updated,
    removed: [...left.values()],
    unchanged,
  };
}

/**
 * Ensure each input record exists. A record matching host + type + address
 * gets the input's ttl/mxPref; a single-valued type (CNAME, ALIAS, redirects)
 * replaces the existing value at that host. Everything else is kept as is.
 */
export function planUpsert(current: HostRecord[], inputs: RecordInput[]): Plan {
  if (!inputs.length) throw new Error("no records given");
  const wanted = inputs.map(toRecord);
  const seen = new Set<string>();
  for (const w of wanted) {
    const k = SINGLE_VALUED.has(w.type) ? `${w.host}\u0000${w.type}` : key(w);
    if (seen.has(k)) throw new Error(`${w.host} ${w.type}: given twice`);
    seen.add(k);
  }
  let after = current.map((r) => ({ ...r }));
  for (const w of wanted) {
    if (SINGLE_VALUED.has(w.type)) {
      after = after.filter((r) => !(r.host === w.host && r.type === w.type));
      after.push(w);
      continue;
    }
    const i = after.findIndex((r) => key(r) === key(w));
    if (i >= 0) after[i] = { ...w, address: after[i].address };
    else after.push(w);
  }
  assertConsistent(after);
  return diff(current, after);
}

/** Remove the named records. Naming one that is already absent is a no-op. */
export function planRemove(current: HostRecord[], inputs: RemoveInput[]): Plan {
  if (!inputs.length) throw new Error("no records given");
  const matches = (r: HostRecord, x: RemoveInput) =>
    r.host === normHost(x.host) && r.type === x.type.trim().toUpperCase() &&
    (x.address === undefined ||
      normAddress(r.type, r.address) === normAddress(r.type, x.address));
  const after = current.filter((r) => !inputs.some((x) => matches(r, x)));
  return diff(current, after);
}

/**
 * Prove a write did exactly what was planned: the records read back must be
 * the planned set, no more, no fewer, with the same ttl and mxPref.
 */
export function verify(planned: HostRecord[], actual: HostRecord[]): string[] {
  const d = diff(planned, actual);
  return [
    ...d.added.map((r) => `unexpected ${describe(r)}`),
    ...d.removed.map((r) => `missing ${describe(r)}`),
    ...d.updated.map((u) =>
      `changed ${describe(u.from)} -> ttl ${u.to.ttl}, mxPref ${
        u.to.mxPref ?? "-"
      }`
    ),
  ];
}

export function describe(r: HostRecord): string {
  return `${r.host} ${r.type} ${JSON.stringify(r.address)} ttl ${r.ttl}` +
    (r.type === "MX" ? ` pref ${r.mxPref ?? 10}` : "");
}
