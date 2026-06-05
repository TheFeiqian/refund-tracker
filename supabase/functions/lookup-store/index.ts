// supabase/functions/lookup-store/index.ts
// Given a store name + website URL, uses Claude with web search to look up the
// retailer's UK returns/contact details and returns structured fields for the
// "Add store" form to pre-fill. Human reviews before saving.
//
// Deploy:  supabase functions deploy lookup-store
// Secret:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { name, website } = await req.json();
    if (!name && !website) return json({ error: "Provide a store name or website" }, 400);

    const target = [name && `name: ${name}`, website && `website: ${website}`].filter(Boolean).join(", ");

    const prompt =
      `Research the UK retailer (${target}) and find its returns and contact details. ` +
      `Use web search. Look at the retailer's own site (returns/help/contact pages) first. ` +
      `Then reply with ONLY a JSON object, no prose, no markdown:\n` +
      `{\n` +
      `  "website": string|null,            // canonical homepage URL\n` +
      `  "returns_portal": string|null,     // URL of the returns/refunds page\n` +
      `  "phone": string|null,              // UK customer-service phone\n` +
      `  "email": string|null,              // customer-service / returns email\n` +
      `  "live_chat": boolean,              // true if they offer live chat\n` +
      `  "parcel_shop_unwanted": boolean|null, // true if they provide a parcel-shop drop-off label for UNWANTED goods (free or paid)\n` +
      `  "parcel_shop_damaged": boolean|null,  // true if a parcel-shop label is provided for DAMAGED/faulty goods\n` +
      `  "offers_collection": boolean|null,    // true if they offer home courier collection (typically large/furniture)\n` +
      `  "category": string[],              // any of ["clothes","tech","large furniture items","home items"]\n` +
      `  "return_courier": one of ["DPD","Royal Mail","Parcelforce","Evri","DHL","FedEx",null], // courier used on their return labels if known\n` +
      `  "confidence": {"phone":"high|med|low","email":"high|med|low","returns_portal":"high|med|low","parcel_shop":"high|med|low"},\n` +
      `  "notes": string|null               // one short line, e.g. "60-day returns, £3 unwanted via Royal Mail"\n` +
      `}\n` +
      `Rules: Use null for anything you cannot verify. Do NOT guess a phone or email — only include if found on a credible source. ` +
      `For a small brand with no published phone/email, return null for those. ` +
      `parcel_shop_unwanted should be true for most large UK retailers offering free/paid drop-off returns.`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json();
    const text = (data.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    const clean = text.replace(/```json|```/g, "").trim();
    // pull the JSON object out even if the model wrapped it in stray text
    const m = clean.match(/\{[\s\S]*\}/);
    let parsed: unknown;
    try { parsed = JSON.parse(m ? m[0] : clean); } catch { parsed = { raw: text }; }
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
