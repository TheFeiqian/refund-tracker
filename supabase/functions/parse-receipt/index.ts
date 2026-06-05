// supabase/functions/parse-receipt/index.ts
// Reads an uploaded proof-of-postage receipt or return-label image and extracts
// structured fields (tracking number, courier, postage date, posted-from).
// Called from the app when a file is attached to those fields.
//
// Deploy:  supabase functions deploy parse-receipt
// Secret:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // Accept either a base64 image directly, or a storage path to fetch.
    const { image_base64, media_type, storage_path } = await req.json();

    let b64 = image_base64;
    let mt = media_type || "image/jpeg";

    if (!b64 && storage_path) {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      const { data, error } = await supabase.storage.from("labels").download(storage_path);
      if (error) throw error;
      const buf = new Uint8Array(await data.arrayBuffer());
      // base64-encode
      let bin = "";
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      b64 = btoa(bin);
      mt = data.type || mt;
    }
    if (!b64) return json({ error: "Provide image_base64 or storage_path" }, 400);

    // PDFs use the document block; images use the image block.
    const isPdf = mt === "application/pdf";
    const sourceBlock = isPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
      : { type: "image", source: { type: "base64", media_type: mt, data: b64 } };

    const prompt =
      "You are reading a parcel proof-of-postage receipt or a courier return label. " +
      "Extract these fields and reply with ONLY a JSON object, no prose: " +
      '{"tracking_number": string|null, "courier": one of ["DPD","Royal Mail","Parcelforce","Evri","DHL","FedEx",null], ' +
      '"postage_date": "DD/MM/YYYY"|null, "posted_from": string|null}. ' +
      "If a field is not visible, use null.";

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 400,
        messages: [{ role: "user", content: [sourceBlock, { type: "text", text: prompt }] }],
      }),
    });
    const data = await r.json();
    const text = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const clean = text.replace(/```json|```/g, "").trim();
    let parsed: unknown;
    try { parsed = JSON.parse(clean); } catch { parsed = { raw: text }; }
    return json({ ok: true, fields: parsed });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}
