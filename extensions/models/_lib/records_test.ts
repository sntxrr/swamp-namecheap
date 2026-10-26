// extensions/models/_lib/records_test.ts
import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.19";
import {
  assertWritable,
  type HostRecord,
  planRemove,
  planUpsert,
  verify,
} from "./records.ts";

// A fresh Namecheap domain: parking CNAME on www, redirect on the apex.
const PARKED: HostRecord[] = [
  {
    host: "www",
    type: "CNAME",
    address: "parkingpage.namecheap.com.",
    ttl: 1800,
  },
  { host: "@", type: "URL", address: "http://www.example.club/", ttl: 1800 },
];

Deno.test("upsert adds a TXT and keeps every other record", () => {
  const p = planUpsert(PARKED, [
    { host: "_github-pages-challenge-me", type: "TXT", address: "abc123" },
  ]);
  assertEquals(p.added.length, 1);
  assertEquals(p.removed, []);
  assertEquals(p.unchanged.length, 2);
  assertEquals(p.after.length, 3);
});

Deno.test("upsert is idempotent", () => {
  const once = planUpsert(PARKED, [{ host: "x", type: "TXT", address: "v" }]);
  const twice = planUpsert(once.after, [{
    host: "x",
    type: "TXT",
    address: "v",
  }]);
  assertEquals(twice.added, []);
  assertEquals(twice.updated, []);
  assertEquals(twice.removed, []);
});

Deno.test("CNAME upsert replaces the host's value, ignoring case and trailing dot", () => {
  const p = planUpsert(PARKED, [
    { host: "WWW", type: "cname", address: "me.github.io." },
  ]);
  assertEquals(p.added.map((r) => r.address), ["me.github.io."]);
  assertEquals(p.removed.map((r) => r.address), ["parkingpage.namecheap.com."]);
  const same = planUpsert(
    [{ host: "www", type: "CNAME", address: "Me.GitHub.io", ttl: 1800 }],
    [{ host: "www", type: "CNAME", address: "me.github.io." }],
  );
  assertEquals(
    same.added.length + same.updated.length + same.removed.length,
    0,
  );
});

Deno.test("A records accumulate; a changed ttl is an update", () => {
  const p = planUpsert([], [
    { host: "@", type: "A", address: "185.199.108.153" },
    { host: "@", type: "A", address: "185.199.109.153" },
  ]);
  assertEquals(p.after.length, 2);
  const q = planUpsert(p.after, [
    { host: "@", type: "A", address: "185.199.108.153", ttl: 300 },
  ]);
  assertEquals(q.updated.length, 1);
  assertEquals(q.updated[0].to.ttl, 300);
  assertEquals(q.after.length, 2);
});

Deno.test("an apex A next to the parking redirect is refused", () => {
  assertThrows(
    () =>
      planUpsert(PARKED, [{
        host: "@",
        type: "A",
        address: "185.199.108.153",
      }]),
    Error,
    "remove the redirect first",
  );
});

Deno.test("a CNAME beside another type is refused", () => {
  assertThrows(
    () => planUpsert(PARKED, [{ host: "www", type: "TXT", address: "x" }]),
    Error,
    "CNAME cannot share a host",
  );
});

Deno.test("invalid input is refused before anything is planned", () => {
  for (
    const bad of [
      { host: "@", type: "A", address: "2606:50c0:8000::153" },
      { host: "@", type: "AAAA", address: "185.199.108.153" },
      { host: "bad host", type: "TXT", address: "x" },
      { host: "@", type: "CAA", address: '0 issue "x"' },
      { host: "@", type: "TXT", address: " " },
      { host: "@", type: "TXT", address: "x", ttl: 5 },
    ]
  ) {
    assertThrows(() => planUpsert([], [bad]), Error);
  }
  assertThrows(
    () =>
      planUpsert([], [{ host: "a", type: "CNAME", address: "x" }, {
        host: "a",
        type: "CNAME",
        address: "y",
      }]),
    Error,
    "given twice",
  );
});

Deno.test("remove by host + type, or by exact value; absent is a no-op", () => {
  const set = planUpsert([], [
    { host: "@", type: "A", address: "1.1.1.1" },
    { host: "@", type: "A", address: "2.2.2.2" },
    { host: "t", type: "TXT", address: "keep" },
  ]).after;
  assertEquals(
    planRemove(set, [{ host: "@", type: "A", address: "1.1.1.1" }]).after
      .length,
    2,
  );
  assertEquals(planRemove(set, [{ host: "@", type: "a" }]).after.length, 1);
  const none = planRemove(set, [{ host: "nope", type: "TXT" }]);
  assertEquals(none.removed, []);
  assertEquals(none.after.length, 3);
});

Deno.test("verify catches extra, missing and changed records", () => {
  const planned =
    planUpsert([], [{ host: "a", type: "TXT", address: "1" }]).after;
  assertEquals(verify(planned, planned), []);
  assertEquals(verify(planned, []).length, 1);
  assertEquals(verify([], planned).length, 1);
  assertEquals(verify(planned, [{ ...planned[0], ttl: 60 }]).length, 1);
});

Deno.test("a domain with a type it cannot write back is refused", () => {
  assertThrows(
    () =>
      assertWritable([{
        host: "@",
        type: "CAA",
        address: '0 issue "x"',
        ttl: 1800,
      }]),
    Error,
    "CAA",
  );
});
