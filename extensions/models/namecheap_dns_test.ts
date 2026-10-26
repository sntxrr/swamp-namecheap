// extensions/models/namecheap_dns_test.ts
// Assertions read loosely typed JSON written by the methods under test.
// deno-lint-ignore-file no-explicit-any
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261024.62";
import { model } from "./namecheap_dns.ts";
import type { HostRecord } from "./_lib/records.ts";

type Ctx = Parameters<typeof model.methods.getHosts.execute>[1];

const SECRET = "k3y-never-shown";
const GLOBAL = {
  domain: "example.club",
  apiUser: "me",
  apiKey: SECRET,
  clientIp: "203.0.113.7",
  sandbox: false,
};

function ctx(globalArgs: Record<string, unknown> = GLOBAL) {
  const c = createModelTestContext({ globalArgs });
  return { ...c, context: c.context as unknown as Ctx };
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** A fake Namecheap that, like the real one, replaces the set on setHosts. */
function namecheap(
  initial: HostRecord[],
  opt: {
    emailType?: string;
    ourDns?: boolean;
    mangle?: (r: HostRecord[]) => HostRecord[];
    error?: string;
  } = {},
) {
  let records = initial.map((r) => ({ ...r }));
  const calls: { command: string; params: URLSearchParams; url: string }[] = [];
  const handle = (input: RequestInfo | URL, init?: RequestInit): Response => {
    const url = String(input);
    const params = new URLSearchParams(String(init?.body ?? ""));
    const command = params.get("Command") ?? "";
    calls.push({ command, params, url });
    assertEquals(init?.method, "POST");
    assert(!url.includes(SECRET), "the key must never be in the URL");
    const ok = (inner: string) =>
      new Response(
        `<?xml version="1.0" encoding="utf-8"?><ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response"><Errors /><CommandResponse Type="${command}">${inner}</CommandResponse></ApiResponse>`,
      );
    if (opt.error) {
      return new Response(
        `<?xml version="1.0"?><ApiResponse Status="ERROR"><Errors><Error Number="${opt.error}">Invalid request IP: 203.0.113.7</Error></Errors></ApiResponse>`,
      );
    }
    if (command === "namecheap.domains.dns.getHosts") {
      const hosts = records.map((r, i) =>
        `<host HostId="${i + 1}" Name="${
          esc(r.host)
        }" Type="${r.type}" Address="${esc(r.address)}" MXPref="${
          r.mxPref ?? 10
        }" TTL="${r.ttl}" IsActive="true" />`
      ).join("");
      return ok(
        `<DomainDNSGetHostsResult Domain="${params.get("SLD")}.${
          params.get("TLD")
        }" EmailType="${opt.emailType ?? "FWD"}" IsUsingOurDNS="${
          opt.ourDns ?? true
        }">${hosts}</DomainDNSGetHostsResult>`,
      );
    }
    if (command === "namecheap.domains.dns.setHosts") {
      const next: HostRecord[] = [];
      for (let n = 1; params.has(`HostName${n}`); n++) {
        const r: HostRecord = {
          host: params.get(`HostName${n}`)!,
          type: params.get(`RecordType${n}`)!,
          address: params.get(`Address${n}`)!,
          ttl: Number(params.get(`TTL${n}`)),
        };
        if (params.has(`MXPref${n}`)) {
          r.mxPref = Number(params.get(`MXPref${n}`));
        }
        next.push(r);
      }
      records = opt.mangle ? opt.mangle(next) : next;
      return ok(`<DomainDNSSetHostsResult Domain="x" IsSuccess="true" />`);
    }
    return new Response("nope", { status: 500 });
  };
  const f: typeof fetch = (input, init) => Promise.resolve(handle(input, init));
  return { f, calls, records: () => records };
}

const PARKED: HostRecord[] = [
  {
    host: "www",
    type: "CNAME",
    address: "parkingpage.namecheap.com.",
    ttl: 1800,
  },
  { host: "@", type: "URL", address: "http://www.example.club/", ttl: 1800 },
];
const TXT = {
  host: "_github-pages-challenge-me",
  type: "TXT" as const,
  address: 'a&b"c',
};

Deno.test("getHosts reads records, email type and DNS mode", async () => {
  const nc = namecheap(PARKED);
  const { context, getWrittenResources } = ctx();
  await model.methods.getHosts.execute({ _fetch: nc.f }, context);
  const h = getWrittenResources()[0].data as any;
  assertEquals(h.records.length, 2);
  assertEquals(h.emailType, "FWD");
  assertEquals(h.usingNamecheapDns, true);
  const p = nc.calls[0].params;
  assertEquals([p.get("SLD"), p.get("TLD"), p.get("ClientIp")], [
    "example",
    "club",
    "203.0.113.7",
  ]);
});

Deno.test("upsert defaults to a dry run and writes nothing", async () => {
  const nc = namecheap(PARKED);
  const { context, getWrittenResources } = ctx();
  await model.methods.upsertRecords.execute(
    { records: [TXT], dryRun: true, _fetch: nc.f },
    context,
  );
  assertEquals(nc.calls.map((c) => c.command), [
    "namecheap.domains.dns.getHosts",
  ]);
  const ch = getWrittenResources()[0].data as any;
  assertEquals([ch.dryRun, ch.written, ch.added.length], [true, false, 1]);
});

Deno.test("upsert applies, keeps the rest, preserves email type, and verifies", async () => {
  const nc = namecheap(PARKED, { emailType: "FWD" });
  const { context, getWrittenResources } = ctx();
  await model.methods.upsertRecords.execute(
    { records: [TXT], dryRun: false, _fetch: nc.f },
    context,
  );
  assertEquals(nc.records().length, 3);
  assertEquals(nc.records().find((r) => r.type === "TXT")?.address, 'a&b"c');
  const set = nc.calls.find((c) => c.command.endsWith("setHosts"))!;
  assertEquals(set.params.get("EmailType"), "FWD");
  const change = getWrittenResources().find((w) => w.specName === "change")!
    .data as any;
  assertEquals([change.written, change.verified], [true, true]);
});

Deno.test("a read-back that differs fails loudly and is recorded", async () => {
  const nc = namecheap(PARKED, { mangle: (r) => r.slice(1) });
  const { context, getWrittenResources } = ctx();
  await assertRejects(
    () =>
      model.methods.upsertRecords.execute(
        { records: [TXT], dryRun: false, _fetch: nc.f },
        context,
      ),
    Error,
    "differ from the plan",
  );
  const change = getWrittenResources().find((w) => w.specName === "change")!
    .data as any;
  assertEquals([change.written, change.verified], [true, false]);
  assert(change.problems.length > 0);
});

Deno.test("removeRecords then upsert takes a parked domain to GitHub Pages", async () => {
  const nc = namecheap(PARKED);
  const run = async (m: "removeRecords" | "upsertRecords", records: any[]) =>
    await (model.methods[m].execute as any)(
      { records, dryRun: false, _fetch: nc.f },
      ctx().context,
    );
  await run("removeRecords", [{ host: "@", type: "URL" }]);
  await run("upsertRecords", [
    ...["108", "109", "110", "111"].map((n) => ({
      host: "@",
      type: "A",
      address: `185.199.${n}.153`,
    })),
    { host: "www", type: "CNAME", address: "me.github.io." },
  ]);
  const r = nc.records();
  assertEquals(r.filter((x) => x.type === "A").length, 4);
  assertEquals(r.filter((x) => x.type === "CNAME").map((x) => x.address), [
    "me.github.io.",
  ]);
  assertEquals(r.filter((x) => x.type === "URL").length, 0);
});

Deno.test("writes are refused when the domain does not use Namecheap DNS", async () => {
  const nc = namecheap(PARKED, { ourDns: false });
  await assertRejects(
    () =>
      model.methods.upsertRecords.execute(
        { records: [TXT], dryRun: true, _fetch: nc.f },
        ctx().context,
      ),
    Error,
    "does not use Namecheap DNS",
  );
});

Deno.test("a domain holding CAA records is never rewritten", async () => {
  const nc = namecheap([...PARKED, {
    host: "@",
    type: "CAA",
    address: '0 issue "x"',
    ttl: 1800,
  }]);
  await assertRejects(
    () =>
      model.methods.upsertRecords.execute(
        { records: [TXT], dryRun: false, _fetch: nc.f },
        ctx().context,
      ),
    Error,
    "CAA",
  );
  assert(!nc.calls.some((c) => c.command.endsWith("setHosts")));
});

Deno.test("Namecheap errors surface with a hint, and never the key", async () => {
  const nc = namecheap(PARKED, { error: "1011150" });
  const err = await assertRejects(
    () => model.methods.getHosts.execute({ _fetch: nc.f }, ctx().context),
    Error,
  );
  assertStringIncludes(err.message, "1011150");
  assertStringIncludes(err.message, "whitelist");
  assert(!err.message.includes(SECRET));
});

Deno.test("a network failure names the URL only", async () => {
  const f: typeof fetch = () => Promise.reject(new TypeError(`boom ${SECRET}`));
  const err = await assertRejects(
    () => model.methods.getHosts.execute({ _fetch: f }, ctx().context),
    Error,
  );
  assert(!err.message.includes(SECRET));
});

Deno.test("clientIp must be IPv4; sandbox switches the endpoint", async () => {
  await assertRejects(
    () =>
      model.methods.getHosts.execute(
        {},
        ctx({ ...GLOBAL, clientIp: "2001:db8::1" }).context,
      ),
    Error,
    "IPv4",
  );
  const nc = namecheap(PARKED);
  await model.methods.getHosts.execute(
    { _fetch: nc.f },
    ctx({ ...GLOBAL, sandbox: true }).context,
  );
  assertStringIncludes(nc.calls[0].url, "api.sandbox.namecheap.com");
});
