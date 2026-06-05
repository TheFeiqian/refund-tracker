// scripts/import-demo-data.mjs
// One-time seed of your Supabase project with the 67 orders + 56 stores.
// Any file embedded in an order as a base64 data URL (e.g. the DoorJammerUK
// confirmation) is uploaded into the 'labels' Storage bucket and replaced with a
// reference, so nothing huge ends up living in the database.
//
// Usage:
//   npm i @supabase/supabase-js
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/import-demo-data.mjs
//
// Get the service_role key from: Supabase dashboard -> Project Settings -> API.
// (Service role bypasses RLS — only run this locally, never ship it in the browser.)

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }

const supabase = createClient(URL, KEY, { auth: { persistSession: false } });

const orders = JSON.parse(readFileSync(join(__dir, "../data/orders.json"), "utf8"));
const stores = JSON.parse(readFileSync(join(__dir, "../data/stores.json"), "utf8"));

const FILE_FIELDS = ["order_confirmation", "return_label_pdf", "proof_of_postage", "delivery_photo", "damage_photo", "collection_handover", "invoice"];

function dataUrlToBytes(dataUrl) {
  const [meta, b64] = dataUrl.split(",");
  const type = (meta.match(/data:([^;]+)/) || [])[1] || "application/octet-stream";
  return { bytes: Buffer.from(b64, "base64"), type };
}

async function run() {
  // 1) Stores
  console.log(`Seeding ${stores.length} stores...`);
  for (const s of stores) {
    const { error } = await supabase.from("stores").upsert(s, { onConflict: "name" });
    if (error) console.error("store", s.name, error.message);
  }

  // 2) Orders (+ lift embedded files into Storage)
  console.log(`Seeding ${orders.length} orders...`);
  for (const o of orders) {
    const fileRows = [];
    for (const f of FILE_FIELDS) {
      const dataUrl = o[`${f}_file`];
      if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) {
        const { bytes, type } = dataUrlToBytes(dataUrl);
        const ext = type.includes("pdf") ? "pdf" : (type.split("/")[1] || "bin");
        const path = `${o.order_id}/${f}.${ext}`;
        const up = await supabase.storage.from("labels").upload(path, bytes, { contentType: type, upsert: true });
        if (up.error) { console.error("upload", path, up.error.message); continue; }
        fileRows.push({ order_id: o.order_id, field: f, storage_path: path, filename: o[`${f}_filename`] || `${f}.${ext}`, filetype: type, size: bytes.length });
        // replace the heavy data URL with a lightweight reference inside the order
        o[`${f}_file`] = `storage:${path}`;
      }
    }
    const { error } = await supabase.from("orders").upsert({ order_id: o.order_id, data: o }, { onConflict: "order_id" });
    if (error) { console.error("order", o.order_id, error.message); continue; }
    if (fileRows.length) {
      const fr = await supabase.from("files").upsert(fileRows, { onConflict: "id" });
      if (fr.error) console.error("files", o.order_id, fr.error.message);
    }
  }
  console.log("Done. Orders and stores are in your Supabase project.");
}
run().catch((e) => { console.error(e); process.exit(1); });
