// extensions/models/_lib/namecheap.ts
// Namecheap XML API client for the two DNS host calls. Every request is a
// POST with a form body, so the API key never appears in a URL, and no error
// message ever includes the request.

import { XMLParser } from "npm:fast-xml-parser@5.11.2";
import type { HostRecord } from "./records.ts";

export const PRODUCTION_URL = "https://api.namecheap.com/xml.response";
export const SANDBOX_URL = "https://api.sandbox.namecheap.com/xml.response";

export type Credentials = {
  apiUser: string;
  apiKey: string;
  userName: string;
  clientIp: string;
};

export type Hosts = {
  domain: string;
  emailType: string;
  usingNamecheapDns: boolean;
  records: HostRecord[];
};

/** Namecheap's own error, with its number (1011150 = IP not whitelisted). */
export class NamecheapError extends Error {
  constructor(readonly errors: { number: string; message: string }[]) {
    super(
      errors.map((e) => `Namecheap error ${e.number}: ${e.message}`).join(
        "; ",
      ) +
        (errors.some((e) => e.number === "1011150")
          ? " (add this host's public IPv4 to the API whitelist)"
          : ""),
    );
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  parseTagValue: false,
  isArray: (name) => ["host", "Host", "Error"].includes(name),
});

/** Split a registered domain into Namecheap's SLD and TLD (`a.co.uk` → a, co.uk). */
export function splitDomain(domain: string): { sld: string; tld: string } {
  const d = domain.trim().toLowerCase().replace(/\.$/, "");
  const i = d.indexOf(".");
  if (i <= 0 || i === d.length - 1 || !/^[a-z0-9.-]+$/.test(d)) {
    throw new Error(`not a registered domain name: ${JSON.stringify(domain)}`);
  }
  return { sld: d.slice(0, i), tld: d.slice(i + 1) };
}

// deno-lint-ignore no-explicit-any
type Xml = any;

/** Parse a response and throw on Status="ERROR"; returns CommandResponse. */
export function parseResponse(xml: string): Xml {
  let doc: Xml;
  try {
    doc = parser.parse(xml);
  } catch {
    throw new Error("Namecheap returned a response that is not XML");
  }
  const r = doc?.ApiResponse;
  if (!r) throw new Error("Namecheap response has no ApiResponse element");
  if (r.Status !== "OK") {
    const errs = (r.Errors?.Error ?? []).map((e: Xml) => ({
      number: String(e?.Number ?? "?"),
      message: String(e?.["#text"] ?? e ?? "").trim(),
    }));
    throw new NamecheapError(
      errs.length ? errs : [{ number: "?", message: `status ${r.Status}` }],
    );
  }
  return r.CommandResponse ?? {};
}

export function parseHosts(xml: string): Hosts {
  const res = parseResponse(xml).DomainDNSGetHostsResult;
  if (!res) throw new Error("getHosts response has no DomainDNSGetHostsResult");
  const raw: Xml[] = [...(res.host ?? []), ...(res.Host ?? [])];
  const records = raw.map((h) => {
    const type = String(h.Type ?? "").toUpperCase();
    const rec: HostRecord = {
      host: String(h.Name ?? "@").toLowerCase() || "@",
      type,
      address: String(h.Address ?? ""),
      ttl: Number(h.TTL ?? 1800),
    };
    if (type === "MX") rec.mxPref = Number(h.MXPref ?? 10);
    return rec;
  });
  return {
    domain: String(res.Domain ?? ""),
    emailType: String(res.EmailType ?? ""),
    usingNamecheapDns: String(res.IsUsingOurDNS).toLowerCase() === "true",
    records,
  };
}

export class NamecheapClient {
  constructor(
    private readonly creds: Credentials,
    private readonly url: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  private async call(
    command: string,
    params: Record<string, string>,
  ): Promise<string> {
    const body = new URLSearchParams({
      ApiUser: this.creds.apiUser,
      ApiKey: this.creds.apiKey,
      UserName: this.creds.userName,
      ClientIp: this.creds.clientIp,
      Command: command,
      ...params,
    });
    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      // The error names the URL only; the body (with the key) is never shown.
      throw new Error(
        `${command}: request to ${this.url} failed: ${(e as Error).name}`,
      );
    }
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${command}: HTTP ${res.status} from ${this.url}`);
    }
    return text;
  }

  async getHosts(domain: string): Promise<Hosts> {
    const { sld, tld } = splitDomain(domain);
    return parseHosts(
      await this.call("namecheap.domains.dns.getHosts", { SLD: sld, TLD: tld }),
    );
  }

  /** Replace the whole record set. `emailType` must be the value read back. */
  async setHosts(
    domain: string,
    records: HostRecord[],
    emailType: string,
  ): Promise<void> {
    const { sld, tld } = splitDomain(domain);
    const params: Record<string, string> = { SLD: sld, TLD: tld };
    if (emailType) params.EmailType = emailType;
    records.forEach((r, i) => {
      const n = i + 1;
      params[`HostName${n}`] = r.host;
      params[`RecordType${n}`] = r.type;
      params[`Address${n}`] = r.address;
      params[`TTL${n}`] = String(r.ttl);
      if (r.type === "MX") params[`MXPref${n}`] = String(r.mxPref ?? 10);
    });
    const res = parseResponse(
      await this.call("namecheap.domains.dns.setHosts", params),
    ).DomainDNSSetHostsResult;
    if (String(res?.IsSuccess).toLowerCase() !== "true") {
      throw new Error("setHosts did not report IsSuccess=true");
    }
  }
}
