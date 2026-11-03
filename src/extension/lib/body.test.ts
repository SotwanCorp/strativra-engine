import { test } from "node:test";
import assert from "node:assert/strict";
import { BODY_CAP, bodyToString, capUtf8, concatChunks } from "./body.ts";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

test("all raw chunks are concatenated in order, file chunks skipped", () => {
  const body = bodyToString({ raw: [{ bytes: enc("en=page_view&") }, { file: "/tmp/x" }, { bytes: enc("tid=G-TEST\n") }, { bytes: enc("en=scroll") }] });
  assert.equal(body, "en=page_view&tid=G-TEST\nen=scroll");
});

test("a chunk split inside a multibyte character is joined correctly", () => {
  const all = new TextEncoder().encode("ep.item=café");
  const cut = all.length - 1; // inside the 2-byte é
  const body = bodyToString({ raw: [{ bytes: all.slice(0, cut).buffer as ArrayBuffer }, { bytes: all.slice(cut).buffer as ArrayBuffer }] });
  assert.equal(body, "ep.item=café");
});

test("ArrayBufferView chunks work too", () => {
  const u8 = new TextEncoder().encode("xx-hello-xx");
  assert.equal(bodyToString({ raw: [{ bytes: u8.subarray(3, 8) }] }), "hello");
});

test("parsed form data becomes a urlencoded string", () => {
  assert.equal(bodyToString({ formData: { id: ["123"], ev: ["Lead"], "cd[value]": ["10"], multi: ["a", "b"] } }), "id=123&ev=Lead&cd%5Bvalue%5D=10&multi=a&multi=b");
});

test("nothing readable gives undefined", () => {
  assert.equal(bodyToString(undefined), undefined);
  assert.equal(bodyToString({}), undefined);
  assert.equal(bodyToString({ raw: [{ file: "/x" }] }), undefined);
  assert.equal(bodyToString({ error: "Unknown error." }), undefined);
});

test("bodies are capped at 64 KB of UTF-8, cut on a character boundary", () => {
  const big = "é".repeat(BODY_CAP); // 2 bytes each
  const out = bodyToString({ raw: [{ bytes: enc(big.slice(0, BODY_CAP / 2)) }, { bytes: enc(big.slice(BODY_CAP / 2)) }] })!;
  assert.ok(new TextEncoder().encode(out).byteLength <= BODY_CAP);
  assert.ok(new TextEncoder().encode(out).byteLength > BODY_CAP - 4);
  assert.ok(!out.includes("�"));
  const ascii = bodyToString({ raw: [{ bytes: enc("a".repeat(BODY_CAP + 500)) }] })!;
  assert.equal(ascii.length, BODY_CAP);
});

test("capUtf8 never splits a surrogate pair", () => {
  const s = "ab" + "😀".repeat(10);
  const out = capUtf8(s, 7); // "ab" (2) + one emoji (4) = 6, the next would make 10
  assert.equal(out, "ab😀");
  assert.equal(capUtf8("short", 100), "short");
});

test("concatChunks stops at the limit", () => {
  const out = concatChunks([{ bytes: enc("12345") }, { bytes: enc("67890") }], 7);
  assert.equal(new TextDecoder().decode(out), "1234567");
});
