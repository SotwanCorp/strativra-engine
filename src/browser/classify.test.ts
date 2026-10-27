import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreForm, formToConversion, type FormFeatures } from "./classify.ts";

function f(over: Partial<FormFeatures>): FormFeatures {
  return {
    selector: "form", isFormElement: true, action: "", method: "post",
    fields: 0, textInputs: 0, nameInputs: 0, emailInputs: 0, telInputs: 0, passwordInputs: 0,
    searchInputs: 0, textareas: 0, selects: 0, checkboxes: 0, fileInputs: 0,
    autocomplete: [], names: [], descriptors: [], roleSearch: false, inFooter: false,
    text: "", classes: "", buttons: [],
    ...over,
  };
}

test("login: password + current-password", () => {
  const r = scoreForm(f({ fields: 2, textInputs: 1, passwordInputs: 1, autocomplete: ["username", "current-password"], text: "log in" }));
  assert.equal(r.kind, "login");
  assert.ok(r.confidence > 0.6);
  assert.equal(formToConversion(r.kind, r.confidence), null);
});

test("signup: email + new-password + create account wording", () => {
  const r = scoreForm(f({ isFormElement: false, fields: 2, emailInputs: 1, passwordInputs: 1, autocomplete: ["email", "new-password"], text: "create account" }));
  assert.equal(r.kind, "signup");
  assert.equal(formToConversion(r.kind, r.confidence)?.type, "signup");
});

test("search: role=search with type=search", () => {
  const r = scoreForm(f({ fields: 1, searchInputs: 1, roleSearch: true, names: ["s"], text: "search" }));
  assert.equal(r.kind, "search");
  assert.equal(formToConversion(r.kind, r.confidence), null);
});

test("search: single q input without type=search", () => {
  const r = scoreForm(f({ fields: 1, textInputs: 1, names: ["q"], text: "go" }));
  assert.equal(r.kind, "search");
});

test("newsletter: single email in footer -> low-confidence lead", () => {
  const r = scoreForm(f({ fields: 1, emailInputs: 1, inFooter: true, text: "newsletter subscribe" }));
  assert.equal(r.kind, "newsletter");
  const c = formToConversion(r.kind, r.confidence);
  assert.equal(c?.type, "lead");
  assert.ok(c!.confidence < 0.4, `newsletter lead confidence should be low, got ${c!.confidence}`);
});

test("contact: name + email + phone + textarea", () => {
  const r = scoreForm(f({ fields: 4, textInputs: 1, nameInputs: 1, emailInputs: 1, telInputs: 1, textareas: 1, text: "contact us send message" }));
  assert.equal(r.kind, "contact");
  assert.ok(r.confidence > 0.7);
  assert.equal(formToConversion(r.kind, r.confidence)?.type, "lead");
});

test("contact: quote request in French (devis)", () => {
  const r = scoreForm(f({ fields: 3, textInputs: 2, nameInputs: 1, emailInputs: 1, text: "demander un devis" }));
  assert.equal(r.kind, "contact");
});

test("checkout: cc-number + shipping address", () => {
  const r = scoreForm(f({ fields: 4, textInputs: 3, emailInputs: 1, autocomplete: ["email", "shipping address-line1", "shipping postal-code", "cc-number"], text: "checkout place order" }));
  assert.equal(r.kind, "checkout");
  assert.equal(formToConversion(r.kind, r.confidence), null);
});

test("unknown: a lone select", () => {
  const r = scoreForm(f({ fields: 1, selects: 1, text: "language" }));
  assert.equal(r.kind, "unknown");
  assert.equal(r.confidence, 0);
});
