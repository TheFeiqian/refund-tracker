// Monitor tracked retailer threads for new replies.
//
// POST { threads: [{ account, threadId, orderId, retailer? }] }   (from the app — the threads it knows)
// POST/GET with no body                                            (cron — self-discovers tracked orders)
//
// For each thread we read the Gmail conversation, store any messages we haven't seen yet, and run the
// AI+KB analysis exactly ONCE per new inbound message (cost control — processed messages are skipped
// on every later run). Returns a summary the app uses to refresh + flag claims needing attention.
const {
  getToken, accessFromRefresh, gmailGet, parseGmailMessage,
  messageExists, saveMessage, updateMessage, listKb, listTrackedOrders,
  anthropicText, jsonFrom,
} = require('./_util');
 
function emailAddr(s) { const m = String(s || '').match(/<([^>]+)>/); return (m ? m[1] : String(s || '')).trim().toLowerCase(); }
 
// One AI call per new inbound message: extract the facts, match the knowledge base, draft a reply.
async function analyseMessage(msg, ctx, kb) {
  const kbCompact = (kb || []).slice(0, 40).map(k => ({ id: k.id, question: k.question, answer: k.approved_answer }));
  const system = 'You handle replies from online retailers to a customer chasing a return/refund. '
    + 'You will be given the retailer message, the claim context, and a KNOWLEDGE BASE of previously approved answers. '
    + 'First decide whether the retailer message matches a known scenario in the knowledge base. '
    + 'If it matches, base the suggested reply on that approved answer and set needs_human=false. '
    + 'If it does not match a known scenario (a new question, an unusual request, or anything you are unsure how to answer), '
    + 'set needs_human=true and describe what information is missing. '
    + 'Dates must be DD/MM/YYYY exactly as written in the message; never invent a date, reference or amount. '
    + 'Reply with ONLY a JSON object, no prose.';
  const userText = 'CLAIM CONTEXT: retailer=' + (ctx.store || 'unknown')
    + (ctx.method ? (', return method=' + ctx.method) : '')
    + (ctx.orderNo ? (', order number=' + ctx.orderNo) : '')
    + (ctx.name ? (', customer name=' + ctx.name) : '') + '.\n\n'
    + 'KNOWLEDGE BASE (approved answers):\n' + JSON.stringify(kbCompact) + '\n\n'
    + 'RETAILER MESSAGE:\n"""\n' + String(msg.body || msg.snippet || '').slice(0, 6000) + '\n"""\n\n'
    + 'Return ONLY this JSON: {'
    + '"outcome":"one of: refund_issued | refund_refused | return_approved | label_provided | investigation_opened | more_info_requested | acknowledged_no_decision | unclear",'
    + '"reference":"any case/return/RMA reference stated, else empty",'
    + '"deadline":"a date the retailer says they will respond/complete by, DD/MM/YYYY, else empty",'
    + '"refund_amount":"refund amount as a plain number if stated, else 0",'
    + '"refund_date":"date a refund was actually issued, DD/MM/YYYY, else empty",'
    + '"refusal_reason":"if refused, the stated reason in a few words, else empty",'
    + '"summary":"one plain-English sentence of what the retailer said",'
    + '"matched_kb_id":"the id of the matching knowledge-base scenario, or null",'
    + '"needs_human":true or false,'
    + '"missing_info":"if needs_human, what info is needed to answer, else empty",'
    + '"suggested_reply":"a complete draft reply to the retailer, signed off politely"'
    + '}.';
  try {
    const text = await anthropicText({ system, userText, maxTokens: 1200 });
    return jsonFrom(text) || {};
  } catch (e) {
    return { outcome: 'unclear', needs_human: true, missing_info: 'AI analysis failed: ' + (e.message || e), suggested_reply: '' };
  }
}
 
