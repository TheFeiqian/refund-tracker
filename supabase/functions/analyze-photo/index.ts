// supabase/functions/analyze-photo/index.ts
// Looks at a delivery photo and decides whether a person is visible.
// Drives the DNA branch (delivery_photo_shows_person -> yes/no).
//
// Deploy:  supabase functions deploy analyze-photo
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
    const { image_base64, media_type, storage_path, kind } = await req.json();
    let b64 = image_base64;
    let mt = media_type || "image/jpeg";
    const checkKind = kind === "damage" ? "damage" : "delivery";

    if (!b64 && storage_path) {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      const { data, error } = await supabase.storage.from("labels").download(storage_path);
      if (error) throw error;
      const buf = new Uint8Array(await data.arrayBuffer());
      let bin = ""; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      b64 = btoa(bin); mt = data.type || mt;
    }
    if (!b64) return json({ error: "Provide image_base64 or storage_path" }, 400);

    const prompt = checkKind === "damage"
      ? ("This is a photo of a returned product the customer says is damaged. Decide if visible damage is present. " +
         'Reply with ONLY JSON: {"damage_visible": "yes"|"no", "confidence": 0..1, "note": short description of the damage or why none is visible}.')
      : ("This is a parcel delivery photo. Decide if a PERSON (e.g. the recipient or anyone receiving the parcel) " +
         "is visible in the image. Reply with ONLY JSON: " +
         '{"shows_person": "yes"|"no", "confidence": 0..1, "note": short string}.');

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 200,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mt, data: b64 } },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });
    const data = await r.json();
    const text = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const clean = text.replace(/```json|```/g, "").trim();
    let parsed: any;
    try { parsed = JSON.parse(clean); } catch { parsed = { raw: text }; }
    return json({ ok: true, kind: checkKind, ...(parsed && typeof parsed === "object" ? parsed : {}) });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
}
