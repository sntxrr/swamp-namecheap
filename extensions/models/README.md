# @sntxrr/namecheap-dns

Read and safely edit the DNS host records of one Namecheap domain.

Namecheap's `domains.dns.setHosts` call **replaces every host record** on the
domain with exactly the set it is sent. A client that sends only the records it
cares about deletes all the others. This model never does that:

1. read the current records, email type and DNS mode;
2. merge only the records you named;
3. write the complete set, keeping the email type that was read;
4. read it back and fail loudly if anything differs from the plan.

Every write method is a **dry run unless `dryRun: false`**. The dry run prints
and stores the exact plan (`+` added, `~` updated, `-` removed).

## Requirements

- API access enabled for the account (Profile → Tools → Namecheap API Access).
  Namecheap only offers it to accounts that meet its balance, spend or domain
  count bar.
- The public **IPv4** address the calls come from on the API whitelist. Pass it
  as `clientIp`.
- The domain using Namecheap DNS (BasicDNS or PremiumDNS). Writes are refused
  otherwise, because the records would have no effect.

## Global arguments

| argument   | notes                                                   |
| ---------- | ------------------------------------------------------- |
| `domain`   | the registered domain, e.g. `example.com`               |
| `apiUser`  | the API user (your account user name)                   |
| `apiKey`   | sensitive; read it from a vault                         |
| `userName` | the account to act on; defaults to `apiUser`            |
| `clientIp` | public IPv4 on the whitelist                            |
| `sandbox`  | `true` for `api.sandbox.namecheap.com` (its own account) |

## Methods

| method          | does                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| `getHosts`      | reads the records into the `hosts` resource                                                            |
| `upsertRecords` | ensures each record exists; CNAME, ALIAS and URL/URL301/FRAME replace the host's value; others are kept |
| `removeRecords` | removes the named records; no `address` removes every value of that host + type                        |

Both write methods store a `change` resource with the plan, whether it was
written and whether the read-back matched.

Safety rules, enforced before anything is sent:

- A CNAME may not share a host with any other record.
- A URL redirect may not share a host with A/AAAA/ALIAS records. Namecheap
  serves redirects from its own address, so both would answer.
- MX records need the domain's Mail Settings set to Custom MX.
- A domain holding a record type this model can't write back unchanged (CAA,
  for one) is never rewritten.
- The model never writes an empty record set.
- The API key goes only in a POST body. It never appears in a URL or an error.

## Example: point a parked domain at GitHub Pages

```yaml
# models/@sntxrr/namecheap-dns/example-club.yaml
type: "@sntxrr/namecheap-dns"
name: example-club
globalArguments:
  domain: example.club
  apiUser: myuser
  apiKey: ${{ vault.get(my-vault, namecheap-api/credential) }}
  clientIp: 203.0.113.7
```

Verify the domain with GitHub before it points at Pages. Otherwise any repo can
claim it in the meantime:

```bash
swamp model method run example-club upsertRecords \
  --input records='[{"host":"_github-pages-challenge-me","type":"TXT","address":"<code>"}]'
# review the plan, then add --input dryRun=false
```

Once GitHub confirms the domain, remove the parking redirect, then add the
Pages records:

```bash
swamp model method run example-club removeRecords \
  --input records='[{"host":"@","type":"URL"}]' --input dryRun=false
swamp model method run example-club upsertRecords --input-file pages.yaml
```

## License

MIT. See `LICENSE.md`.
