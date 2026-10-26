// extensions/models/namecheap_dns.ts
// Read and safely edit the DNS host records of one Namecheap domain.
//
// Namecheap's setHosts call replaces every record on the domain with exactly
// the set it is sent. So each change here reads the current set, merges only
// the records it was given, writes the complete set, and reads it back to
// prove nothing else moved. Writes are dry runs unless `dryRun: false`.

import { z } from "npm:zod@4";
import {
  type Hosts,
  NamecheapClient,
  PRODUCTION_URL,
  SANDBOX_URL,
} from "./_lib/namecheap.ts";
import {
  assertWritable,
  describe,
  type Plan,
  planRemove,
  planUpsert,
  verify,
  WRITABLE_TYPES,
} from "./_lib/records.ts";

const GlobalArgsSchema = z.object({
  domain: z.string().describe(
    "The registered domain, e.g. example.com (not a subdomain)",
  ),
  apiUser: z.string().describe("Namecheap API user (your account user name)"),
  apiKey: z.string().meta({ sensitive: true }).describe(
    "Namecheap API key: Profile → Tools → Namecheap API Access",
  ),
  userName: z.string().optional().describe(
    "Account the command acts on; defaults to apiUser",
  ),
  clientIp: z.string().describe(
    "Public IPv4 address the calls come from; it must be on the API whitelist",
  ),
  sandbox: z.boolean().default(false).describe(
    "Use api.sandbox.namecheap.com (a separate sandbox account)",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const RecordSchema = z.object({
  host: z.string(),
  type: z.string(),
  address: z.string(),
  ttl: z.number(),
  mxPref: z.number().optional(),
});

const HostsSchema = z.object({
  domain: z.string(),
  emailType: z.string(),
  usingNamecheapDns: z.boolean(),
  records: z.array(RecordSchema),
  readAt: z.string(),
});

const ChangeSchema = z.object({
  domain: z.string(),
  method: z.string(),
  dryRun: z.boolean(),
  written: z.boolean(),
  verified: z.boolean(),
  problems: z.array(z.string()),
  added: z.array(RecordSchema),
  updated: z.array(z.object({ from: RecordSchema, to: RecordSchema })),
  removed: z.array(RecordSchema),
  unchangedCount: z.number(),
  before: z.array(RecordSchema),
  after: z.array(RecordSchema),
  at: z.string(),
});

const UpsertInput = z.object({
  host: z.string().describe("@ for the apex, or a name such as www"),
  type: z.enum(WRITABLE_TYPES),
  address: z.string(),
  ttl: z.number().int().optional().describe("seconds, 60-60000; default 1800"),
  mxPref: z.number().int().optional().describe("MX only; default 10"),
});

const RemoveInput = z.object({
  host: z.string(),
  type: z.string(),
  address: z.string().optional().describe(
    "omit to remove every value of this host + type",
  ),
});

type Logger = {
  info: (message: string, props?: Record<string, unknown>) => void;
  warn: (message: string, props?: Record<string, unknown>) => void;
};

type Ctx = {
  globalArgs: GlobalArgs;
  logger: Logger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

/** Test seam: inject fetch instead of reaching the network. */
type Seams = { _fetch?: typeof fetch };

function client(g: GlobalArgs, f?: typeof fetch): NamecheapClient {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(g.clientIp.trim())) {
    throw new Error(
      "clientIp must be an IPv4 address (Namecheap whitelists IPv4 only)",
    );
  }
  return new NamecheapClient(
    {
      apiUser: g.apiUser,
      apiKey: g.apiKey,
      userName: g.userName || g.apiUser,
      clientIp: g.clientIp.trim(),
    },
    g.sandbox ? SANDBOX_URL : PRODUCTION_URL,
    f,
  );
}

async function storeHosts(ctx: Ctx, h: Hosts) {
  return await ctx.writeResource("hosts", "hosts", {
    ...h,
    readAt: new Date().toISOString(),
  });
}

/** Check a planned set can be written, before anything is sent. */
function preflight(current: Hosts, plan: Plan): void {
  if (!current.usingNamecheapDns) {
    throw new Error(
      `${current.domain} does not use Namecheap DNS, so its host records ` +
        `have no effect; change them where its name servers are hosted`,
    );
  }
  assertWritable(current.records);
  if (!plan.after.length) {
    throw new Error("refusing to leave the domain with no host records");
  }
  if (plan.after.some((r) => r.type === "MX") && current.emailType !== "MX") {
    throw new Error(
      `MX records only take effect with Mail Settings "Custom MX" (email ` +
        `type is ${
          current.emailType || "unset"
        }); change it in the dashboard first`,
    );
  }
}

async function apply(
  ctx: Ctx,
  method: string,
  dryRun: boolean,
  nc: NamecheapClient,
  current: Hosts,
  plan: Plan,
) {
  const g = ctx.globalArgs;
  const changes = plan.added.length + plan.updated.length + plan.removed.length;
  const summary = {
    domain: g.domain,
    method,
    dryRun,
    added: plan.added,
    updated: plan.updated,
    removed: plan.removed,
    unchangedCount: plan.unchanged.length,
    before: plan.before,
    after: plan.after,
  };
  for (const r of plan.added) ctx.logger.info(`+ ${describe(r)}`);
  for (const u of plan.updated) {
    ctx.logger.info(`~ ${describe(u.from)} -> ${describe(u.to)}`);
  }
  for (const r of plan.removed) ctx.logger.info(`- ${describe(r)}`);

  const record = async (
    written: boolean,
    verified: boolean,
    problems: string[],
  ) =>
    await ctx.writeResource("change", "change", {
      ...summary,
      written,
      verified,
      problems,
      at: new Date().toISOString(),
    });

  if (changes === 0) {
    ctx.logger.info("nothing to change");
    return { dataHandles: [await record(false, true, [])] };
  }
  preflight(current, plan);
  if (dryRun) {
    ctx.logger.info(
      `dry run: ${changes} change(s) not written; pass dryRun=false to apply`,
    );
    return { dataHandles: [await record(false, false, [])] };
  }

  await nc.setHosts(g.domain, plan.after, current.emailType);
  const back = await nc.getHosts(g.domain);
  const problems = verify(plan.after, back.records);
  const handles = [
    await storeHosts(ctx, back),
    await record(true, !problems.length, problems),
  ];
  if (problems.length) {
    throw new Error(
      `setHosts succeeded but the records read back differ from the plan: ${
        problems.join("; ")
      }`,
    );
  }
  ctx.logger.info(
    `wrote and verified ${changes} change(s); ${back.records.length} records now`,
  );
  return { dataHandles: handles };
}

/**
 * Model type `@sntxrr/namecheap-dns`.
 *
 * @example
 * ```bash
 * swamp model create @sntxrr/namecheap-dns example-com \
 *   --global-arg domain=example.com ...
 * swamp model @sntxrr/namecheap-dns method run getHosts example-com
 * ```
 */
export const model = {
  type: "@sntxrr/namecheap-dns",
  description:
    "Read and safely edit one Namecheap domain's DNS host records: read-merge-write with read-back verification, dry run by default",
  version: "2026.10.26.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    hosts: {
      description: "The domain's host records as last read from Namecheap",
      schema: HostsSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    change: {
      description: "The last planned or applied change, with its verification",
      schema: ChangeSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
    getHosts: {
      description: "Read the domain's host records, email type and DNS mode",
      arguments: z.object({}),
      execute: async (args: Seams, ctx: Ctx) => {
        const h = await client(ctx.globalArgs, args._fetch).getHosts(
          ctx.globalArgs.domain,
        );
        ctx.logger.info(
          `${h.records.length} records; email ${h.emailType || "unset"}; ` +
            `Namecheap DNS ${h.usingNamecheapDns ? "yes" : "no"}`,
        );
        return { dataHandles: [await storeHosts(ctx, h)] };
      },
    },
    upsertRecords: {
      description:
        "Ensure records exist (CNAME, ALIAS and redirects replace the host's value); every other record is kept",
      arguments: z.object({
        records: z.array(UpsertInput).min(1),
        dryRun: z.boolean().default(true),
      }),
      execute: async (
        args:
          & { records: z.infer<typeof UpsertInput>[]; dryRun: boolean }
          & Seams,
        ctx: Ctx,
      ) => {
        const nc = client(ctx.globalArgs, args._fetch);
        const current = await nc.getHosts(ctx.globalArgs.domain);
        const plan = planUpsert(current.records, args.records);
        return await apply(
          ctx,
          "upsertRecords",
          args.dryRun,
          nc,
          current,
          plan,
        );
      },
    },
    removeRecords: {
      description:
        "Remove the named records (no address = every value of host + type); every other record is kept",
      arguments: z.object({
        records: z.array(RemoveInput).min(1),
        dryRun: z.boolean().default(true),
      }),
      execute: async (
        args:
          & { records: z.infer<typeof RemoveInput>[]; dryRun: boolean }
          & Seams,
        ctx: Ctx,
      ) => {
        const nc = client(ctx.globalArgs, args._fetch);
        const current = await nc.getHosts(ctx.globalArgs.domain);
        const plan = planRemove(current.records, args.records);
        return await apply(
          ctx,
          "removeRecords",
          args.dryRun,
          nc,
          current,
          plan,
        );
      },
    },
  },
};