async function processThread(t, kb, out) {
  const { account, threadId, orderId } = t;
  if (!account || !threadId || !orderId) return;
  let access;
  try {
    const refresh = await getToken(account);
    if (!refresh) { out.errors.push('Account ' + account + ' is not connected.'); return; }
    access = await accessFromRefresh(refresh);
  } catch (e) { out.errors.push('Auth failed for ' + account + ': ' + (e.message || e)); return; }
 
  let thread;
  try { thread = await gmailGet(access, 'threads/' + encodeURIComponent(threadId) + '?format=full'); }
  catch (e) { out.errors.push('Read failed for thread ' + threadId + ': ' + (e.message || e)); return; }
 
  const acct = emailAddr(account);
  const msgs = (thread.messages || []);
  for (const gm of msgs) {
    const parsed = parseGmailMessage(gm);
    if (await messageExists(parsed.gmail_message_id)) continue; // already stored — never re-charge AI for it
    const fromAcct = emailAddr(parsed.from_addr) === acct;
    const direction = fromAcct ? 'out' : 'in';
    const row = {
      order_id: orderId,
      gmail_thread_id: parsed.gmail_thread_id,
      gmail_message_id: parsed.gmail_message_id,
      direction,
      from_addr: parsed.from_addr,
      to_addr: parsed.to_addr,
      subject: parsed.subject,
      snippet: parsed.snippet,
      body: parsed.body,
      internal_ts: parsed.internal_ts,
      rfc_message_id: parsed.rfc_message_id || '',
      rfc_references: parsed.rfc_references || '',
      ai_processed: direction === 'out',
      status: direction === 'out' ? 'replied' : 'new',
    };
    if (direction === 'in') {
      const analysis = await analyseMessage(parsed, t.ctx || {}, kb);
      row.ai_processed = true;
      row.ai_outcome = analysis.outcome || 'unclear';
      row.ai_extract = analysis;
      row.ai_suggestion = analysis.suggested_reply || '';
      row.status = analysis.needs_human ? 'troubleshoot' : 'suggested';
      out.newInbound++;
      out.attention.push({ orderId, threadId, outcome: row.ai_outcome, needs_human: !!analysis.needs_human, summary: analysis.summary || parsed.snippet });
    }
    try { await saveMessage(row); } catch (e) { out.errors.push('Save failed: ' + (e.message || e)); }
  }
  out.checked++;
}
 
// Find thread IDs in an account's mailbox matching a search query (newest first).
async function searchThreadIds(access, query) {
  const d = await gmailGet(access, 'messages?q=' + encodeURIComponent(query) + '&maxResults=25');
  const seen = [];
  (d.messages || []).forEach(m => { if (m.threadId && seen.indexOf(m.threadId) < 0) seen.push(m.threadId); });
  return seen;
}
 
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();
 
  let payload = req.body;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (e) { payload = {}; } }
  payload = payload || {};
 
  const out = { checked: 0, newInbound: 0, attention: [], errors: [] };
 
  // SEARCH mode: no thread linked yet — search the order's mailbox for the retailer conversation,
  // link the best-matching thread, and collect it. { search: {account, orderId, retailerEmail, orderNo, ctx} }
  if (payload.search) {
    const s = payload.search;
    try {
      if (!s.account || !s.orderId) return res.status(400).json({ error: 'account and orderId are required' });
      const kb = await listKb();
      const refresh = await getToken(s.account);
      if (!refresh) return res.status(400).json({ error: 'The account ' + s.account + ' is not connected. Connect it under Email accounts first.' });
      const access = await accessFromRefresh(refresh);
      // Retailer emails don't always contain the order number, so match by email first (with the order
      // number to disambiguate if it helps), then loosen: email alone, then order number alone.
      const emailClause = s.retailerEmail ? '(from:' + s.retailerEmail + ' OR to:' + s.retailerEmail + ')' : '';
      const numClause = s.orderNo ? '"' + String(s.orderNo).replace(/"/g, '') + '"' : '';
      const queries = [];
      if (emailClause && numClause) queries.push(emailClause + ' ' + numClause);
      if (emailClause) queries.push(emailClause);
      if (numClause) queries.push(numClause);
      if (!queries.length) return res.status(400).json({ error: 'Need a retailer email or order number to search for.' });
      let threadIds = [], usedQuery = '';
      for (const q of queries) { threadIds = await searchThreadIds(access, q); usedQuery = q; if (threadIds.length) break; }
      out.query = usedQuery;
      const chosen = threadIds.slice(0, 1); // link the most-recent matching thread
      for (const tid of chosen) { await processThread({ account: s.account, threadId: tid, orderId: s.orderId, ctx: s.ctx || {} }, kb, out); }
      out.linkedThreadId = chosen[0] || '';
      out.threadIds = threadIds;
      return res.status(200).json({ ok: true, ...out });
    } catch (e) {
      return res.status(502).json({ error: String((e && e.message) || e), ...out });
    }
  }
 
  try {
    const kb = await listKb();
    let threads = Array.isArray(payload.threads) ? payload.threads : null;
    if (!threads) {
      // cron / no-arg path: self-discover tracked orders from the DB.
      const tracked = await listTrackedOrders();
      threads = tracked.map(o => ({
        account: o.data.gmail_account,
        threadId: o.data.gmail_thread_id,
        orderId: o.order_id,
        ctx: { store: o.data.store, method: o.data.method, orderNo: o.data.store_order_number, name: o.data.delivery_name || o.data.person },
      }));
    }
    // Process sequentially to keep memory + Gmail rate use modest.
    for (const t of threads) { await processThread(t, kb, out); }
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e), ...out });
  }
};
 
